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
