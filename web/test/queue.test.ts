// 运行中发的消息：插入（已写给 CLI，等回传）和等结束（留在本地）。运行：node --test web/test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { apply, newThread } from "../src/model.ts";
import { afterTurn, confirmInserted, joinQueued, type Queued } from "../src/queue.ts";

const user = (uuid: string, text: string) => JSON.stringify({ type: "user", uuid, isReplay: true, message: { role: "user", content: text } });
const result = (subtype = "success") => JSON.stringify({ type: "result", subtype, is_error: subtype !== "success", duration_ms: 10 });

test("插入的消息收到同一 uuid 的回传后移出队列，等结束的不动", () => {
  const thread = newThread();
  apply(thread, user("u0", "开始"));
  const queue: Queued[] = [
    { id: "i1", text: "顺便看下日志", mode: "insert" },
    { id: "w1", text: "然后提交", mode: "wait" },
  ];
  assert.equal(confirmInserted(queue, thread), queue, "没有回传时原样返回");
  apply(thread, user("i1", "顺便看下日志"));
  assert.deepEqual(confirmInserted(queue, thread), [{ id: "w1", text: "然后提交", mode: "wait" }]);
});

test("一轮正常结束后发出等结束的消息；被中断时放回输入框", () => {
  const thread = newThread();
  apply(thread, user("u0", "开始"));
  const queue: Queued[] = [{ id: "w1", text: "a", mode: "wait" }];
  assert.equal(afterTurn(queue, thread, false), null, "还在运行");
  apply(thread, result());
  assert.equal(afterTurn(queue, thread, false), "flush");
  assert.equal(afterTurn(queue, thread, true), "restore");
  assert.equal(afterTurn([], thread, false), null);
});

test("还有插入的消息没回传时不发等结束的", () => {
  const thread = newThread();
  apply(thread, user("u0", "开始"));
  apply(thread, result());
  assert.equal(afterTurn([{ id: "i1", text: "x", mode: "insert" }, { id: "w1", text: "a", mode: "wait" }], thread, false), null);
});

test("有卡片等人决定时不算结束", () => {
  const thread = newThread();
  apply(thread, user("u0", "开始"));
  apply(thread, JSON.stringify({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" }, tool_use_id: "t1" } }));
  thread.phase = "idle";
  assert.equal(afterTurn([{ id: "w1", text: "a", mode: "wait" }], thread, false), null);
});

test("几条等结束的消息合成一条，空行分隔", () => {
  assert.equal(joinQueued([{ id: "1", text: "a", mode: "wait" }, { id: "2", text: "b\n", mode: "wait" }]), "a\n\nb");
});
