/**
 * 上行（输入 → hubd → 回执）在前端的决策：回执到了怎么办、恢复进程时带什么。
 * 只算结果，不发送也不改状态：发送和改状态由 `store.ts` 做（输入只走它的 `input()`）。
 */
import type { AckError } from "./generated/AckError.ts";
import { ackReason, type PendingChoice, type UserState } from "./model.ts";

/** 回执结果：hubd 说的原因；`send` 是消息根本没发到 hubd（连接层报错，`input()` 已经在顶部提示过）。 */
export type AckResult = AckError | "send";

/** 普通输入没写进去时顶部的提示：卡住、不合法要说；进程不在由各自的流程处理，连接层错误已经提示过。 */
export function inputNotice(error: AckResult | null): string | undefined {
  return error === "stalled" || error === "invalid" ? ackReason(error) : undefined;
}

/** 控制消息失败时顶部的提示：“<label>失败：原因”。 */
export function controlNotice(label: string, error: AckResult | null): string | undefined {
  return error && error !== "send" ? `${label}失败：${ackReason(error)}` : undefined;
}

/**
 * 用户消息的回执：
 * - `delivered`：写进了 FIFO，显示“已送达”（只改发送中的）。
 * - `ignore`：已经标过失败（启动失败的 `error` 事件），不再动。
 * - `retry`：进程不在，恢复进程后用同一个 id 重发。只重发一次。
 * - `fail`：标失败；`reason` 显示在消息旁边，`notice` 显示在顶部。
 */
export type UserAck = { kind: "delivered" } | { kind: "ignore" } | { kind: "retry" } | { kind: "fail"; reason?: string; notice?: string };

export function userAck(error: AckResult | null, state: UserState | undefined, retried: boolean): UserAck {
  if (!error) return { kind: "delivered" };
  if (state === "failed") return { kind: "ignore" };
  if (error === "not_running" && !retried && state === "sending") return { kind: "retry" };
  if (error === "send") return { kind: "fail" };
  return { kind: "fail", reason: ackReason(error), notice: inputNotice(error) };
}

/**
 * 切换模型、设置强度的回执：
 * - `pending`：进程不在，写进 FIFO 的会丢，记成待定，恢复进程时带上。
 * - `rejected`：没写进去，切换模型要退回原来的模型；`notice` 显示在顶部。
 */
export type ChoiceAck = { kind: "ok" } | { kind: "pending" } | { kind: "rejected"; notice?: string };

export function choiceAck(label: string, error: AckResult | null): ChoiceAck {
  if (!error) return { kind: "ok" };
  if (error === "not_running") return { kind: "pending" };
  return { kind: "rejected", notice: controlNotice(label, error) };
}

/**
 * 回复卡片的回执：
 * - `expired`：进程已不在，这张卡片没人能收到回复了，不能重试。
 * - `unlock`：没写进去，卡片解锁并写上原因，可以再点。
 */
export type ReplyAck = { kind: "ok" } | { kind: "expired" } | { kind: "unlock"; error: string };

export function replyAck(error: AckResult | null): ReplyAck {
  if (!error) return { kind: "ok" };
  if (error === "not_running") return { kind: "expired" };
  return { kind: "unlock", error: error === "send" ? "没有发出，可以再试一次" : ackReason(error) };
}

/** 新会话页选“默认”就不带 `--model`，让 CLI 自己选。 */
export const startModel = (model?: string): string | undefined => (model && model !== "default" ? model : undefined);

/**
 * 恢复进程（`--resume`）时带什么：进程不在时选的模型放进 `--model`，第一轮就生效；强度只在进程的
 * flag 设置层里，恢复后回到默认，所以每次都要重发——待定的优先，否则用界面上当前的；`null`（恢复默认）不用发。
 */
export function resumeChoice(pending: PendingChoice | undefined, effort: string | undefined): { model?: string; effort?: string } {
  const chosen = pending?.effort !== undefined ? pending.effort : effort;
  return { model: startModel(pending?.model), effort: chosen ?? undefined };
}
