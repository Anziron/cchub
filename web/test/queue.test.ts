// 运行中发的消息：插入（已写给 CLI，等回传）和等结束（留在本地）。运行：node --test web/test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { apply, cancelInsertLine, newThread, parseCancelled } from "../src/model.ts";
import { afterTurn, confirmInserted, joinQueued, settleCancel, type Queued } from "../src/queue.ts";

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

test("撤回插入的消息：按 uuid 发 cancel_async_message，按 request_id 认回复", () => {
  assert.deepEqual(JSON.parse(cancelInsertLine("r9", "i1")), {
    type: "control_request",
    request_id: "r9",
    request: { subtype: "cancel_async_message", message_uuid: "i1" },
  });
  const reply = (id: string, cancelled: unknown) => JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: id, response: { cancelled } } });
  assert.equal(parseCancelled(reply("r9", true), "r9"), true);
  assert.equal(parseCancelled(reply("r9", false), "r9"), false);
  assert.equal(parseCancelled(reply("other", true), "r9"), null, "别的请求的回复");
  assert.equal(parseCancelled(reply("r9", "yes"), "r9"), null, "格式不对");
  assert.equal(parseCancelled(user("r9", "x"), "r9"), null, "不是控制回复");
});

test("撤回成功的插入消息移出队列；来不及撤回的标成 late，回传后照常移出", () => {
  const queue: Queued[] = [
    { id: "i1", text: "顺便看下日志", mode: "insert", cancelling: true },
    { id: "w1", text: "然后提交", mode: "wait" },
  ];
  assert.deepEqual(settleCancel(queue, "i1", true), [{ id: "w1", text: "然后提交", mode: "wait" }]);
  const late = settleCancel(queue, "i1", false);
  assert.deepEqual(late[0], { id: "i1", text: "顺便看下日志", mode: "insert", late: true });
  // 撤回成功后只剩等结束的：这一轮结束时照常发出。
  const thread = newThread();
  apply(thread, user("u0", "开始"));
  apply(thread, result());
  assert.equal(afterTurn(settleCancel(queue, "i1", true), thread, false), "flush");
  assert.equal(afterTurn(late, thread, false), null, "来不及撤回的还要等回传");
  apply(thread, user("i1", "顺便看下日志"));
  assert.deepEqual(confirmInserted(late, thread), [{ id: "w1", text: "然后提交", mode: "wait" }]);
});

test("几条等结束的消息合成一条，空行分隔", () => {
  assert.equal(joinQueued([{ id: "1", text: "a", mode: "wait" }, { id: "2", text: "b\n", mode: "wait" }]), "a\n\nb");
});
