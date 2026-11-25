// 本地存储的读写兜底和几个纯函数。键名、格式和 Store 的配合见 store.test.ts。
import { storage } from "./fakeStore.ts";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { Task } from "../src/model.ts";
import { saved, savedModels, stampTaskTimes, withoutPending, withPending } from "../src/storage.ts";

beforeEach(() => storage.clear());

test("读不出来（没有、坏的 JSON、null）时用兜底值", () => {
  assert.deepEqual(saved.drafts.get(), {});
  storage.setItem("cchub.drafts", "{坏的");
  assert.deepEqual(saved.drafts.get(), {});
  storage.setItem("cchub.drafts", "null");
  assert.deepEqual(saved.drafts.get(), {});
  assert.equal(saved.view.get(), "home");
  assert.equal(saved.sideCollapsed.get(), false);
});

test("模型列表：存过就用存的，空的或不是数组就用内置的别名", () => {
  assert.equal(savedModels()[0].value, "default");
  storage.setItem("cchub.models", "[]");
  assert.equal(savedModels().length, 4);
  storage.setItem("cchub.models", '{"value":"opus"}');
  assert.equal(savedModels().length, 4);
  saved.models.set([{ value: "opus", displayName: "Opus 5.5" }]);
  assert.deepEqual(savedModels(), [{ value: "opus", displayName: "Opus 5.5" }]);
});

test("待定选择：同一会话合并，取走后别的会话不动", () => {
  let all = withPending({}, "a", { model: "opus" });
  all = withPending(all, "a", { effort: null });
  all = withPending(all, "b", { effort: "high" });
  assert.deepEqual(all, { a: { model: "opus", effort: null }, b: { effort: "high" } });
  const { pending, rest } = withoutPending(all, "a");
  assert.deepEqual(pending, { model: "opus", effort: null });
  assert.deepEqual(rest, { b: { effort: "high" } });
  const none = withoutPending(rest, "x");
  assert.equal(none.pending, undefined);
  assert.equal(none.rest, rest, "没有时原样返回，不用重写本地存储");
});

const task = (id: string, extra: Partial<Task> = {}) => ({ id, ...extra }) as Task;

test("任务开始时间：第一次看到还在跑的任务时记下，记过的直接套，已结束的不记", () => {
  const running = task("t1");
  const ended = task("t2", { endedAt: 50 });
  const known = task("t3");
  const times = { t3: 10 };
  const next = stampTaskTimes([running, ended, known], times, 99);
  assert.deepEqual(next, { t3: 10, t1: 99 });
  assert.equal(running.startedAt, 99);
  assert.equal(ended.startedAt, undefined);
  assert.equal(known.startedAt, 10);
  assert.deepEqual(times, { t3: 10 }, "不改传进来的记录");
  assert.equal(stampTaskTimes([task("t3")], times, 99), null, "没有新记的返回 null");
});

test("任务开始时间最多留 200 条，挤掉最早记下的", () => {
  const times = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`old${i}`, i + 1]));
  const next = stampTaskTimes([task("new")], times, 999)!;
  assert.equal(Object.keys(next).length, 200);
  assert.equal(next.old0, undefined);
  assert.equal(next.new, 999);
});
