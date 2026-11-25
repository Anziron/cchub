// 上行决策的表格测试：回执 × 当前状态 → 动作。每行后面注明它守着的修复或规矩。
import assert from "node:assert/strict";
import { test } from "node:test";
import { ackReason } from "../src/model.ts";
import { choiceAck, controlNotice, inputNotice, replyAck, resumeChoice, startModel, userAck } from "../src/uplink.ts";
import { settleInsert, type Queued } from "../src/queue.ts";

test("用户消息的回执", () => {
  const rows = [
    // 回执, 消息状态, 是否已重发 → 动作
    [null, "sending", false, { kind: "delivered" }], // 写进 FIFO 显示“已送达”（1cd7d5d）
    ["not_running", "sending", false, { kind: "retry" }], // 进程被回收：恢复后同一 id 重发（1cd7d5d）
    ["not_running", "sending", true, { kind: "fail", reason: ackReason("not_running"), notice: undefined }], // 只重发一次
    ["not_running", "failed", false, { kind: "ignore" }], // 启动失败的 error 事件已标失败，不再重试（74dadba）
    ["stalled", "failed", false, { kind: "ignore" }],
    ["stalled", "sending", false, { kind: "fail", reason: ackReason("stalled"), notice: ackReason("stalled") }], // 进程卡住：顶部也提示
    ["invalid", "sending", false, { kind: "fail", reason: ackReason("invalid"), notice: ackReason("invalid") }],
    ["send", "sending", false, { kind: "fail" }], // 没发到 hubd：连接层的错误 input() 已提示，消息旁不写原因
  ] as const;
  for (const [error, state, retried, expected] of rows) {
    assert.deepEqual(userAck(error, state, retried), expected, `${error} × ${state} × ${retried}`);
  }
});

test("切换模型、设置强度的回执", () => {
  assert.deepEqual(choiceAck("切换模型", null), { kind: "ok" });
  // 进程不在：写进 FIFO 的会丢，记成待定，恢复时带上（986d784）
  assert.deepEqual(choiceAck("切换模型", "not_running"), { kind: "pending" });
  // 被拒：切换模型退回原模型；顶部提示（1cd7d5d）
  assert.deepEqual(choiceAck("切换模型", "invalid"), { kind: "rejected", notice: `切换模型失败：${ackReason("invalid")}` });
  assert.deepEqual(choiceAck("设置推理强度", "stalled"), { kind: "rejected", notice: `设置推理强度失败：${ackReason("stalled")}` });
  assert.deepEqual(choiceAck("切换模型", "send"), { kind: "rejected", notice: undefined });
});

test("回复卡片的回执", () => {
  assert.deepEqual(replyAck(null), { kind: "ok" });
  // 进程已不在：卡片失效，不能重试（1cd7d5d）
  assert.deepEqual(replyAck("not_running"), { kind: "expired" });
  // 卡住 / 不合法：解锁并写上原因，可以再点
  assert.deepEqual(replyAck("stalled"), { kind: "unlock", error: ackReason("stalled") });
  assert.deepEqual(replyAck("invalid"), { kind: "unlock", error: ackReason("invalid") });
  assert.deepEqual(replyAck("send"), { kind: "unlock", error: "没有发出，可以再试一次" });
});

test("顶部提示：普通输入只提卡住和不合法，控制消息带上动作名，连接层错误都不重复提示", () => {
  assert.equal(inputNotice(null), undefined);
  assert.equal(inputNotice("not_running"), undefined);
  assert.equal(inputNotice("send"), undefined);
  assert.equal(inputNotice("stalled"), ackReason("stalled"));
  assert.equal(controlNotice("中断", null), undefined);
  assert.equal(controlNotice("中断", "send"), undefined);
  assert.equal(controlNotice("中断", "not_running"), `中断失败：${ackReason("not_running")}`);
});

test("插入消息的回执：写进去标已送达，没写进去转成等结束", () => {
  const queue: Queued[] = [
    { id: "a", text: "一", mode: "insert" },
    { id: "b", text: "二", mode: "wait" },
  ];
  assert.deepEqual(settleInsert(queue, "a", true)[0], { id: "a", text: "一", mode: "insert", delivered: true });
  assert.deepEqual(settleInsert(queue, "a", false)[0], { id: "a", text: "一", mode: "wait" });
  assert.equal(settleInsert(queue, "a", true)[1], queue[1], "别的不动");
});

test("恢复进程时带什么：待定的模型放进 --model，强度待定的优先、否则重发当前的", () => {
  // 986d784：进程不在时选的模型和强度恢复时带上
  assert.deepEqual(resumeChoice({ model: "opus", effort: "high" }, "low"), { model: "opus", effort: "high" });
  // 强度只在进程里有效，恢复后要重发当前的
  assert.deepEqual(resumeChoice(undefined, "low"), { model: undefined, effort: "low" });
  // 待定的是“恢复默认”：不发
  assert.deepEqual(resumeChoice({ effort: null }, "low"), { model: undefined, effort: undefined });
  // 选“默认”不带 --model
  assert.deepEqual(resumeChoice({ model: "default" }, undefined), { model: undefined, effort: undefined });
  assert.equal(startModel("default"), undefined);
  assert.equal(startModel("sonnet"), "sonnet");
});
