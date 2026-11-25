// store.ts 的特性测试：记下现在的行为（回执怎么处理、待定的模型和强度什么时候发出、额度新旧），重构时守住。
// 浏览器全局的桩和假 hub 在 fakeStore.ts，它必须排在 store.ts 前面导入。
import { event, fakeHub, sessionInfo, settle, storage } from "./fakeStore.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, mock, test } from "node:test";
import { ackReason, firstAsk, userState } from "../src/model.ts";
import { describeCwd, isResumeCommand, Store } from "../src/store.ts";

const recording = (name: string) => readFileSync(new URL(`../../testdata/recordings/${name}/stream.jsonl`, import.meta.url), "utf8").trim().split("\n");
const INIT = recording("approval")[0];

beforeEach(() => {
  storage.clear();
  mock.timers.enable({ apis: ["setTimeout"] });
});
afterEach(() => mock.timers.reset());

/** 一个已知会话 s1；`init` 时先重放 system/init，让线程有 CLI 的会话 ID。 */
function setup(running = true, init = true) {
  const hub = fakeHub();
  const store = new Store(hub.hub);
  hub.emit({ type: "sessions", sessions: [sessionInfo("s1", running)], mem_available_mb: null });
  if (init) hub.emit(event("s1", 0, INIT));
  const session = store.sessions.get("s1")!;
  return { store, hub, session };
}

test("/mnt/<设备>/ 下是设备目录，其他是服务器本地目录", () => {
  assert.deepEqual(describeCwd("/mnt/laptop/work/app"), { project: "app", device: "laptop" });
  assert.deepEqual(describeCwd("/srv/tools/"), { project: "tools", device: "服务器" });
  assert.deepEqual(describeCwd("/"), { project: "/", device: "服务器" });
  assert.deepEqual(describeCwd(undefined), { project: "", device: "" });
});

test("只有单独的 /resume 由界面处理", () => {
  assert.equal(isResumeCommand(" /resume "), true);
  assert.equal(isResumeCommand("/resume abc"), false);
  assert.equal(isResumeCommand("/resumes"), false);
});

// ---- 用户消息的回执 ----

test("用户消息回执成功：已送达；重复的回执没人等，忽略", () => {
  const { store, hub, session } = setup();
  store.sendText(session, "你好");
  const [msg] = hub.users();
  assert.equal(msg.body.uuid, msg.id, "消息 uuid 就是输入 id");
  assert.equal(userState(session.thread, msg.id), "sending");
  hub.ack(msg);
  assert.equal(userState(session.thread, msg.id), "delivered");
  hub.ack(msg, "not_running");
  assert.equal(userState(session.thread, msg.id), "delivered");
  assert.equal(hub.of("start").length, 0);
});

test("用户消息回执进程不在：恢复进程，同一 id 只重发一次，再不在就标失败", () => {
  const { store, hub, session } = setup();
  store.sendText(session, "你好");
  const [first] = hub.users();
  hub.ack(first, "not_running");
  const [start] = hub.of("start");
  assert.deepEqual(start, { type: "start", session: "s1", resume: session.thread.claudeSessionId, model: undefined });
  assert.ok(start.resume, "带上 CLI 的会话 ID");
  const users = hub.users();
  assert.equal(users.length, 2);
  assert.equal(users[1].id, first.id);
  assert.equal(users[1].line, first.line);
  assert.equal(userState(session.thread, first.id), "sending");
  hub.ack(users[1], "not_running");
  assert.equal(userState(session.thread, first.id), "failed");
  assert.equal(hub.of("start").length, 1, "不再重试");
  const item = session.thread.items.find((i) => i.kind === "user" && i.id === first.id);
  assert.equal(item?.kind === "user" && item.error, ackReason("not_running"));
});

for (const error of ["stalled", "invalid"] as const) {
  test(`用户消息回执 ${error}：标失败，顶部提示原因`, () => {
    const { store, hub, session } = setup();
    store.sendText(session, "你好");
    const [msg] = hub.users();
    hub.ack(msg, error);
    assert.equal(userState(session.thread, msg.id), "failed");
    assert.equal(store.error, ackReason(error));
    assert.equal(session.thread.phase, "idle");
  });
}

test("用户消息没发到 hubd：标失败，不写原因，顶部显示连接层的错误", async () => {
  const { store, hub, session } = setup();
  hub.failSends(true);
  store.sendText(session, "你好");
  await settle();
  const item = session.thread.items.find((i) => i.kind === "user");
  assert.equal(item?.kind === "user" && item.state, "failed");
  assert.equal(item?.kind === "user" && item.error, undefined);
  assert.equal(store.error, "Error: 连接已断开");
});

test("启动失败的 error 事件已标失败：之后的进程不在回执不再重试", () => {
  const { store, hub, session } = setup();
  store.sendText(session, "你好");
  const [msg] = hub.users();
  hub.emit({ type: "error", session: "s1", message: "启动失败" });
  assert.equal(userState(session.thread, msg.id), "failed");
  hub.ack(msg, "not_running");
  assert.equal(hub.of("start").length, 0);
  assert.equal(hub.users().length, 1);
});

test("进程已回收时发消息：先恢复进程再写", () => {
  const { store, hub, session } = setup(false);
  store.sendText(session, "你好");
  assert.equal(hub.of("start").length, 1);
  assert.equal(session.running, true);
  assert.equal(hub.controls("initialize").length, 1, "恢复后重新问模型和命令");
  assert.equal(hub.users().length, 1);
});

// ---- 模型和强度（含进程不在时的待定选择）----

test("切换模型被拒：退回原来的模型并提示；进程不在：记成待定", () => {
  const { store, hub, session } = setup();
  session.thread.model = "sonnet";
  store.setModel(session, "opus");
  assert.equal(session.thread.model, "opus");
  hub.ack(hub.controls("set_model")[0], "invalid");
  assert.equal(session.thread.model, "sonnet");
  assert.equal(store.error, `切换模型失败：${ackReason("invalid")}`);

  store.setModel(session, "haiku");
  hub.ack(hub.controls("set_model")[1], "not_running");
  assert.equal(session.thread.model, "haiku");
  assert.deepEqual(JSON.parse(storage.getItem("cchub.pending")!), { s1: { model: "haiku" } });
});

test("一轮进行中切换模型：记成下一轮的模型", () => {
  const { store, session } = setup();
  store.sendText(session, "你好");
  store.setModel(session, "opus");
  assert.equal(session.thread.nextModel, "opus");
});

test("进程不在时选的模型和强度：存本地，刷新后照样显示，恢复进程时带上并清掉", () => {
  const first = setup(false);
  first.store.setModel(first.session, "opus");
  first.store.setEffort(first.session, "high");
  assert.equal(first.hub.inputs().length, 0, "进程不在，不写 FIFO");
  assert.deepEqual(JSON.parse(storage.getItem("cchub.pending")!), { s1: { model: "opus", effort: "high" } });

  // 刷新：新的 Store 从本地读出待定选择，重放日志后套上。
  const { store, hub, session } = setup(false);
  assert.equal(session.thread.model, "opus");
  assert.equal(session.thread.effort, "high");

  store.sendText(session, "你好");
  const [start] = hub.of("start");
  assert.equal(start.model, "opus");
  assert.equal(hub.controls("apply_flag_settings")[0].body.request.settings.effortLevel, "high");
  assert.equal(hub.controls("set_model").length, 0, "模型走 --model，不再发 set_model");
  assert.deepEqual(JSON.parse(storage.getItem("cchub.pending")!), {});
  hub.emit({ type: "status", session: "s1", running: true });
  assert.equal(hub.controls("set_model").length, 0, "用掉的待定选择不再补发");
  assert.equal(hub.controls("apply_flag_settings").length, 1);
});

test("别的设备先拉起了进程：补发本机待定的模型和强度", () => {
  const { store, hub, session } = setup(false);
  store.setModel(session, "opus");
  store.setEffort(session, undefined);
  hub.emit({ type: "status", session: "s1", running: true });
  assert.equal(hub.controls("set_model")[0].body.request.model, "opus");
  assert.equal(hub.controls("apply_flag_settings")[0].body.request.settings.effortLevel, null, "恢复默认也要补发");
  assert.deepEqual(JSON.parse(storage.getItem("cchub.pending")!), {});
});

test("列表里看到会话在运行：同样补发待定选择", () => {
  const first = setup(false);
  first.store.setModel(first.session, "opus");
  const hub = fakeHub();
  new Store(hub.hub);
  hub.emit({ type: "sessions", sessions: [sessionInfo("s1", true)], mem_available_mb: null });
  assert.equal(hub.controls("set_model")[0].body.request.model, "opus");
});

test("恢复进程时重发当前强度：强度只在进程里有效", () => {
  const { store, hub, session } = setup();
  session.thread.effort = "low";
  store.sendText(session, "你好");
  hub.ack(hub.users()[0], "not_running");
  assert.equal(hub.controls("apply_flag_settings")[0].body.request.settings.effortLevel, "low");
});

test("设置强度回执进程不在：记成待定；被拒：提示", () => {
  const { store, hub, session } = setup();
  store.setEffort(session, "max");
  hub.ack(hub.controls("apply_flag_settings")[0], "not_running");
  assert.deepEqual(JSON.parse(storage.getItem("cchub.pending")!), { s1: { effort: "max" } });
  store.setEffort(session, "low");
  hub.ack(hub.controls("apply_flag_settings")[1], "stalled");
  assert.equal(store.error, `设置推理强度失败：${ackReason("stalled")}`);
  assert.equal(session.thread.effort, "low", "强度不回滚");
});

// ---- 卡片回复（用真实录制的审批请求）----

function approval() {
  const ctx = setup(true, false);
  recording("approval")
    .slice(0, 18)
    .forEach((line, i) => ctx.hub.emit(event("s1", i * 1000, line)));
  const ask = firstAsk(ctx.session.thread);
  assert.ok(ask, "录制里有审批请求");
  return { ...ctx, ask };
}

test("回复卡片：发出后锁住；回执进程不在：卡片失效", () => {
  const { store, hub, session, ask } = approval();
  store.allow(session, ask);
  const [reply] = hub.replies();
  assert.equal(reply.body.response.request_id, ask.requestId);
  assert.equal(ask.sent, true);
  hub.ack(reply, "not_running");
  assert.equal(ask.expired, true);
});

test("回复卡片被拒：解锁并写上原因，输入框里打的话放回草稿", () => {
  const { store, hub, session, ask } = approval();
  store.deny(session, ask, "用户没有选选项，而是回复：换个目录", "换个目录");
  assert.equal(ask.reply, "换个目录");
  hub.ack(hub.replies()[0], "stalled");
  assert.equal(ask.sent, false);
  assert.equal(ask.reply, undefined);
  assert.equal(ask.error, ackReason("stalled"));
  assert.equal(store.draft("s1"), "换个目录");
});

test("回复卡片没发到 hubd：提示可以再试", async () => {
  const { store, hub, session, ask } = approval();
  hub.failSends(true);
  store.allow(session, ask);
  await settle();
  assert.equal(ask.sent, false);
  assert.equal(ask.error, "没有发出，可以再试一次");
});

// ---- 一轮进行中再发的消息 ----

test("插入的消息写进去了：标已送达；没写进去：转成等结束并提示", () => {
  const { store, hub, session } = setup();
  store.sendText(session, "先做这个");
  store.enqueue(session, "顺便看看那个", "insert");
  store.enqueue(session, "还有这个", "insert");
  const [, a, b] = hub.users();
  hub.ack(a);
  hub.ack(b, "stalled");
  assert.deepEqual(
    session.queue.map((q) => [q.text, q.mode, q.delivered ?? false]),
    [
      ["顺便看看那个", "insert", true],
      ["还有这个", "wait", false],
    ],
  );
  assert.equal(store.error, ackReason("stalled"));
});

test("进程结束：没发出的排队消息放回输入框", () => {
  const { store, hub, session } = setup();
  store.setDraft("s1", "草稿");
  store.sendText(session, "先做这个");
  store.enqueue(session, "等结束再说", "wait");
  hub.emit({ type: "status", session: "s1", running: false });
  assert.deepEqual(session.queue, []);
  assert.equal(store.draft("s1"), "草稿\n\n等结束再说");
});

// ---- 额度 ----

const limitLine = (utilization: number) =>
  JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization, resetsAt: 2000000000 } } } });

test("打开会话时重放的历史额度不盖掉实时额度；之后的实时事件照常更新", () => {
  const { store, hub } = setup(true, false);
  hub.emit(event("s1", 5000, limitLine(0.5)));
  hub.emit({ type: "sessions", sessions: [sessionInfo("s2", true, { updated: 50 })], mem_available_mb: null });
  hub.emit({ type: "attached", session: "s2", live: 1000 });
  hub.emit(event("s2", 100, limitLine(0.9)));
  assert.equal(store.limits.fiveHour?.utilization, 0.5, "s2 的历史不算");
  hub.emit(event("s2", 1200, limitLine(0.6)));
  assert.equal(store.limits.fiveHour?.utilization, 0.6, "s2 的实时事件算");
  assert.equal(storage.getItem("cchub.limits"), null, "合并到 1 秒后写一次");
  mock.timers.tick(1000);
  assert.equal(JSON.parse(storage.getItem("cchub.limits")!).fiveHour.utilization, 0.6);
});

// ---- 新会话 ----

test("新会话：启动、订阅、问模型、设强度、发第一条消息，几秒后刷新列表拿标题", () => {
  const hub = fakeHub();
  const store = new Store(hub.hub);
  store.newSession("修一下登录\n细节如下", "/work", "default", "high");
  const [start] = hub.of("start");
  assert.equal(start.cwd, "/work");
  assert.equal(start.title, "修一下登录");
  assert.equal(start.prompt, "修一下登录\n细节如下");
  assert.equal(start.model, undefined, "选“默认”不带 --model");
  assert.equal(hub.of("attach")[0].session, start.session);
  assert.equal(hub.controls("initialize").length, 1);
  assert.equal(hub.controls("apply_flag_settings")[0].body.request.settings.effortLevel, "high");
  assert.equal(hub.users()[0].body.message.content, "修一下登录\n细节如下");
  assert.equal(store.selected, start.session);
  const lists = () => hub.of("list").length;
  const before = lists();
  mock.timers.tick(7000);
  assert.equal(lists(), before + 1);
  mock.timers.tick(13000);
  assert.equal(lists(), before + 2);
});
