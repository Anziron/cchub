// 用真实录制回放，不是手写假数据。运行：node --test web/test/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  allowLine,
  answerLine,
  apply,
  addSending,
  failSending,
  findModel,
  firstAsk,
  hubHost,
  hubUrl,
  isSending,
  isWaiting,
  markInterrupting,
  newThread,
  onProcessExit,
  matchCommands,
  mergeRateLimits,
  parseCommands,
  parseModels,
  parseRateLimits,
  runningTasks,
  taskOutputPath,
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
  assert.ok(tool.kind === "tool" && tool.blocked && tool.result === "Blocked: sleep 60 followed by: echo");
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
  assert.equal(runningTasks(thread).length, 1);
  apply(thread, JSON.stringify({ type: "result", subtype: "success" }));
  assert.equal(runningTasks(thread).length, 1, "一轮结束不等于后台任务结束");
  apply(thread, JSON.stringify({ type: "system", subtype: "task_notification", task_id: "b1" }));
  assert.equal(runningTasks(thread).length, 0);
});

test("发送的消息立刻显示，回传后不重复", () => {
  const thread = newThread();
  addSending(thread, "u1", "你好");
  assert.ok(isSending(thread));
  assert.equal(thread.phase, "thinking");
  apply(thread, JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "你好" } }));
  assert.deepEqual(thread.items, [{ kind: "user", id: "u1", text: "你好" }]);
  assert.ok(!isSending(thread));
});

test("服务器报错后消息转为失败，界面不再显示运行中", () => {
  const thread = newThread();
  addSending(thread, "u1", "你好");
  failSending(thread);
  assert.equal(thread.phase, "idle");
  assert.equal((thread.items[0] as { state?: string }).state, "failed");
});

test("模型列表只认这次请求的回复", () => {
  const reply = (id: string) => JSON.stringify({ type: "control_response", response: { request_id: id, response: { models: [{ value: "opus", displayName: "Opus 5.5" }, { bad: 1 }] } } });
  assert.deepEqual(parseModels(reply("now"), "now"), [{ value: "opus", displayName: "Opus 5.5" }]);
  assert.equal(parseModels(reply("old"), "now"), null);
  assert.equal(parseModels("not json now", "now"), null);
});

test("完整模型 ID 显示成具体模型，而不是默认", () => {
  const models = [
    { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default" },
    { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" },
  ];
  assert.equal(findModel(models, "claude-opus-5-5")?.value, "opus");
  assert.equal(findModel(models, "default")?.value, "default");
  assert.equal(findModel(models, "unknown"), undefined);
});

test("服务器地址只填 IP 也能补全", () => {
  assert.equal(hubUrl(" 100.64.0.1 "), "ws://100.64.0.1:7878/ws");
  assert.equal(hubUrl("100.64.0.1:9000"), "ws://100.64.0.1:9000/ws");
  assert.equal(hubUrl("ws://100.64.0.1:7878/ws"), "ws://100.64.0.1:7878/ws");
  assert.equal(hubUrl(""), null);
  assert.equal(hubUrl("a b"), null);
  assert.equal(hubHost("ws://100.64.0.1:7878/ws"), "100.64.0.1");
});

test("命令转入后台要靠 task_updated，停止后不再算运行中", () => {
  const thread = newThread();
  const system = (o: object) => apply(thread, JSON.stringify({ type: "system", ...o }));
  system({ subtype: "task_started", task_id: "f", is_backgrounded: false, description: "前台" });
  assert.equal(runningTasks(thread).length, 0, "前台命令不算后台任务");
  system({ subtype: "task_updated", task_id: "f", patch: { is_backgrounded: true } });
  assert.equal(runningTasks(thread).length, 1);
  system({ subtype: "task_updated", task_id: "f", patch: { status: "killed", end_time: 123 } });
  assert.equal(runningTasks(thread).length, 0);
  assert.equal(thread.tasks.get("f")?.status, "stopped");
  assert.equal(thread.tasks.get("f")?.endedAt, 123);
  system({ subtype: "background_tasks_changed", tasks: [{ task_id: "g", task_type: "local_bash", description: "构建" }] });
  assert.equal(runningTasks(thread)[0].description, "构建");
  onProcessExit(thread);
  assert.equal(runningTasks(thread).length, 0, "进程结束后任务都不在运行");
});

test("运行中任务的输出路径来自工具结果，结束后用 output_file", () => {
  const thread = newThread();
  apply(thread, JSON.stringify({ type: "assistant", message: { id: "m", content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "x" } }] } }));
  apply(thread, JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "Output is being written to: /tmp/claude-0/p/s/tasks/b1.output" }] } }));
  apply(thread, JSON.stringify({ type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "t", is_backgrounded: true }));
  const task = thread.tasks.get("b1")!;
  assert.equal(taskOutputPath(thread, task), "/tmp/claude-0/p/s/tasks/b1.output");
  apply(thread, JSON.stringify({ type: "system", subtype: "task_notification", task_id: "b1", status: "failed", output_file: "/tmp/claude-0/p/s/tasks/final.output" }));
  assert.equal(taskOutputPath(thread, task), "/tmp/claude-0/p/s/tasks/final.output");
  assert.equal(task.status, "failed");
});

test("上下文取最后一条消息的 usage，上限来自 result", () => {
  const thread = newThread();
  apply(thread, JSON.stringify({ type: "assistant", message: { id: "m", model: "x", content: [], usage: { input_tokens: 2, cache_read_input_tokens: 10309, cache_creation_input_tokens: 14098 } } }));
  assert.deepEqual(thread.context, { used: 24409 });
  apply(thread, JSON.stringify({ type: "result", subtype: "success", modelUsage: { x: { contextWindow: 1000000 } } }));
  assert.deepEqual(thread.context, { used: 24409, max: 1000000 });
  apply(thread, JSON.stringify({ type: "assistant", parent_tool_use_id: "p", message: { id: "s", content: [], usage: { input_tokens: 5 } } }));
  assert.equal(thread.context?.used, 24409, "子代理的用量不算");
});

test("额度合并：重放旧数据不能盖掉新的", () => {
  const line = (utilization: number, resetsAt: number) => JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization, resetsAt } } } });
  const now = parseRateLimits(line(0.5, 100))!;
  assert.equal(mergeRateLimits(now, parseRateLimits(line(0.2, 100))!).fiveHour?.utilization, 0.5, "同一窗口取更高");
  assert.equal(mergeRateLimits(now, parseRateLimits(line(0.9, 50))!).fiveHour?.utilization, 0.5, "旧窗口不算");
  assert.equal(mergeRateLimits(now, parseRateLimits(line(0.1, 200))!).fiveHour?.utilization, 0.1, "新窗口重新算");
});

test("额度合并：同一窗口官方提前清零也要更新，按来源判断新旧", () => {
  const line = (utilization: number) => JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { seven_day: { utilization, resetsAt: 500 } } } });
  const RUNNING = Number.MAX_SAFE_INTEGER;
  // 本地缓存里的旧数据没有来源：任何带来源的新事件都能覆盖它。
  const cached = parseRateLimits(line(0.31))!;
  const live = mergeRateLimits(cached, parseRateLimits(line(0), { session: "a", seq: 900, rank: RUNNING })!);
  assert.equal(live.sevenDay?.utilization, 0, "运行中会话报的清零要采用");
  // 同一会话从头重放：seq 更小，是旧数据。
  assert.equal(mergeRateLimits(live, parseRateLimits(line(0.31), { session: "a", seq: 10, rank: RUNNING })!).sevenDay?.utilization, 0, "同一会话重放不覆盖");
  assert.equal(mergeRateLimits(live, parseRateLimits(line(0.01), { session: "a", seq: 1200, rank: RUNNING })!).sevenDay?.utilization, 0.01, "同一会话后面的事件采用");
  // 已结束的旧会话重放：最后活动时间早于运行中会话，不覆盖。
  assert.equal(mergeRateLimits(live, parseRateLimits(line(0.31), { session: "old", seq: 99999, rank: 1700000000 })!).sevenDay?.utilization, 0, "旧会话重放不覆盖");
  // 都已结束时，最后活动更晚的会话为准。
  const ended = mergeRateLimits({}, parseRateLimits(line(0.2), { session: "b", seq: 5, rank: 1700000100 })!);
  assert.equal(mergeRateLimits(ended, parseRateLimits(line(0.4), { session: "c", seq: 5, rank: 1700000000 })!).sevenDay?.utilization, 0.2);
  assert.equal(mergeRateLimits(ended, parseRateLimits(line(0.05), { session: "c", seq: 5, rank: 1700000200 })!).sevenDay?.utilization, 0.05);
  assert.equal(parseRateLimits("{\"type\":\"user\"}"), null);
});

test("命令菜单只在输入 / 词时出现，前缀匹配排在前面", () => {
  const commands = [{ name: "autocompact" }, { name: "compact" }, { name: "clear" }];
  assert.deepEqual(matchCommands(commands, "/").map((c) => c.name), ["autocompact", "compact", "clear"]);
  assert.deepEqual(matchCommands(commands, "/comp").map((c) => c.name), ["compact", "autocompact"]);
  assert.deepEqual(matchCommands(commands, "/compact 说明"), []);
  assert.deepEqual(matchCommands(commands, "你好 /c"), []);
  assert.deepEqual(matchCommands(commands, ""), []);
  const reply = JSON.stringify({ type: "control_response", response: { request_id: "r", response: { commands: [{ name: "x", description: "d" }, { bad: 1 }] } } });
  assert.deepEqual(parseCommands(reply, "r"), [{ name: "x", description: "d" }]);
  assert.equal(parseCommands(reply, "other"), null);
});

test("内置命令的回传显示成原命令，重放时排回回复前面", () => {
  const echo = (uuid: string) => JSON.stringify({ type: "user", uuid, message: { role: "user", content: "<command-name>/context</command-name>\n<command-args></command-args>" } });
  const live = newThread();
  addSending(live, "u1", "/context");
  apply(live, echo("u1"));
  assert.deepEqual(live.items, [{ kind: "user", id: "u1", text: "/context" }]);

  const replay = newThread();
  apply(replay, JSON.stringify({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "结果" }] } }));
  apply(replay, echo("u1"));
  assert.equal(replay.items[0].kind, "user");
  assert.equal(replay.items[1].kind, "text");
});

test("后台任务的通知不显示成用户消息", () => {
  const thread = newThread();
  apply(thread, JSON.stringify({ type: "user", isReplay: true, origin: { kind: "task-notification" }, message: { role: "user", content: "<task-notification>\n<task-id>b1</task-id>\n</task-notification>" } }));
  assert.equal(thread.items.length, 0);
  assert.equal(thread.phase, "thinking");
});

const assistantLine = (content: unknown[], id = "m1") => JSON.stringify({ type: "assistant", message: { id, content } });

test("空思考块不显示，有内容的照常显示", () => {
  const thread = newThread();
  apply(thread, assistantLine([{ type: "thinking", thinking: "" }]));
  assert.equal(thread.items.length, 0);
  assert.equal(thread.phase, "thinking");
  apply(thread, assistantLine([{ type: "thinking", thinking: "想一想" }]));
  assert.deepEqual(thread.items.map((item) => item.kind), ["thinking"]);
});

test("技能正文折叠进工具行，不显示成用户消息", () => {
  const thread = newThread();
  apply(thread, assistantLine([{ type: "tool_use", id: "s1", name: "Skill", input: { skill: "hub-ops" } }]));
  const body = "Base directory for this skill: /x\n\n# 技能";
  const message = { content: [{ type: "tool_result", tool_use_id: "s1", content: "Launching skill: hub-ops" }] };
  apply(thread, JSON.stringify({ type: "user", message }));
  apply(thread, JSON.stringify({ type: "user", isSynthetic: true, message: { content: [{ type: "text", text: body }] } }));
  assert.deepEqual(thread.items.map((item) => item.kind), ["tool"]);
  const tool = thread.items[0];
  assert.equal(tool.kind === "tool" && tool.detail, body);
});

test("注入消息按 sourceToolUseID 对应，字符串内容也不显示", () => {
  const thread = newThread();
  apply(thread, assistantLine([
    { type: "tool_use", id: "s1", name: "Skill", input: {} },
    { type: "tool_use", id: "s2", name: "Skill", input: {} },
  ]));
  const body = "Base directory for this skill: /a";
  apply(thread, JSON.stringify({ type: "user", isMeta: true, sourceToolUseID: "s1", message: { content: body } }));
  apply(thread, JSON.stringify({ type: "user", isSynthetic: true, message: { content: "其他注入内容" } }));
  const [first, second] = thread.items;
  assert.equal(first.kind === "tool" && first.detail, body);
  assert.equal(second.kind === "tool" && second.detail, undefined);
  assert.ok(!thread.items.some((item) => item.kind === "user"));
});

test("真实用户消息和中断标记不受注入过滤影响", () => {
  const thread = newThread();
  apply(thread, JSON.stringify({ type: "user", uuid: "u1", message: { content: "你好" } }));
  apply(thread, JSON.stringify({ type: "user", uuid: "u2", message: { content: [{ type: "text", text: "补充" }] } }));
  apply(thread, JSON.stringify({ type: "user", uuid: "u3", isSynthetic: true, message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }));
  assert.deepEqual(thread.items.map((item) => item.kind), ["user", "user", "interrupted"]);
});

test("中断状态：空闲时不记，重复按不重置时间，一轮结束或进程退出时清除", () => {
  const thread = newThread();
  markInterrupting(thread, 1);
  assert.equal(thread.interruptAt, undefined);
  addSending(thread, "u1", "你好");
  markInterrupting(thread, 2);
  markInterrupting(thread, 3);
  assert.equal(thread.interruptAt, 2);
  apply(thread, JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }));
  assert.equal(thread.interruptAt, undefined);
  addSending(thread, "u2", "再来");
  markInterrupting(thread, 4);
  onProcessExit(thread);
  assert.equal(thread.interruptAt, undefined);
});
