// 改动窗格的分组：项目内按相对目录，项目外归到“其他位置”。运行：node --test web/test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { groupChanges, type FileChange } from "../src/model.ts";

const f = (path: string, added = 1, removed = 0): FileChange => ({ path, added, removed, edits: [] });
const cwd = "/mnt/pc/d/app";

test("项目内按相对目录分组，根目录在前，目录按字母排，组内按文件名排", () => {
  const groups = groupChanges([
    f(`${cwd}/web/src/b.ts`, 3, 1),
    f(`${cwd}/README.md`),
    f(`${cwd}/web/src/a.ts`, 2, 2),
    f(`${cwd}/server/main.rs`),
  ], cwd);
  assert.deepEqual(groups.map((g) => [g.dir, g.outside]), [["", false], ["server/", false], ["web/src/", false]]);
  assert.deepEqual(groups[2]!.files.map((x) => x.name), ["a.ts", "b.ts"]);
  assert.deepEqual([groups[2]!.added, groups[2]!.removed], [5, 3]);
});

test("项目外的文件按完整目录分组，排在项目内的后面", () => {
  const groups = groupChanges([f("/root/.claude/plans/x.md"), f(`${cwd}/a.ts`), f("/mnt/pc/d/other/src/y.ts")], cwd);
  assert.deepEqual(groups.map((g) => [g.dir, g.outside]), [["", false], ["/mnt/pc/d/other/src/", true], ["/root/.claude/plans/", true]]);
});

test("没有工作区时全部按完整目录分组", () => {
  const groups = groupChanges([f("/a/b/c.ts")], undefined);
  assert.deepEqual(groups.map((g) => [g.dir, g.outside, g.files[0]!.name]), [["/a/b/", true, "c.ts"]]);
});

test("名字前缀相同的兄弟目录不算项目内", () => {
  const groups = groupChanges([f("/mnt/pc/d/app2/x.ts")], cwd);
  assert.equal(groups[0]!.outside, true);
});
