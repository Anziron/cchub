// 使用情况窗格的统计：解析、按范围截取、汇总、连续天数、排行、每日序列、热力图。运行：node --test web/test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, dailySeries, dayTokens, heatmap, hourlySeries, modelCost, modelLabel, parseUsage, previousParts, quotaPace, REQUESTS, summarize, type UsageDay } from "../src/usage.ts";

test("费用：按 API 标价估算，缓存写入按 1 小时价（输入的 2 倍）；带日期的 ID 也认；不认识的模型返回 null", () => {
  const M = 1_000_000;
  // Opus 5.5：输入 $4、输出 $20、缓存写入 $8、缓存读取 $0.20（每百万）。
  assert.equal(modelCost("claude-opus-5-5", [M, M, M, M]), 4 + 20 + 8 + 0.2);
  assert.equal(modelCost("claude-sonnet-5-5", [0, 0, 0, 10 * M]), 1);
  assert.equal(modelCost("claude-haiku-4-5-20251001", [M, 0, 0, 0]), 1);
  assert.equal(modelCost("claude-unknown-9", [M, M, M, M]), null);
});

const day = (date: string, messages: number, extra: Partial<UsageDay> = {}): UsageDay => ({
  date,
  messages,
  sessions: 1,
  input: 1,
  output: 10,
  cacheWrite: 100,
  cacheRead: 1000,
  models: { "claude-opus-5-5": [1, 10, 100, 1000] },
  projects: { "/mnt/pc/d/a": messages },
  hours: Array.from({ length: 24 }, (_, h) => (h === 9 ? messages : 0)),
  ...extra,
});

test("解析：版本不对、格式不对时返回 null", () => {
  assert.equal(parseUsage("not json"), null);
  assert.equal(parseUsage(JSON.stringify({ version: 1, days: [] })), null);
  assert.equal(parseUsage(JSON.stringify({ version: 2 })), null);
  const ok = parseUsage(JSON.stringify({ version: 2, generatedAt: 1, tzOffset: 480, days: [day("2026-11-10", 3)] }));
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
  assert.equal(s.tokens, 3 * 1111);
  assert.deepEqual(s.parts, { input: 3, output: 30, cacheWrite: 300, cacheRead: 3000 });
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
    day("2026-11-10", 6, { models: { "claude-opus-5-5": [100, 100, 50, 50], "claude-haiku-5-5": [50, 20, 20, 10] }, projects: { "/mnt/pc/d/a": 2, "/mnt/pc/d/b": 4 } }),
    day("2026-11-11", 2, { models: { "claude-haiku-5-5": [100, 0, 0, 0] }, projects: { "": 2 } }),
  ];
  const s = summarize(days, "all", "2026-11-11");
  assert.deepEqual(s.models.map((m) => [m.name, m.tokens, m.share]), [["Opus 5.5", 300, 0.6], ["Haiku 5.5", 200, 0.4]]);
  assert.deepEqual(s.projects.map((p) => [p.name, p.messages]), [["b", 4], ["a", 2], ["未知", 2]]);
});

test("项目用量：有 projectTokens 时按 token 排序，带各模型 token、折算费用和设备名", () => {
  const M = 1_000_000;
  const days = [
    day("2026-11-10", 6, { projects: { "/mnt/pc/d/a": 5, "/root/notes": 1 }, projectTokens: {
      "/mnt/pc/d/a": { "claude-sonnet-5-5": [0, 0, 0, M] },
      "/root/notes": { "claude-opus-5-5": [M, 0, 0, 0], "claude-haiku-5-5": [0, 0, 0, M] },
    } }),
    day("2026-11-11", 1, { projects: { "/mnt/pc/d/a": 1 }, projectTokens: { "/mnt/pc/d/a": { "claude-opus-5-5": [0, 0, 0, M] } } }),
  ];
  const s = summarize(days, "all", "2026-11-11");
  // a：2M token（1M Sonnet 缓存读 $0.1 + 1M Opus 缓存读 $0.2）；notes：2M token（Opus 输入 $4 + Haiku 缓存读 $0.01）。同量时先出现的在前。
  assert.deepEqual(s.projects.map((p) => [p.name, p.device, p.tokens, p.share, p.messages]), [["a", "pc", 2 * M, 0.5, 6], ["notes", undefined, 2 * M, 0.5, 1]]);
  assert.ok(Math.abs((s.projects[0].cost ?? 0) - 0.3) < 1e-9);
  assert.ok(Math.abs((s.projects[1].cost ?? 0) - 4.01) < 1e-9);
  // 各模型 token 按多到少，柱子按这个分段着色。
  assert.deepEqual(s.projects[1].models, [["claude-opus-5-5", M], ["claude-haiku-5-5", M]]);
});

test("每日序列：7 天补齐空白日，前 3 个模型以外并入“其他”；“全部”按周（周一开始）合并", () => {
  const models: UsageDay["models"] = { "claude-opus-5-5": [50, 0, 0, 0], "claude-sonnet-5-5": [0, 40, 0, 0], "claude-haiku-5-5": [0, 0, 30, 0], "claude-fable-5-2": [0, 0, 0, 20] };
  const days = [day("2026-11-09", 1, { models }), day("2026-11-11", 1, { models: { "claude-opus-5-5": [4, 3, 2, 1] } })];
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

test("四项：总量含缓存读取，明细按范围汇总，柱子带当天明细，模型堆叠按四项之和", () => {
  const days = [
    day("2026-11-10", 1, { input: 5, output: 6, cacheWrite: 7, cacheRead: 8, models: { "claude-opus-5-5": [5, 6, 7, 8] } }),
    day("2026-11-11", 1, { input: 1, output: 2, cacheWrite: 3, cacheRead: 4, models: { "claude-opus-5-5": [1, 2, 3, 4] } }),
  ];
  assert.equal(dayTokens(days[0]), 26);
  const s = summarize(days, "7d", "2026-11-11");
  assert.equal(s.tokens, 36);
  assert.deepEqual(s.parts, { input: 6, output: 8, cacheWrite: 10, cacheRead: 12 });
  assert.equal(s.models[0].tokens, 36);
  const week = dailySeries(days, "7d", "2026-11-11");
  assert.equal(week.bars[6].total, 10);
  assert.deepEqual(week.bars[6].parts, { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 });
  assert.equal(week.bars[0].total, 0);
  assert.deepEqual(week.bars[0].parts, { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
  // “全部”按周合并时明细也相加。
  assert.deepEqual(dailySeries(days, "all", "2026-11-11").bars[0].parts, { input: 6, output: 8, cacheWrite: 10, cacheRead: 12 });
});

test("热力图：按周排成列（周一在上），分 0～4 档，今天以后的格子不显示", () => {
  const days = [day("2026-11-09", 1), day("2026-11-10", 4), day("2026-11-11", 8)];
  const weeks = heatmap(days, "2026-11-11", 2);
  assert.equal(weeks.length, 2);
  assert.equal(weeks[1][0]?.date, "2026-11-09");
  assert.deepEqual(weeks[1].slice(0, 3).map((c) => c?.level), [1, 2, 4]);
  // 本周剩下的日子也占位（标成 future），表格是完整的，过一天补上一格。
  assert.deepEqual(weeks[1].slice(3).map((c) => [c.future, c.level]), [[true, 0], [true, 0], [true, 0], [true, 0]]);
  assert.equal(weeks[1][3].date, "2026-11-12");
  assert.equal(weeks[0][0]?.date, "2026-11-02");
  assert.equal(weeks[0][0]?.level, 0);
});

test("今天：汇总只算今天；柱状图 24 小时，token 按模型堆叠，请求是每小时回复数，没数据时全是 0", () => {
  const hourTokens = {
    "claude-opus-5-5": Array.from({ length: 24 }, (_, h) => (h === 14 ? 500 : 0)),
    "claude-haiku-5-5": Array.from({ length: 24 }, (_, h) => (h === 15 ? 20 : 0)),
  };
  const days = [day("2026-11-10", 5), day("2026-11-11", 3, {
    hours: Array.from({ length: 24 }, (_, h) => (h === 14 ? 2 : h === 15 ? 1 : 0)),
    models: { "claude-opus-5-5": [0, 500, 0, 0], "claude-haiku-5-5": [0, 20, 0, 0] },
    hourTokens,
  })];
  const today = summarize(days, "today", "2026-11-11");
  assert.equal(today.messages, 3);
  assert.equal(today.activeDays, 1);
  const tokens = hourlySeries(days, "2026-11-11", "tokens");
  assert.deepEqual(tokens.keys, ["Opus 5.5", "Haiku 5.5"]);
  assert.equal(tokens.bars.length, 24);
  assert.deepEqual([tokens.bars[14].total, tokens.bars[14].values["Opus 5.5"]], [500, 500]);
  assert.deepEqual([tokens.bars[15].total, tokens.bars[15].values["Haiku 5.5"]], [20, 20]);
  const requests = hourlySeries(days, "2026-11-11", "requests");
  assert.deepEqual(requests.keys, [REQUESTS]);
  assert.deepEqual(requests.bars.map((b) => b.total).filter(Boolean), [2, 1]);
  assert.ok(hourlySeries(days, "2026-11-12", "tokens").bars.every((b) => b.total === 0));
});

test("请求次数：每天一根柱子，值是回复数；全部范围按周相加", () => {
  const days = [day("2026-11-09", 4), day("2026-11-11", 6)];
  const week = dailySeries(days, "7d", "2026-11-11", "requests");
  assert.deepEqual(week.keys, [REQUESTS]);
  assert.deepEqual(week.bars.map((b) => b.total), [0, 0, 0, 0, 4, 0, 6]);
  assert.equal(dailySeries(days, "all", "2026-11-11", "requests").bars[0].total, 10);
});

test("上期对比：7 天、30 天取紧挨着的前一段同样长的日子；今天、全部、上期没有数据时返回 null", () => {
  const big = { input: 2, output: 20, cacheWrite: 200, cacheRead: 2000 };
  // 本期 11-05～11-11，上期 10-29～11-04；10-28 不算。
  const days = [day("2026-10-28", 1, big), day("2026-10-29", 1), day("2026-11-04", 1, big), day("2026-11-05", 1)];
  assert.deepEqual(previousParts(days, "7d", "2026-11-11"), { input: 3, output: 30, cacheWrite: 300, cacheRead: 3000 });
  assert.equal(previousParts(days, "today", "2026-11-11"), null);
  assert.equal(previousParts(days, "all", "2026-11-11"), null);
  assert.equal(previousParts([day("2026-11-10", 1)], "7d", "2026-11-11"), null);
});

test("额度节奏：时间进度按窗口长度算；照当前速度在重置前用完时给出用完的时刻", () => {
  const H = 3600;
  // 5 小时窗口过去 1 小时（还剩 4 小时），已用 40% → 时间进度 20%，2.5 小时用完（窗口开始后）。
  const fast = quotaPace({ utilization: 0.4, resetsAt: 10 * H }, 5 * H, 6 * H);
  assert.equal(fast?.elapsed, 0.2);
  assert.equal(fast?.runsOut, 5 * H + 2.5 * H);
  // 已用 10%，过去 1 小时 → 10 小时才用完，超过重置时间，不提示。
  assert.equal(quotaPace({ utilization: 0.1, resetsAt: 10 * H }, 5 * H, 6 * H)?.runsOut, null);
  // 已经用完：用完时刻就是现在。
  assert.equal(quotaPace({ utilization: 1, resetsAt: 10 * H }, 5 * H, 6 * H)?.runsOut, 6 * H);
  // 刚开始（时间进度不到 5%）不预测，避免一两次请求就喊快用完。
  assert.equal(quotaPace({ utilization: 0.05, resetsAt: 10 * H }, 5 * H, 5 * H + 60)?.runsOut, null);
  // 窗口已过期：没有数据。
  assert.equal(quotaPace({ utilization: 0.5, resetsAt: 10 * H }, 5 * H, 11 * H), null);
});
