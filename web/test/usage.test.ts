// 使用情况窗格的统计：解析、按范围截取、汇总、连续天数、排行、每日序列、热力图。运行：node --test web/test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, dailySeries, heatmap, modelLabel, parseUsage, summarize, type UsageDay } from "../src/usage.ts";

const day = (date: string, messages: number, extra: Partial<UsageDay> = {}): UsageDay => ({
  date,
  messages,
  sessions: 1,
  input: 1,
  output: 10,
  cacheWrite: 100,
  cacheRead: 1000,
  models: { "claude-opus-5-5": 111 },
  projects: { "/mnt/pc/d/a": messages },
  hours: Array.from({ length: 24 }, (_, h) => (h === 9 ? messages : 0)),
  ...extra,
});

test("解析：版本不对、格式不对时返回 null", () => {
  assert.equal(parseUsage("not json"), null);
  assert.equal(parseUsage(JSON.stringify({ version: 2, days: [] })), null);
  assert.equal(parseUsage(JSON.stringify({ version: 1 })), null);
  const ok = parseUsage(JSON.stringify({ version: 1, generatedAt: 1, tzOffset: 480, days: [day("2026-11-10", 3)] }));
  assert.equal(ok?.days.length, 1);
});

test("日期加减跨月、跨年", () => {
  assert.equal(addDays("2026-11-01", -1), "2026-10-31");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("模型名：claude-opus-5-5 → Opus 5.5，带日期的去掉日期，认不出的原样", () => {
  assert.equal(modelLabel("claude-opus-5-5"), "Opus 5.5");
  assert.equal(modelLabel("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(modelLabel("gpt-x"), "gpt-x");
  assert.equal(modelLabel(""), "未知");
});

test("汇总：范围内的会话、回复、token、活跃天数、高峰时段，连续天数按全部数据到今天或昨天为止", () => {
  const days = [
    day("2026-10-01", 5),
    day("2026-11-07", 2),
    day("2026-11-09", 4, { hours: Array.from({ length: 24 }, (_, h) => (h === 21 ? 4 : 0)) }),
    day("2026-11-10", 6),
  ];
  const s = summarize(days, "7d", "2026-11-11");
  assert.equal(s.sessions, 3);
  assert.equal(s.messages, 12);
  assert.equal(s.tokens, 3 * 111);
  assert.equal(s.activeDays, 3);
  // 今天还没用，从昨天往前数：11-10、11-09 连续，11-08 断开。
  assert.equal(s.streak, 2);
  // 9 点 2+6=8 条，21 点 4 条。
  assert.equal(s.peakHour, 9);
  assert.equal(summarize(days, "all", "2026-11-11").messages, 17);
  // 昨天和今天都没用，连续天数为 0。
  assert.equal(summarize(days, "all", "2026-11-13").streak, 0);
  assert.equal(summarize([], "7d", "2026-11-11").peakHour, null);
});

test("排行：模型按 token、项目按回复数排序，占比相对总数", () => {
  const days = [
    day("2026-11-10", 6, { models: { "claude-opus-5-5": 300, "claude-haiku-5-5": 100 }, projects: { "/mnt/pc/d/a": 2, "/mnt/pc/d/b": 4 } }),
    day("2026-11-11", 2, { models: { "claude-haiku-5-5": 100 }, projects: { "": 2 } }),
  ];
  const s = summarize(days, "all", "2026-11-11");
  assert.deepEqual(s.models.map((m) => [m.name, m.tokens, m.share]), [["Opus 5.5", 300, 0.6], ["Haiku 5.5", 200, 0.4]]);
  assert.deepEqual(s.projects.map((p) => [p.name, p.messages]), [["b", 4], ["a", 2], ["未知", 2]]);
});

test("每日序列：7 天补齐空白日，前 3 个模型以外并入“其他”；“全部”按周（周一开始）合并", () => {
  const models = { "claude-opus-5-5": 50, "claude-sonnet-5-5": 40, "claude-haiku-5-5": 30, "claude-fable-5-2": 20 };
  const days = [day("2026-11-09", 1, { models }), day("2026-11-11", 1, { models: { "claude-opus-5-5": 10 } })];
  const week = dailySeries(days, "7d", "2026-11-11");
  assert.equal(week.bars.length, 7);
  assert.equal(week.bars[0].label, "2026-11-05");
  assert.deepEqual(week.keys, ["Opus 5.5", "Sonnet 5.5", "Haiku 5.5", "其他"]);
  assert.deepEqual(week.bars[4].values, { "Opus 5.5": 50, "Sonnet 5.5": 40, "Haiku 5.5": 30, 其他: 20 });
  assert.equal(week.bars[4].total, 140);
  assert.equal(week.bars[5].total, 0);
  // 2026-11-09 是周一：两天落在同一周。
  const all = dailySeries(days, "all", "2026-11-11");
  assert.equal(all.bars.length, 1);
  assert.equal(all.bars[0].label, "2026-11-09");
  assert.equal(all.bars[0].total, 150);
});

test("热力图：按周排成列（周一在上），分 0～4 档，今天以后的格子不显示", () => {
  const days = [day("2026-11-09", 1), day("2026-11-10", 4), day("2026-11-11", 8)];
  const weeks = heatmap(days, "2026-11-11", 2);
  assert.equal(weeks.length, 2);
  assert.equal(weeks[1][0]?.date, "2026-11-09");
  assert.deepEqual(weeks[1].slice(0, 3).map((c) => c?.level), [1, 2, 4]);
  assert.equal(weeks[1][3], null);
  assert.equal(weeks[0][0]?.date, "2026-11-02");
  assert.equal(weeks[0][0]?.level, 0);
});
