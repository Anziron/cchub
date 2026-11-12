/**
 * 一轮进行中发的消息，挂在输入框上方。
 * - 插入：马上写给 CLI，CLI 在下一个工具结果之后把它插进这一轮，回传同一个 `uuid`。回传之前可以撤回
 *   （`cancel_async_message`），CLI 已经接进去时回复来不及，只能等回传。
 * - 等结束：留在桌面端，可以改（放回输入框）或删，这一轮正常结束后合成一条发出；被中断时放回输入框。
 * 只存在内存里：关掉窗口后不会在别的时机突然发出去。
 */
import type { Thread } from "./model";

// 不从 model 导入函数：测试直接用 node 跑，被测模块之间只能有类型依赖。
const waitingAsk = (thread: Thread) => [...thread.asks.values()].some((ask) => !ask.sent);
const sending = (thread: Thread) => thread.items.some((item) => item.kind === "user" && item.state === "sending");

export interface Queued {
  id: string;
  text: string;
  mode: "insert" | "wait";
  /** 插入的消息：已发出撤回请求，等 CLI 回复。 */
  cancelling?: boolean;
  /** 插入的消息：撤回时 CLI 说已经交给模型了，等回传后移出。 */
  late?: boolean;
}

/** 撤回请求有了回复：撤回成功就移出队列，来不及就标成 `late`。 */
export function settleCancel(queue: Queued[], id: string, cancelled: boolean): Queued[] {
  if (cancelled) return queue.filter((q) => q.id !== id);
  return queue.map((q) => (q.id === id ? { id: q.id, text: q.text, mode: q.mode, late: true } : q));
}

/** 回传已到的插入消息移出队列；没有变化时返回原数组。 */
export function confirmInserted(queue: Queued[], thread: Thread): Queued[] {
  if (!queue.some((q) => q.mode === "insert")) return queue;
  const seen = new Set<string>();
  for (const item of thread.items) if (item.kind === "user") seen.add(item.id);
  const next = queue.filter((q) => q.mode !== "insert" || !seen.has(q.id));
  return next.length === queue.length ? queue : next;
}

/** 一轮结束后对等结束的消息做什么：发出、放回输入框，或者继续等。 */
export function afterTurn(queue: Queued[], thread: Thread, interrupted: boolean): "flush" | "restore" | null {
  if (!queue.some((q) => q.mode === "wait") || queue.some((q) => q.mode === "insert")) return null;
  if (thread.phase !== "idle" || waitingAsk(thread) || sending(thread)) return null;
  return interrupted ? "restore" : "flush";
}

export const joinQueued = (queue: Queued[]): string =>
  queue.map((q) => q.text.trim()).filter(Boolean).join("\n\n");
