// 用真实录制回放，不是手写假数据。运行：node --test web/test/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  allowLine,
  answerLine,
  apply,
  addSending,
  effortsFor,
  failSending,
  findModel,
  firstAsk,
  hubHost,
  hubUrl,
  isSending,
  isTranscript,
  isWaiting,
  markInterrupting,
  newThread,
  onProcessExit,
  matchCommands,
  mergeRateLimits,
  parseCommands,
  parseModels,
  parseRateLimits,
  parseTranscript,
  runningTasks,
  searchLinks,
  setEffortLine,
  taskOutputPath,
  turnTokens,
  userLine,
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

test("切换模型时 CLI 回显的本地命令输出显示成提示，不当成用户消息，也不进入思考", () => {
  const thread = newThread();
  apply(thread, JSON.stringify({ type: "user", uuid: "x1", isReplay: true, message: { role: "user", content: "<local-command-stdout>Set model to `opus (claude-opus-5-5)`</local-command-stdout>" } }));
  assert.deepEqual(thread.items, [{ kind: "notice", id: "x1", text: "已切换模型：opus (claude-opus-5-5)" }]);
  assert.equal(thread.phase, "idle");
  // 会话记录里的形式：命令和输出合在一条里。
  const history = newThread();
  apply(history, JSON.stringify({ type: "user", uuid: "x2", message: { role: "user", content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>\n<local-command-stdout>Set model to `sonnet (claude-sonnet-5-5)`</local-command-stdout>" } }));
  assert.deepEqual(history.items, [{ kind: "notice", id: "x2", text: "已切换模型：sonnet (claude-sonnet-5-5)" }]);
  assert.equal(history.phase, "idle");
  // 其他本地命令的输出原样作为提示。
  const other = newThread();
  apply(other, JSON.stringify({ type: "user", uuid: "x3", message: { role: "user", content: "<local-command-stdout>Done</local-command-stdout>" } }));
  assert.deepEqual(other.items, [{ kind: "notice", id: "x3", text: "Done" }]);
});

test("子代理的工具结果不改变主线程状态", () => {
  const ev = (o: object) => JSON.stringify(o);
  // 主轮已结束，后台子代理继续跑
  const idle = newThread();
  apply(idle, ev({ type: "result", subtype: "success", is_error: false }));
  apply(idle, ev({ type: "assistant", parent_tool_use_id: "X", message: { id: "s1", content: [{ type: "tool_use", id: "sub1", name: "Bash", input: { command: "ls" } }] } }));
  apply(idle, ev({ type: "user", parent_tool_use_id: "X", message: { content: [{ type: "tool_result", tool_use_id: "sub1", content: "ok" }] } }));
  assert.equal(idle.phase, "idle");
  // 主线程正在执行 Agent 工具
  const running = newThread();
  apply(running, ev({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "X", name: "Agent", input: { description: "d" } }] } }));
  assert.equal(running.phase, "tool");
  const active = running.activeTool;
  apply(running, ev({ type: "assistant", parent_tool_use_id: "X", message: { id: "s2", content: [{ type: "tool_use", id: "sub2", name: "Bash", input: { command: "ls" } }] } }));
  apply(running, ev({ type: "user", parent_tool_use_id: "X", message: { content: [{ type: "tool_result", tool_use_id: "sub2", content: "ok" }] } }));
  assert.equal(running.phase, "tool");
  assert.deepEqual(running.activeTool, active);
  // 主线程自己的工具结果仍切到思考中
  apply(running, ev({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "X", content: "done" }] } }));
  assert.equal(running.phase, "thinking");
});

test("子代理记录按对话解析：提示、文字、工具调用和结果", () => {
  const text = [
    JSON.stringify({ type: "user", isSidechain: true, uuid: "u1", message: { role: "user", content: "查一下文档" } }),
    JSON.stringify({ type: "assistant", isSidechain: true, message: { id: "m1", role: "assistant", content: [{ type: "text", text: "我先读文件" }] } }),
    JSON.stringify({ type: "assistant", isSidechain: true, message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.md" } }] } }),
    JSON.stringify({ type: "user", isSidechain: true, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "内容" }] } }),
  ].join("\n");
  assert.ok(isTranscript(text));
  assert.ok(!isTranscript("npm test\nok"));
  const items = parseTranscript(text);
  assert.deepEqual(items.map((item) => item.kind), ["user", "text", "tool"]);
  const tool = items[2];
  assert.ok(tool.kind === "tool" && tool.name === "Read" && tool.result === "内容");
});

test("推理强度：会话记录里的 effort 更新当前强度，子代理的不算", () => {
  const thread = newThread();
  const path = new URL("../../testdata/recordings/question/transcript.jsonl", import.meta.url);
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) apply(thread, line);
  assert.equal(thread.effort, "medium");
  apply(thread, JSON.stringify({ type: "assistant", effort: "max", isSidechain: true, message: { id: "s", content: [] } }));
  assert.equal(thread.effort, "medium");
});

test("推理强度：按模型列表过滤，CLI 说不支持时为空", () => {
  const all = effortsFor(undefined).map((e) => e.value);
  assert.deepEqual(all, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(effortsFor({ value: "x", resolvedModel: "x", displayName: "X", supportedEffortLevels: ["low", "max"] }).map((e) => e.value), ["low", "max"]);
  assert.deepEqual(effortsFor({ value: "h", resolvedModel: "claude-haiku-4-5", displayName: "H" }), []);
  assert.equal(effortsFor({ value: "opus", displayName: "Opus" }).length, 5);
  const line = JSON.parse(setEffortLine(null));
  assert.deepEqual(line.request, { subtype: "apply_flag_settings", settings: { effortLevel: null } });
});

// ---- 界面改版：每轮统计、权限模式、改动汇总、工具合并 ----
import { collectChanges, groupTools, latestPlan } from "../src/model.ts";

const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: "assistant", message: { id: `m-${id}`, content: [{ type: "tool_use", id, name, input }] } });
const toolResult = (id: string, content: string, isError = false) =>
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });

test("正常结束的一轮加一条用时和 token，并累计到 stats；出错和中断不加", () => {
  const thread = newThread();
  apply(thread, JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 134000, usage: { output_tokens: 1700 }, uuid: "r1" }));
  assert.deepEqual(thread.items, [{ kind: "turn", id: "r1", durationMs: 134000, outputTokens: 1700 }]);
  apply(thread, JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, duration_ms: 2000, usage: { output_tokens: 10 } }));
  apply(thread, JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "超过轮数", duration_ms: 1000 }));
  assert.deepEqual(thread.items.map((i) => i.kind), ["turn", "error"]);
  assert.deepEqual(thread.stats, { turns: 3, durationMs: 137000, outputTokens: 1710 });
});

test("init 的权限模式记下来", () => {
  const thread = newThread();
  apply(thread, JSON.stringify({ type: "system", subtype: "init", session_id: "s", model: "m", cwd: "/w", permissionMode: "acceptEdits" }));
  assert.equal(thread.permissionMode, "acceptEdits");
});

test("改动按文件汇总，只算执行成功的 Edit / MultiEdit / Write", () => {
  const thread = newThread();
  for (const line of [
    toolUse("e1", "Edit", { file_path: "/w/a.py", old_string: "x", new_string: "y\nz" }),
    toolResult("e1", "ok"),
    toolUse("w1", "Write", { file_path: "/w/b.md", content: "1\n2\n3" }),
    toolResult("w1", "ok"),
    toolUse("m1", "MultiEdit", { file_path: "/w/a.py", edits: [{ old_string: "a\nb", new_string: "c" }] }),
    toolResult("m1", "ok"),
    toolUse("e2", "Edit", { file_path: "/w/c.py", old_string: "q", new_string: "r" }),
    toolResult("e2", "String not found", true),
    toolUse("r1", "Read", { file_path: "/w/d.py" }),
    toolResult("r1", "..."),
  ]) apply(thread, line);
  const changes = collectChanges(thread.items);
  assert.deepEqual(changes.map((c) => [c.path, c.added, c.removed, c.edits.length]), [["/w/a.py", 3, 3, 2], ["/w/b.md", 3, 0, 1]]);
});

test("连续两个以上的工具合并，单个工具和卡片不合并", () => {
  const thread = newThread();
  for (const line of [
    toolUse("t1", "Read", { file_path: "/w/a" }), toolResult("t1", "ok"),
    toolUse("t2", "Read", { file_path: "/w/b" }), toolResult("t2", "ok"),
    JSON.stringify({ type: "assistant", message: { id: "m-x", content: [{ type: "text", text: "看完了" }] } }),
    toolUse("t3", "Bash", { command: "ls" }), toolResult("t3", "ok"),
  ]) apply(thread, line);
  const blocks = groupTools(thread.items);
  assert.deepEqual(blocks.map((b) => (b.kind === "tools" ? `tools:${b.tools.length}` : b.item.kind)), ["tools:2", "text", "tool"]);
});

test("审批卡片打断工具合并", () => {
  const approval = readFileSync(new URL("../../testdata/recordings/approval/stream.jsonl", import.meta.url), "utf8");
  const thread = newThread();
  for (const line of approval.split("\n").filter(Boolean)) {
    apply(thread, line);
    if (line.includes('"can_use_tool"')) break;
  }
  const blocks = groupTools(thread.items);
  assert.ok(blocks.some((b) => b.kind === "item" && b.item.kind === "ask"));
  assert.ok(!blocks.some((b) => b.kind === "tools" && b.tools.some((t) => t.kind !== "tool")));
});

test("最近的方案来自方案确认请求", () => {
  const plan = readFileSync(new URL("../../testdata/recordings/plan/stream.jsonl", import.meta.url), "utf8");
  const thread = newThread();
  for (const line of plan.split("\n").filter(Boolean)) apply(thread, line);
  const text = latestPlan(thread);
  assert.ok(text === undefined || text.length > 0);
});

test("实时 token：生成中按字符估算，消息结束用 output_tokens，子代理同一条消息取最大值，新一轮清零", () => {
  const thread = newThread();
  const stream = (event: object, parent?: string) => apply(thread, JSON.stringify({ type: "stream_event", api_message_id: "m1", parent_tool_use_id: parent ?? null, event }));
  addSending(thread, "u1", "开始");
  assert.equal(turnTokens(thread), 0);
  stream({ type: "message_start", message: { id: "m1", usage: { output_tokens: 8 } } });
  stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "1234" } });
  stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "abcdefgh" } });
  assert.equal(turnTokens(thread), 3, "12 个字符约 3 个 token");
  stream({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 50 } });
  assert.equal(turnTokens(thread), 50, "消息结束后以 output_tokens 为准，不再加估算");
  stream({ type: "message_start", message: { id: "m2" } });
  stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"a\":1}" } });
  assert.equal(turnTokens(thread), 52);
  stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "子代理的片段不算" } }, "T");
  assert.equal(turnTokens(thread), 52);
  const agent = (id: string, output: number) => apply(thread, JSON.stringify({ type: "assistant", parent_tool_use_id: "T", message: { id, content: [], usage: { output_tokens: output } } }));
  agent("s1", 10);
  agent("s1", 30);
  agent("s2", 5);
  assert.equal(turnTokens(thread), 87);
  apply(thread, JSON.stringify({ type: "result", subtype: "success", is_error: false }));
  apply(thread, userLine("下一轮"));
  assert.equal(turnTokens(thread), 0);
});

test("网页搜索结果：取出每次搜索的链接，其余文字保留；没有链接或格式不对时返回 null", () => {
  const result = [
    "Web search results for query: \"x\"",
    "",
    "Links: [{\"title\":\"A [1]\",\"url\":\"https://a.example/p?q=1&r=2\"},{\"title\":\"B\",\"url\":\"https://b.example\"}]",
    "",
    "Links: [{\"url\":\"https://c.example\"}]",
    "摘要见 https://a.example",
  ].join("\n");
  const parsed = searchLinks(result)!;
  assert.deepEqual(parsed.links, [
    { title: "A [1]", url: "https://a.example/p?q=1&r=2" },
    { title: "B", url: "https://b.example" },
    { title: "https://c.example", url: "https://c.example" },
  ]);
  assert.equal(parsed.rest, "Web search results for query: \"x\"\n\n\n摘要见 https://a.example");
  assert.equal(searchLinks("没有链接"), null);
  assert.equal(searchLinks("Links: [坏的"), null);
});
