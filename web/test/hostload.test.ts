import assert from "node:assert/strict";
import { test } from "node:test";
import type { HostLoad } from "../src/generated/HostLoad.ts";
import { agoText, applyHostLoad, chartPoints, emptyHostLoad, HISTORY_MS, isUnsupported, level, loadWarning, memoryPercent, memoryWarning, nearestPoint, percent, shareLevel } from "../src/hostload.ts";

const load = (extra: Partial<HostLoad> = {}): HostLoad => ({
  cpus: 2,
  cpu_permille: 968,
  load_x100: [1091, 1155, 981],
  mem_total_mb: 1967,
  mem_available_mb: 741,
  sessions: [],
  others: [],
  ...extra,
});

test("百分比和颜色分级：整台机器和额度条一样 60% 起偏黄、85% 起强调色", () => {
  assert.equal(percent(968), 97);
  assert.equal(Math.round(memoryPercent(load())), 62);
  assert.equal(memoryPercent(load({ mem_total_mb: 0 })), 0);
  assert.deepEqual([level(59), level(60), level(84), level(85)], ["", "mid", "mid", "high"]);
  assert.deepEqual([shareLevel(149), shareLevel(150), shareLevel(300)], ["", "mid", "high"]);
});

test("负载到核数 2 倍、可用内存不到 300 MB 时提醒", () => {
  assert.equal(loadWarning(load()), "负载是核数的 5 倍，回复会明显变慢");
  assert.equal(loadWarning(load({ load_x100: [390, 100, 100] })), null);
  assert.equal(memoryWarning(load()), null);
  assert.equal(memoryWarning(load({ mem_available_mb: 141 })), "可用不到 300 MB，再开会话可能起不来");
});

test("收到统计：走势图加一个点，只留 10 分钟；失败时保留上一次的结果", () => {
  let state = applyHostLoad(emptyHostLoad(), load(), null, 1_000_000);
  state = applyHostLoad(state, load({ cpu_permille: 500 }), null, 1_000_000 + HISTORY_MS);
  assert.equal(state.history.length, 1, "10 分钟前的点丢掉");
  assert.equal(state.history[0].cpu, 50);
  const failed = applyHostLoad(state, null, "读不了 /proc/stat", 1_000_000 + HISTORY_MS + 5000);
  assert.equal(failed.load, state.load);
  assert.equal(failed.error, "读不了 /proc/stat");
  assert.equal(failed.history.length, 1);
});

test("旧 hubd 不认识 host_load 的报错认得出来，别的报错不算", () => {
  assert.ok(isUnsupported("无法解析消息：unknown variant `host_load`, expected one of `start`, `list`"));
  assert.ok(!isUnsupported("无法解析消息：unknown variant `usage`, expected one of `start`"));
  assert.ok(!isUnsupported("启动失败"));
});

test("走势图按时间放点：右边是最新一次，左边是 10 分钟前", () => {
  const now = 10 * HISTORY_MS;
  const history = [
    { at: now - HISTORY_MS / 2, cpu: 40, mem: 120 },
    { at: now, cpu: 100, mem: 60 },
  ];
  assert.equal(chartPoints(history, "cpu", now), "150.0,60.0 300.0,0.0");
  assert.equal(chartPoints(history, "mem", now), "150.0,0.0 300.0,40.0", "超过 100% 的按 100% 画");
  assert.equal(nearestPoint(history, 0.1, now), 0);
  assert.equal(nearestPoint(history, 0.9, now), 1);
  assert.equal(nearestPoint([], 0.5, now), -1);
  assert.deepEqual([agoText(2000), agoText(35_000), agoText(125_000)], ["现在", "35 秒前", "2 分 5 秒前"]);
});
