// store.ts 的特性测试：记下现在的行为（回执怎么处理、待定的模型和强度什么时候发出、额度新旧），重构时守住。
// 浏览器全局的桩和假 hub 在 fakeStore.ts，它必须排在 store.ts 前面导入。
import { event, fakeHub, sessionInfo, settle, storage } from "./fakeStore.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, mock, test } from "node:test";
import { ackReason, firstAsk, userState } from "../src/model.ts";
import { Store, type Session } from "../src/store.ts";

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

test("上下文上限：按模型记在本地，新会话第一轮结束前上下文环就有进度，刷新后也在", () => {
  // 上限只在一轮结束的 `result` 里（`modelUsage[模型].contextWindow`），录制里是 1000000。
  const lines = recording("approval");
  const result = lines.findIndex((line) => JSON.parse(line).type === "result");
  const { store, hub } = setup(true, false);
  lines.forEach((line, i) => hub.emit(event("s1", i * 1000, line)));
  assert.deepEqual(JSON.parse(storage.getItem("cchub.contextWindows")!), { "claude-haiku-5-5": 1000000 }, "按模型 ID 记");
  const firstTurn = (s: Store, h: ReturnType<typeof fakeHub>) => {
    h.emit({ type: "sessions", sessions: [sessionInfo("s2", true)], mem_available_mb: null });
    lines.slice(0, result).forEach((line, i) => h.emit(event("s2", i * 1000, line)));
    const context = s.sessions.get("s2")!.thread.context;
    assert.ok(context?.used, "第一轮结束前已经有用量");
    return context.max;
  };
  assert.equal(firstTurn(store, hub), 1000000, "同一个窗口里开的新会话");
  const again = fakeHub();
  assert.equal(firstTurn(new Store(again.hub), again), 1000000, "刷新后（新的 Store）从本地读出");
});

// ---- 本地存储：键名和格式是老用户数据的约定，不能变 ----

test("偏好存在本地，新开窗口照样读到", async () => {
  const { store } = setup();
  await store.connect("ws://hub");
  store.chooseWorkspace("/work/app");
  store.clickView("plugins", false);
  store.clickView("plugins", false);
  store.toggleVerbose();
  store.setDefaults({ model: "opus", effort: "high" });
  store.setDraft("s1", "没写完的话");
  store.setDraft("s2", "");
  assert.equal(storage.getItem("cchub.url"), "ws://hub");
  assert.equal(storage.getItem("cchub.cwd"), "/work/app");
  assert.equal(storage.getItem("cchub.view"), "plugins");
  assert.equal(storage.getItem("cchub.sideCollapsed"), "1");
  assert.equal(storage.getItem("cchub.verbose"), "1");
  assert.equal(storage.getItem("cchub.defaults"), '{"model":"opus","effort":"high"}');
  assert.equal(storage.getItem("cchub.drafts"), '{"s1":"没写完的话"}');

  const again = new Store(fakeHub().hub);
  assert.equal(again.url, "ws://hub");
  assert.equal(again.showSettings, false);
  assert.equal(again.cwd, "/work/app");
  assert.equal(again.view, "plugins");
  assert.equal(again.sideCollapsed, true);
  assert.equal(again.verbose, true);
  assert.deepEqual(again.defaults, { model: "opus", effort: "high" });
  assert.equal(again.draft("s1"), "没写完的话");
});

test("第一次打开：没有地址先弹设置，视图是首页，其余都是默认", () => {
  const store = new Store(fakeHub().hub);
  assert.equal(store.url, "");
  assert.equal(store.showSettings, true);
  assert.equal(store.view, "home");
  assert.equal(store.sideCollapsed, false);
  assert.equal(store.verbose, false);
  assert.equal(store.cwd, "");
  assert.deepEqual(store.defaults, {});
  assert.deepEqual(store.commands, []);
  assert.equal(store.pane, null);
});

test("initialize 回复里的模型和命令存本地，新开窗口先用它们；读不出时用内置的几个别名", () => {
  storage.setItem("cchub.models", "{坏的");
  const { store, hub, session } = setup();
  assert.deepEqual(
    store.models.map((m) => m.value),
    ["default", "opus", "sonnet", "haiku"],
  );
  const [init] = hub.controls("initialize");
  const models = [{ value: "opus", displayName: "Opus 5.5" }];
  const commands = [{ name: "review", description: "审查" }];
  const reply = { type: "control_response", response: { subtype: "success", request_id: init.body.request_id, response: { models, commands } } };
  hub.emit(event("s1", 2000, JSON.stringify(reply)));
  assert.deepEqual(store.models, models);
  assert.deepEqual(session.commands, commands);
  assert.equal(storage.getItem("cchub.models"), JSON.stringify(models));
  assert.equal(storage.getItem("cchub.commands"), JSON.stringify(commands));

  const again = new Store(fakeHub().hub);
  assert.deepEqual(again.models, models);
  assert.deepEqual(
    again.commandsFor().map((c) => c.name),
    ["resume", "review"],
  );
});

test("缓存的额度去掉来源再用：上次的“运行中”等级不能压住这次的数据", () => {
  storage.setItem("cchub.limits", JSON.stringify({ fiveHour: { utilization: 0.4, resetsAt: 2000000000, source: { session: "x", seq: 1, rank: 9e15 } } }));
  const store = new Store(fakeHub().hub);
  assert.deepEqual(store.limits.fiveHour, { utilization: 0.4, resetsAt: 2000000000 });
});

const taskStarted = (id: string) => JSON.stringify({ type: "system", subtype: "task_started", task_id: id, description: "跑测试", task_type: "local_bash" });

test("后台任务第一次出现时记下开始时间，窗口重建后重放还能用；只留最近 200 条", () => {
  const old = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`old${i}`, i + 1]));
  storage.setItem("cchub.taskTimes", JSON.stringify(old));
  const a = setup();
  a.hub.emit(event("s1", 100, taskStarted("t1")));
  const at = a.session.thread.tasks.get("t1")!.startedAt!;
  assert.ok(at > 0);
  const saved = JSON.parse(storage.getItem("cchub.taskTimes")!);
  assert.equal(Object.keys(saved).length, 200);
  assert.equal(saved.t1, at);
  assert.equal(saved.old0, undefined, "最早的被挤掉");

  const b = setup();
  b.hub.emit(event("s1", 100, taskStarted("t1")));
  assert.equal(b.session.thread.tasks.get("t1")!.startedAt, at);
});

test("重放时第一次看到的就是已结束的任务：开始时间未知，不记", () => {
  const { hub, session } = setup();
  hub.emit(event("s1", 100, JSON.stringify({ type: "system", subtype: "task_notification", task_id: "t9", status: "completed", summary: "完成" })));
  assert.equal(session.thread.tasks.get("t9")!.startedAt, undefined);
  assert.equal(storage.getItem("cchub.taskTimes"), null);
});

// ---- 窗格和后退 / 前进 ----

test("窗格记在本地，不认识的值不用；关上就删掉", () => {
  storage.setItem("cchub.pane", "nope");
  assert.equal(new Store(fakeHub().hub).pane, null);
  const store = new Store(fakeHub().hub);
  store.openPane("tasks");
  assert.equal(storage.getItem("cchub.pane"), "tasks");
  assert.equal(new Store(fakeHub().hub).pane, "tasks");
  store.togglePane("tasks");
  assert.equal(store.pane, null);
  assert.equal(storage.getItem("cchub.pane"), null);
});

test("后退 / 前进：在看过的会话之间来回，跳过已关闭的；走到新位置就丢掉前进那一截", () => {
  const hub = fakeHub();
  const store = new Store(hub.hub);
  hub.emit({ type: "sessions", sessions: ["a", "b", "c"].map((id) => sessionInfo(id, false)), mem_available_mb: null });
  for (const id of ["a", "b", "b", "c"]) store.select(id);
  const back = () => (store.go(-1), store.selected);
  assert.equal(back(), "b", "连续重复的只记一次");
  assert.equal(back(), "a");
  assert.equal(back(), null, "最早是新会话页");
  assert.equal(store.canGo(-1), false);
  store.go(1);
  assert.equal(store.selected, "a");
  store.select("c");
  assert.equal(store.canGo(1), false);
  store.select("b");
  store.archive(store.sessions.get("c")!);
  assert.equal(back(), "a", "已关闭的跳过");
});

test("后退历史最多记 50 个位置", () => {
  const hub = fakeHub();
  const store = new Store(hub.hub);
  const ids = Array.from({ length: 60 }, (_, i) => `s${i}`);
  hub.emit({ type: "sessions", sessions: ids.map((id) => sessionInfo(id, false)), mem_available_mb: null });
  for (const id of ids) store.select(id);
  let steps = 0;
  while (store.canGo(-1)) {
    store.go(-1);
    steps++;
  }
  assert.equal(steps, 49);
  assert.equal(store.selected, "s10");
});

// ---- 拖入文件和选工作区的挂载 ----

const PROJECT = "/mnt/laptop/d/proj";

test("拖入文件：项目内的换成相对路径；项目外的先挂载所在目录（同一目录只挂一次），挂上后换成服务器路径", () => {
  const { store, hub } = setup();
  store.dropFiles("s1", ["D:\\proj\\src\\a.ts", "D:\\notes\\x.md", "D:\\notes\\y.md", "D:\\other\\z.txt", "D:\\root.txt"], PROJECT);
  assert.deepEqual(hub.of("mount"), [
    { type: "mount", device: "laptop", path: "D:\\notes" },
    { type: "mount", device: "laptop", path: "D:\\other" },
  ]);
  assert.deepEqual(store.files("s1"), [
    { path: "src/a.ts", reachable: true },
    { path: "D:\\notes\\x.md", reachable: false, pending: true },
    { path: "D:\\notes\\y.md", reachable: false, pending: true },
    { path: "D:\\other\\z.txt", reachable: false, pending: true },
    { path: "D:\\root.txt", reachable: false },
  ]);
  store.dropFiles("s1", ["D:\\proj\\src\\a.ts"], PROJECT);
  assert.equal(store.files("s1").length, 5, "同一个文件不重复加");

  hub.emit({ type: "mounted", device: "laptop", path: "D:\\notes", cwd: "/mnt/laptop/d/notes/", error: null });
  hub.emit({ type: "mounted", device: "laptop", path: "D:\\other", cwd: null, error: "设备离线" });
  assert.deepEqual(store.files("s1"), [
    { path: "src/a.ts", reachable: true },
    { path: "/mnt/laptop/d/notes/x.md", reachable: true },
    { path: "/mnt/laptop/d/notes/y.md", reachable: true },
    { path: "D:\\other\\z.txt", reachable: false, error: "设备离线" },
    { path: "D:\\root.txt", reachable: false },
  ]);
  assert.equal(store.cwd, "", "为文件挂的目录不切换工作区");
  assert.equal(store.takeFiles("s1").length, 5);
  assert.deepEqual(store.files("s1"), []);
});

test("两个输入框拖入同一目录的文件：只挂一次，结果各自套上", () => {
  const { store, hub } = setup();
  store.dropFiles("s1", ["D:\\notes\\x.md"], PROJECT);
  store.dropFiles("", ["D:\\notes\\y.md"], PROJECT);
  assert.equal(hub.of("mount").length, 1);
  hub.emit({ type: "mounted", device: "laptop", path: "D:\\notes", cwd: "/mnt/laptop/d/notes", error: null });
  assert.deepEqual(store.files("s1"), [{ path: "/mnt/laptop/d/notes/x.md", reachable: true }]);
  assert.deepEqual(store.files(""), [{ path: "/mnt/laptop/d/notes/y.md", reachable: true }]);
});

test("选工作区时挂载设备目录：挂上就选中并记住，失败显示原因", () => {
  const { store, hub } = setup();
  store.openWorkspace();
  store.mount("laptop", "D:\\proj");
  assert.equal(store.mounting, true);
  hub.emit({ type: "mounted", device: "laptop", path: "D:\\proj", cwd: PROJECT, error: null });
  assert.equal(store.mounting, false);
  assert.equal(store.cwd, PROJECT);
  assert.equal(store.showWorkspace, false);
  assert.equal(storage.getItem("cchub.cwd"), PROJECT);
  store.mount("laptop", "D:\\gone");
  hub.emit({ type: "mounted", device: "laptop", path: "D:\\gone", cwd: null, error: null });
  assert.equal(store.mountError, "挂载失败");
  assert.equal(store.cwd, PROJECT);
});

// ---- 服务器负载 ----

test("服务器负载：平时不轮询，连上和刷新会话列表（回到窗口时）顺带问一次", async () => {
  const { store, hub } = setup();
  store.refresh();
  assert.equal(hub.of("host_load").length, 0, "没连上不问");
  await store.connect("ws://hub");
  assert.equal(hub.of("host_load").length, 1, "连上时和会话列表一起问");
  store.refresh();
  assert.equal(hub.of("host_load").length, 2, "刷新会话列表时也问");
});

test("服务器负载：旧 hubd 不认识这个请求时不报错、不再问，重连后再试一次", async () => {
  const { store, hub } = setup();
  await store.connect("ws://hub");
  assert.equal(hub.of("host_load").length, 1);
  hub.emit({ type: "error", session: null, message: "无法解析消息：unknown variant `host_load`, expected one of `start`" });
  assert.equal(store.error, null);
  assert.equal(store.hostLoad.unsupported, true);
  store.requestHostLoad();
  store.refresh();
  assert.equal(hub.of("host_load").length, 1, "不再问");
  await store.connect("ws://hub");
  assert.equal(hub.of("host_load").length, 2, "重连的可能是升级过的 hubd");
});

test("服务器负载：收到统计记下结果和走势；失败时保留上一次的结果，不弹顶部错误", () => {
  const { store, hub } = setup();
  const load = { cpus: 2, cpu_permille: 500, load_x100: [100, 90, 80], mem_total_mb: 2000, mem_available_mb: 1000, sessions: [{ session: "s1", cpu_permille: 300, mem_mb: 250 }], others: [] };
  hub.emit({ type: "host_load", load, error: null });
  assert.deepEqual(store.hostLoad.load, load);
  assert.equal(store.hostLoad.history.length, 1);
  hub.emit({ type: "host_load", load: null, error: "读不了 /proc/stat" });
  assert.deepEqual(store.hostLoad.load, load);
  assert.equal(store.hostLoad.error, "读不了 /proc/stat");
  assert.equal(store.error, null);
});

// ---- 同步中（先显示本机缓存或回放历史，追上服务器之前）----

/** 把审批录制重放到第一个审批请求，返回那张卡片。 */
function replayToApproval(hub: ReturnType<typeof fakeHub>, session: Session) {
  const lines = recording("approval");
  const ask = lines.findIndex((line) => line.includes('"can_use_tool"'));
  lines.slice(1, ask + 1).forEach((line, i) => hub.emit(event("s1", i + 1, line)));
  const card = firstAsk(session.thread);
  assert.ok(card, "录制里有审批卡片");
  return card;
}

test("同步中：订阅回了 attached 进入，追上（synced）后退出", () => {
  const { hub, session } = setup();
  assert.equal(session.syncing, false);
  hub.emit({ type: "attached", session: "s1", live: 100 });
  assert.equal(session.syncing, true);
  assert.equal(session.live, 100);
  hub.emit({ type: "synced", session: "s1" });
  assert.equal(session.syncing, false);
});

test("同步中卡片不能回复（按钮和快捷键都走这里），追上后照常", () => {
  const { store, hub, session } = setup();
  hub.emit({ type: "attached", session: "s1", live: 100 });
  const card = replayToApproval(hub, session);
  store.allow(session, card);
  store.deny(session, card, "不行");
  assert.equal(hub.replies().length, 0, "可能早就在别处回答过了");
  assert.equal(card.sent, false);
  hub.emit({ type: "synced", session: "s1" });
  store.allow(session, card);
  assert.equal(hub.replies().length, 1);
});

test("旧 hubd 不发 attached：不进同步中，卡片照常能回（否则会一直锁着）", () => {
  const { store, hub, session } = setup();
  const card = replayToApproval(hub, session);
  assert.equal(session.syncing, false);
  store.allow(session, card);
  assert.equal(hub.replies().length, 1);
});

test("reset：清空这个会话已显示的内容，等重新回放", () => {
  const { hub, session } = setup();
  hub.emit({ type: "attached", session: "s1", live: 100 });
  replayToApproval(hub, session);
  assert.ok(session.thread.items.length > 0);
  hub.emit({ type: "reset", session: "s1" });
  assert.equal(session.thread.items.length, 0);
  assert.equal(firstAsk(session.thread), undefined);
  assert.equal(session.syncing, true, "客户端已经从头重订，等它的 attached 和事件");
});

// ---- 本机缓存（设置里的面板）----

test("本机缓存面板：打开时查位置和占用，清空后更新", async () => {
  const { store, hub } = setup();
  hub.onCache(async (op) => ({ path: "D:\\cache", bytes: op === "clear" ? 0 : 2048, movable: true }));
  store.openCache();
  await settle();
  assert.equal(store.cache.open, true);
  assert.deepEqual(store.cache.info, { path: "D:\\cache", bytes: 2048, movable: true });
  store.clearCache();
  await settle();
  assert.equal(store.cache.info?.bytes, 0);
  assert.deepEqual(hub.cacheCalls.map((c) => c.op), ["info", "clear"]);
});

test("改缓存位置失败：位置不变，显示原因；成功后显示新位置", async () => {
  const { store, hub } = setup();
  hub.onCache(async (op, dir) => {
    if (op === "move" && dir === "E:\\busy") throw "新位置里已有别的文件，请换一个空文件夹或还不存在的路径";
    return { path: op === "move" ? dir : "D:\\cache", bytes: 10, movable: true };
  });
  store.openCache();
  await settle();
  store.moveCache("E:\\busy");
  await settle();
  assert.equal(store.cache.info?.path, "D:\\cache");
  assert.match(store.cache.error ?? "", /已有别的文件/);
  store.moveCache("E:\\cchub-cache");
  await settle();
  assert.equal(store.cache.info?.path, "E:\\cchub-cache");
  assert.equal(store.cache.error, null);
});
