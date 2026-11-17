// 侧边栏的分组、排序和相对时间。运行：node --test web/test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { assignDeviceColors, DEVICE_COLORS, formatAgo, groupDevices, groupProjects, recentSessions, SERVER_GROUP } from "../src/sidebar.ts";

test("设备颜色：按名字排序依次分配，前五台不撞色，重复的名字只算一次", () => {
  const colors = assignDeviceColors(["mac", "pc", "laptop", "mac"]);
  assert.deepEqual([...colors].sort(), [["laptop", 0], ["mac", 1], ["pc", 2]]);
  const six = assignDeviceColors(["a", "b", "c", "d", "e", "f"]);
  assert.equal(new Set([...six.values()].slice(0, DEVICE_COLORS.length)).size, DEVICE_COLORS.length);
  assert.equal(six.get("f"), 0);
});

const s = (id: string, cwd: string | undefined, updated: number) => ({ id, title: `t-${id}`, cwd, updated });

test("按设备分段：段按最新会话排序，段内按项目分组，服务器本地目录和没有 cwd 的归“服务器”", () => {
  const sections = groupDevices([
    s("1", "/mnt/pc/d/app", 100),
    s("2", "/mnt/mac/Users/me/web", 300),
    s("3", "/root/notes", 200),
    s("4", undefined, 50),
    s("5", "/mnt/pc/d/lib", 150),
  ]);
  assert.deepEqual(sections.map((d) => d.device), ["mac", SERVER_GROUP, "pc"]);
  assert.deepEqual(sections[2]!.projects.map((g) => g.project), ["lib", "app"]);
  assert.deepEqual(sections[1]!.projects.map((g) => g.project), ["notes", SERVER_GROUP]);
});

test("设备分段里不同设备的同名项目不带后缀，同一设备的同名项目带上级目录", () => {
  const sections = groupDevices([
    s("1", "/mnt/pc/d/app", 300),
    s("2", "/mnt/mac/app", 200),
    s("3", "/mnt/pc/e/work/app", 100),
  ]);
  assert.deepEqual(sections.map((d) => [d.device, d.projects.map((g) => [g.project, g.device])]), [
    ["pc", [["app", "d"], ["app", "e/work"]]],
    ["mac", [["app", ""]]],
  ]);
});

test("按完整 cwd 分组，组按最新会话排序，组内按时间倒序", () => {
  const groups = groupProjects([
    s("a1", "/mnt/pc/a", 100),
    s("b1", "/mnt/pc/b", 300),
    s("a2", "/mnt/pc/a", 200),
    s("b2", "/mnt/pc/b", 50),
    s("c1", "/mnt/pc/c", 250),
  ]);
  assert.deepEqual(groups.map((g) => g.key), ["/mnt/pc/b", "/mnt/pc/c", "/mnt/pc/a"]);
  assert.deepEqual(groups.map((g) => g.project), ["b", "c", "a"]);
  assert.deepEqual(groups[0]!.sessions.map((x) => x.id), ["b1", "b2"]);
  assert.deepEqual(groups[2]!.sessions.map((x) => x.id), ["a2", "a1"]);
});

test("只有同名项目出现在不同设备时才带设备名", () => {
  const groups = groupProjects([
    s("1", "/mnt/pc/app", 300),
    s("2", "/mnt/mac/app", 200),
    s("3", "/mnt/pc/solo", 100),
  ]);
  assert.deepEqual(groups.map((g) => [g.project, g.device]), [["app", "pc"], ["app", "mac"], ["solo", ""]]);
});

test("没有 cwd 的会话归到“服务器”组", () => {
  const groups = groupProjects([s("1", undefined, 10), s("2", "/mnt/pc/a", 5)]);
  assert.equal(SERVER_GROUP, "服务器");
  assert.deepEqual(groups.map((g) => [g.key, g.project, g.device]), [["", "服务器", ""], ["/mnt/pc/a", "a", ""]]);
});

test("最近列表按时间倒序，最多 10 条，带项目名", () => {
  const list = Array.from({ length: 12 }, (_, i) => s(`s${i}`, i === 11 ? undefined : "/mnt/pc/p", i * 10));
  const recent = recentSessions(list);
  assert.equal(recent.length, 10);
  assert.deepEqual(recent.map((r) => r.session.id).slice(0, 3), ["s11", "s10", "s9"]);
  assert.equal(recent[0]!.project, "服务器");
  assert.equal(recent[1]!.project, "p");
  assert.equal(recentSessions(list, 3).length, 3);
});

test("相对时间", () => {
  const now = 1_000_000;
  assert.equal(formatAgo(now - 10, now), "刚刚");
  assert.equal(formatAgo(now - 180, now), "3 分钟");
  assert.equal(formatAgo(now - 3600 * 2 - 5, now), "2 小时");
  assert.equal(formatAgo(now - 3600 * 30, now), "昨天");
  assert.equal(formatAgo(now - 86400 * 3 - 100, now), "3 天");
  assert.equal(formatAgo(now + 50, now), "刚刚");
});

test("排序按 active，缺失时退回 updated；updated 变化不影响顺序", () => {
  const a = (id: string, cwd: string, updated: number, active: number | null) => ({ id, title: id, cwd, updated, active });
  const list = [a("x1", "/mnt/pc/x", 900, 100), a("y1", "/mnt/pc/y", 100, 200), a("x2", "/mnt/pc/x", 50, null)];
  assert.deepEqual(groupProjects(list).map((g) => g.key), ["/mnt/pc/y", "/mnt/pc/x"]);
  assert.deepEqual(groupProjects(list)[1]!.sessions.map((x) => x.id), ["x1", "x2"]);
  assert.deepEqual(recentSessions(list).map((r) => r.session.id), ["y1", "x1", "x2"]);
  // 模型输出让 x1 的 updated 变大，顺序不变
  list[0]!.updated = 99999;
  assert.deepEqual(recentSessions(list).map((r) => r.session.id), ["y1", "x1", "x2"]);
});

test("按日期分组：今天 / 昨天 / 7 天内 / 更早，组内按时间倒序，空组不返回", async () => {
  const { groupByDate } = await import("../src/sidebar.ts");
  const noon = new Date(2026, 10, 11, 12, 0, 0).getTime() / 1000;
  const groups = groupByDate([
    { id: "a", updated: noon - 60 },
    { id: "b", updated: noon - 3600 },
    { id: "c", updated: noon - 86400 },
    { id: "d", updated: noon - 3 * 86400 },
    { id: "e", updated: noon - 30 * 86400 },
    { id: "f", updated: noon - 30 * 86400, active: noon - 10 },
  ], noon);
  assert.deepEqual(groups.map((g) => [g.label, g.sessions.map((s) => s.id)]), [["今天", ["f", "a", "b"]], ["昨天", ["c"]], ["7 天内", ["d"]], ["更早", ["e"]]]);
  assert.deepEqual(groupByDate([{ id: "x", updated: noon - 30 * 86400 }], noon).map((g) => g.label), ["更早"]);
});

const sess = (cwd: string | undefined, attached: boolean, deviceOnline: boolean, running = false) => ({ cwd, attached, deviceOnline, running });

test("设备列表：登记的设备全部列出，状态以登记表为准；没登记表时退回会话探测", async () => {
  const { deviceList } = await import("../src/sidebar.ts");
  const sessions = [
    sess("/mnt/office/d/a", true, true, true),
    sess("/mnt/office/d/a", false, true),
    sess("/mnt/office/d/b", true, false),
    sess("/mnt/laptop/x", true, false),
    sess("/mnt/nas/z", false, true),
    sess("/root/work", true, true),
    sess(undefined, true, true),
  ];
  const registry = [
    { name: "office", os: "windows", online: true },
    { name: "laptop", os: "macos", online: false },
    { name: "spare", os: "linux", online: false },
  ];
  const list = deviceList(registry, sessions);
  assert.deepEqual(list.map((d) => [d.name, d.state, d.os]), [
    // 登记表说在线，但有项目目录读不到：提示挂载有问题。
    ["office", "warn", "windows"],
    ["laptop", "offline", "macos"],
    // 没登记但有会话：按探测，没订阅就是未检测。
    ["nas", "unknown", null],
    ["spare", "offline", "linux"],
  ]);
  assert.deepEqual(list[0]!.projects, [
    { cwd: "/mnt/office/d/a", project: "a", sessions: 2, running: 1 },
    { cwd: "/mnt/office/d/b", project: "b", sessions: 1, running: 0 },
  ]);
  // 还没拿到登记表：只按会话探测。
  assert.deepEqual(deviceList(null, sessions).map((d) => [d.name, d.state]), [["office", "online"], ["laptop", "offline"], ["nas", "unknown"]]);
});
