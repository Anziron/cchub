// 后退 / 前进的历史和窗格名。Store 里的配合见 store.test.ts。
import assert from "node:assert/strict";
import { test } from "node:test";
import { asPane, History } from "../src/nav.ts";

const all = () => true;

test("走到新位置丢掉前进那一截，连续重复的只记一次", () => {
  const history = new History();
  for (const id of ["a", "b", "b", "c"]) history.remember(id);
  assert.equal(history.go(-1, all), "b");
  assert.equal(history.go(-1, all), "a");
  history.remember("d");
  assert.equal(history.canGo(1, all), false);
  assert.equal(history.go(-1, all), "a");
  assert.equal(history.go(-1, all), null, "最早是新会话页");
  assert.equal(history.go(-1, all), undefined, "到头了");
});

test("去不了的会话（已关闭、不存在）跳过；新会话页总能去", () => {
  const history = new History();
  for (const id of ["a", "gone", "b"]) history.remember(id);
  const open = (id: string) => id !== "gone";
  assert.equal(history.go(-1, open), "a");
  assert.equal(history.go(1, open), "b");
  assert.equal(history.go(1, open), undefined);
  assert.equal(history.go(-1, () => false), null);
});

test("最多记 50 个位置", () => {
  const history = new History();
  for (let i = 0; i < 60; i++) history.remember(`s${i}`);
  let steps = 0;
  while (history.go(-1, all) !== undefined) steps++;
  assert.equal(steps, 49);
});

test("本地存的窗格名不认识就不用", () => {
  assert.equal(asPane("tasks"), "tasks");
  assert.equal(asPane("nope"), null);
  assert.equal(asPane(""), null);
});
