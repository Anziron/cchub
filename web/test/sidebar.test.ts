// 侧边栏的分组、排序和相对时间。运行：node --test web/test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAgo, groupProjects, recentSessions, SERVER_GROUP } from "../src/sidebar.ts";

const s = (id: string, cwd: string | undefined, updated: number) => ({ id, title: `t-${id}`, cwd, updated });

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
