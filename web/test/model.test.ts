// 用真实录制回放，不是手写假数据。运行：node --test web/test/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  allowLine,
  answerLine,
  apply,
  firstAsk,
  isWaiting,
  newThread,
  onProcessExit,
  type Thread,
} from "../src/model.ts";

function lines(scenario: string): string[] {
  const path = new URL(`../../testdata/recordings/${scenario}/stream.jsonl`, import.meta.url);
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

function replayUntil(thread: Thread, all: string[], stop: (line: string) => boolean): string[] {
  for (let i = 0; i < all.length; i++) {
    apply(thread, all[i]);
    if (stop(all[i])) return all.slice(i + 1);
  }
  throw new Error("没有等到目标事件");
}

const isRequest = (line: string) => line.includes('"can_use_tool"');
const texts = (thread: Thread) =>
  thread.items.flatMap((item) => (item.kind === "text" ? [item.text] : []));

test("审批：回答前等待，有工具结果后卡片消失", () => {
  const thread = newThread();
  const rest = replayUntil(thread, lines("approval"), isRequest);
  assert.equal(isWaiting(thread), true);
  const ask = firstAsk(thread)!;
  assert.equal(ask.kind, "approval");
  assert.equal(ask.input.command, "echo hi > marker");
  assert.ok(thread.items.some((item) => item.kind === "ask"));

  for (const line of rest) apply(thread, line);
  assert.equal(isWaiting(thread), false);
  assert.ok(!thread.items.some((item) => item.kind === "ask"));
  assert.equal(thread.phase, "idle");
  assert.ok(texts(thread)[0].startsWith("河流"));
  const tool = thread.items.find((item) => item.kind === "tool");
  assert.equal(tool?.kind === "tool" && tool.result, "(Bash completed with no output)");
  assert.equal(thread.claudeSessionId, "ee93141f-5c3b-4978-8c13-3c77fd8ef727");
});

test("重放同一段事件不会多出卡片或重复工具", () => {
  const thread = newThread();
  const all = lines("approval");
  replayUntil(thread, all, isRequest);
  const before = thread.items.length;
  replayUntil(thread, all, isRequest);
  assert.equal(thread.asks.size, 1);
  assert.equal(thread.items.filter((item) => item.kind === "tool").length, 1);
  assert.ok(thread.items.length >= before);
});

test("提问：解析选项，回复带 answers", () => {
  const thread = newThread();
  const rest = replayUntil(thread, lines("question"), isRequest);
  const ask = firstAsk(thread)!;
  assert.equal(ask.kind, "question");
  assert.equal(ask.questions[0].question, "Pick a color");
  assert.deepEqual(ask.questions[0].options.map((o) => o.label), ["Red", "Blue"]);

  const reply = JSON.parse(answerLine(ask, { "Pick a color": "Blue" }));
  assert.equal(reply.response.request_id, ask.requestId);
  assert.equal(reply.response.response.behavior, "allow");
  assert.equal(reply.response.response.updatedInput.answers["Pick a color"], "Blue");
  assert.ok(reply.response.response.updatedInput.questions);

  for (const line of rest) apply(thread, line);
  assert.equal(isWaiting(thread), false);
  assert.deepEqual(texts(thread), ["Blue"]);
});

test("方案确认：带方案内容；空的 input 也能处理", () => {
  const thread = newThread();
  replayUntil(thread, lines("plan"), isRequest);
  const ask = firstAsk(thread)!;
  assert.equal(ask.kind, "plan");
  assert.ok(ask.plan?.includes("hello.txt"));

  const empty = newThread();
  apply(
    empty,
    JSON.stringify({
      type: "control_request",
      request_id: "r1",
      request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: {}, requires_user_interaction: true },
    }),
  );
  assert.equal(firstAsk(empty)?.plan, undefined);
  assert.equal(firstAsk(empty)?.kind, "plan");
});

test("中断：显示已中断，不算失败", () => {
  const thread = newThread();
  for (const line of lines("interrupt")) apply(thread, line);
  assert.ok(thread.items.some((item) => item.kind === "interrupted"));
  assert.ok(!thread.items.some((item) => item.kind === "error"));
  assert.equal(thread.phase, "idle");
  assert.equal(isWaiting(thread), false);
});

test("跳过全部逐字片段后，结果和不跳过完全一样", () => {
  for (const scenario of ["approval", "question", "plan", "interrupt"]) {
    const full = newThread();
    const skipped = newThread();
    for (const line of lines(scenario)) {
      apply(full, line);
      if (!line.includes('"type": "stream_event"') && !line.includes('"type":"stream_event"')) {
        apply(skipped, line);
      }
    }
    assert.deepEqual(texts(skipped), texts(full), scenario);
    assert.equal(skipped.phase, full.phase, scenario);
  }
});

test("逐字片段先显示，完整消息到达后不重复", () => {
  const thread = newThread();
  const delta = (text: string) =>
    JSON.stringify({
      type: "stream_event",
      api_message_id: "m1",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    });
  apply(thread, delta("你"));
  apply(thread, delta("好"));
  assert.deepEqual(texts(thread), ["你好"]);
  apply(
    thread,
    JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "你好！" }] } }),
  );
  apply(thread, delta("迟到"));
  assert.deepEqual(texts(thread), ["你好！"]);
});

test("用户消息回显，开始计时", () => {
  const thread = newThread();
  apply(
    thread,
    JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2026-10-31T00:00:00.000Z",
      message: { role: "user", content: "修登录" },
    }),
  );
  assert.deepEqual(thread.items[0], { kind: "user", id: "u1", text: "修登录" });
  assert.equal(thread.turnStartedAt, Date.parse("2026-10-31T00:00:00.000Z"));
  assert.equal(thread.phase, "thinking");
});

test("CLI 拦截的结果带原文标记", () => {
  const thread = newThread();
  apply(
    thread,
    JSON.stringify({ type: "assistant", message: { id: "m", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 60; echo" } }] } }),
  );
  const blocked = "<tool_use_error>Blocked: sleep 60 followed by: echo</tool_use_error>";
  apply(
    thread,
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: blocked, is_error: true }] } }),
  );
  const tool = thread.items[0];
  assert.ok(tool.kind === "tool" && tool.blocked && tool.result === blocked);
});

test("普通错误显示出来；进程退出后卡片作废；待办原地更新；后台任务单独记录", () => {
  const thread = newThread();
  apply(thread, JSON.stringify({ type: "result", is_error: true, subtype: "error_max_turns", result: "超过轮数" }));
  assert.ok(thread.items.some((item) => item.kind === "error" && item.text === "超过轮数"));

  apply(thread, JSON.stringify({ type: "control_request", request_id: "r", request: { subtype: "can_use_tool", tool_name: "Bash", input: {} } }));
  assert.equal(isWaiting(thread), true);
  const ask = firstAsk(thread)!;
  assert.equal(JSON.parse(allowLine(ask)).response.response.behavior, "allow");
  onProcessExit(thread);
  assert.equal(isWaiting(thread), false);

  apply(thread, JSON.stringify({ type: "assistant", message: { id: "m", content: [{ type: "tool_use", id: "t", name: "TodoWrite", input: { todos: [{ content: "a", status: "pending" }] } }] } }));
  assert.equal(thread.todos.length, 1);
  assert.ok(!thread.items.some((item) => item.kind === "tool"));

  apply(thread, JSON.stringify({ type: "system", subtype: "task_started", task_id: "b1", is_backgrounded: true }));
  assert.equal(thread.background.size, 1);
  apply(thread, JSON.stringify({ type: "result", subtype: "success" }));
  assert.equal(thread.background.size, 1, "一轮结束不等于后台任务结束");
  apply(thread, JSON.stringify({ type: "system", subtype: "task_notification", task_id: "b1" }));
  assert.equal(thread.background.size, 0);
});
