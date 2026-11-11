// 使用情况窗格：解析 `cchub-usage` 的输出并做汇总。纯函数，不依赖浏览器；日期都是客户端时区的 "YYYY-MM-DD"。

/** [input, output, cacheWrite, cacheRead]。 */
export type TokenQuad = [number, number, number, number];

export interface TokenParts {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface UsageDay {
  date: string;
  /** 去重后的模型回复数。 */
  messages: number;
  /** 当天有回复的主会话数（不含子代理）。 */
  sessions: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  /** 各模型的 [input, output, cacheWrite, cacheRead]。 */
  models: Record<string, TokenQuad>;
  /** 各项目目录的回复数；没有目录的是空串。 */
  projects: Record<string, number>;
  /** 每个本地小时的回复数，长度 24。 */
  hours: number[];
  /** 各模型每个本地小时的 token（四项之和），长度 24；旧版统计命令没有。 */
  hourTokens?: Record<string, number[]>;
}

/** 柱状图显示什么：按模型堆叠的 token，或请求（回复）次数。 */
export type UsageMetric = "tokens" | "requests";
export const REQUESTS = "请求";

export interface UsageStats {
  version: number;
  generatedAt: number;
  tzOffset: number;
  days: UsageDay[];
}

export type UsageRange = "today" | "7d" | "30d" | "all";

export const RANGE_DAYS: Record<Exclude<UsageRange, "all">, number> = { today: 1, "7d": 7, "30d": 30 };

export function parseUsage(text: string): UsageStats | null {
  try {
    const value = JSON.parse(text) as UsageStats;
    return value && value.version === 2 && Array.isArray(value.days) ? value : null;
  } catch {
    return null;
  }
}

const toTime = (date: string) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));
const fromTime = (time: number) => new Date(time).toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
  return fromTime(toTime(date) + days * 86400000);
}

/** 本地日期，和统计命令用同一个时区（发请求时传的是 `-getTimezoneOffset()`）。 */
export function localDate(now: Date): string {
  return fromTime(now.getTime() - now.getTimezoneOffset() * 60000);
}

/** 所在周的周一。 */
function weekStart(date: string): string {
  const weekday = (new Date(toTime(date)).getUTCDay() + 6) % 7;
  return addDays(date, -weekday);
}

/** `claude-opus-5-5` → `Opus 5.5`；带日期后缀的去掉日期。 */
export function modelLabel(id: string): string {
  if (!id) return "未知";
  const match = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/.exec(id);
  return match ? `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]}.${match[3]}` : id;
}

function projectLabel(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() ?? (cwd ? "/" : "未知");
}

/**
 * API 标价（美元 / 百万 token）：输入、输出、缓存读取。缓存写入按 1 小时 TTL 算（输入价的 2 倍）：
 * CLI 的会话记录里缓存写入几乎都是 1 小时的。订阅用户实际不按这个付费，只是折算参考。
 * 价格来自 2026-11 的官方价目，新模型上线要补。
 */
const PRICES: Record<string, [input: number, output: number, cacheRead: number]> = {
  "claude-fable-5-2": [8, 40, 0.2],
  "claude-mythos-5-2": [8, 40, 0.2],
  "claude-fable-5-1": [10, 50, 0.25],
  "claude-mythos-5-1": [10, 50, 0.25],
  "claude-fable-5": [10, 50, 1],
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-opus-5": [5, 25, 0.5],
  "claude-opus-4-8": [5, 25, 0.5],
  "claude-opus-4-7": [5, 25, 0.5],
  "claude-opus-4-6": [5, 25, 0.5],
  "claude-opus-4-5": [5, 25, 0.5],
  "claude-sonnet-5-5": [2, 10, 0.1],
  "claude-sonnet-5": [2, 10, 0.2],
  "claude-sonnet-4-6": [3, 15, 0.3],
  "claude-sonnet-4-5": [3, 15, 0.3],
  "claude-haiku-5-5": [0.1, 0.5, 0.01],
  "claude-haiku-4-5": [1, 5, 0.1],
};

/** 按标价折算的费用（美元）；不认识的模型返回 null。带日期后缀的 ID 去掉日期再查。 */
export function modelCost(id: string, quad: TokenQuad): number | null {
  const price = PRICES[id] ?? PRICES[id.replace(/-\d{8}$/, "")];
  if (!price) return null;
  const [input, output, cacheRead] = price;
  return (quad[0] * input + quad[1] * output + quad[2] * input * 2 + quad[3] * cacheRead) / 1_000_000;
}

/** 四项合计，含缓存读取。 */
export const dayTokens = (d: UsageDay) => d.input + d.output + d.cacheWrite + d.cacheRead;

export const quadTotal = (q: TokenQuad) => q[0] + q[1] + q[2] + q[3];

const emptyParts = (): TokenParts => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

function addParts(into: TokenParts, d: TokenParts) {
  into.input += d.input;
  into.output += d.output;
  into.cacheWrite += d.cacheWrite;
  into.cacheRead += d.cacheRead;
}

/** 这些天的四项明细汇总。 */
export function tokenParts(days: UsageDay[]): TokenParts {
  const parts = emptyParts();
  for (const d of days) addParts(parts, d);
  return parts;
}

function pick(days: UsageDay[], range: UsageRange, today: string): UsageDay[] {
  if (range === "all") return days;
  const from = addDays(today, 1 - RANGE_DAYS[range]);
  return days.filter((d) => d.date >= from && d.date <= today);
}

export interface Ranked {
  name: string;
  /** 原始键：模型 ID 或项目目录。 */
  key: string;
  share: number;
}

export interface UsageSummary {
  sessions: number;
  messages: number;
  /** 四项之和。 */
  tokens: number;
  /** 四项明细：输入、输出、缓存写入、缓存读取。 */
  parts: TokenParts;
  activeDays: number;
  /** 到今天（今天还没用就到昨天）为止连续有使用的天数，按全部数据算。 */
  streak: number;
  /** 回复最多的本地小时；没有数据时为 null。 */
  peakHour: number | null;
  /** `cost`：按标价折算的美元，不认识的模型为 null。 */
  models: (Ranked & { tokens: number; cost: number | null })[];
  projects: (Ranked & { messages: number })[];
}

function sumBy(days: UsageDay[], field: "models" | "projects"): Map<string, number> {
  const map = new Map<string, number>();
  for (const d of days) {
    for (const [key, value] of Object.entries(d[field])) {
      const amount = typeof value === "number" ? value : quadTotal(value);
      map.set(key, (map.get(key) ?? 0) + amount);
    }
  }
  return map;
}

/** 按值倒序；同值保持先出现的在前。 */
function ranked(map: Map<string, number>): [string, number, number][] {
  const total = [...map.values()].reduce((a, b) => a + b, 0);
  return [...map].sort((a, b) => b[1] - a[1]).map(([key, value]) => [key, value, total ? value / total : 0]);
}

export function summarize(days: UsageDay[], range: UsageRange, today: string): UsageSummary {
  const list = pick(days, range, today);
  const hours = Array.from({ length: 24 }, (_, h) => list.reduce((sum, d) => sum + (d.hours[h] ?? 0), 0));
  const peak = Math.max(...hours);
  // 各模型四项分别累加，算费用要用（不同项单价不同）。
  const quads = new Map<string, TokenQuad>();
  for (const d of list) {
    for (const [model, q] of Object.entries(d.models)) {
      const sum = quads.get(model) ?? [0, 0, 0, 0];
      for (let i = 0; i < 4; i += 1) sum[i] += q[i];
      quads.set(model, sum);
    }
  }
  const active = new Set(days.filter((d) => d.messages > 0).map((d) => d.date));
  let cursor = active.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (active.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return {
    sessions: list.reduce((sum, d) => sum + d.sessions, 0),
    messages: list.reduce((sum, d) => sum + d.messages, 0),
    tokens: list.reduce((sum, d) => sum + dayTokens(d), 0),
    parts: tokenParts(list),
    activeDays: list.filter((d) => d.messages > 0).length,
    streak,
    peakHour: peak > 0 ? hours.indexOf(peak) : null,
    models: ranked(sumBy(list, "models")).filter(([, tokens]) => tokens > 0).map(([key, tokens, share]) => ({ key, name: modelLabel(key), tokens, share, cost: modelCost(key, quads.get(key) ?? [0, 0, 0, 0]) })),
    projects: ranked(sumBy(list, "projects")).map(([key, messages, share]) => ({ key, name: projectLabel(key), messages, share })),
  };
}

export const OTHER = "其他";
const TOP_MODELS = 3;

export interface Bar {
  /** 这根柱子的起始日期（“全部”时是那一周的周一）。 */
  label: string;
  total: number;
  /** 这根柱子的四项明细。 */
  parts: TokenParts;
  values: Record<string, number>;
}

/** 按模型堆叠时的图例：用量前 3 的模型，其余并入“其他”。 */
function topModels(list: UsageDay[]): { top: string[]; keys: string[] } {
  const all = new Map([...sumBy(list, "models")].filter(([, n]) => n > 0));
  const top = ranked(all).slice(0, TOP_MODELS).map(([key]) => key);
  return { top, keys: [...top.map(modelLabel), ...(all.size > top.length ? [OTHER] : [])] };
}

/**
 * 每日用量柱状图：7 天、30 天按天补齐；“全部”按周合并。
 * token 按模型堆叠（前 3 个以外并入“其他”）；请求是每天的回复数。
 */
export function dailySeries(days: UsageDay[], range: UsageRange, today: string, metric: UsageMetric = "tokens"): { keys: string[]; bars: Bar[] } {
  const list = pick(days, range, today);
  const { top, keys } = metric === "requests" ? { top: [], keys: [REQUESTS] } : topModels(list);
  const bucket = range === "all" ? weekStart : (date: string) => date;
  const step = range === "all" ? 7 : 1;
  const first = range === "all" ? (list[0] ? weekStart(list[0].date) : weekStart(today)) : addDays(today, 1 - RANGE_DAYS[range]);
  const bars = new Map<string, Bar>();
  for (let date = first; date <= today; date = addDays(date, step)) {
    bars.set(date, { label: date, total: 0, parts: emptyParts(), values: Object.fromEntries(keys.map((k) => [k, 0])) });
  }
  for (const d of list) {
    const bar = bars.get(bucket(d.date));
    if (!bar) continue;
    addParts(bar.parts, d);
    if (metric === "requests") {
      bar.values[REQUESTS] += d.messages;
      bar.total += d.messages;
      continue;
    }
    for (const [model, quad] of Object.entries(d.models)) {
      const tokens = quadTotal(quad);
      const key = top.includes(model) ? modelLabel(model) : OTHER;
      bar.values[key] = (bar.values[key] ?? 0) + tokens;
      bar.total += tokens;
    }
  }
  return { keys, bars: [...bars.values()] };
}

/** “今天”的柱状图：24 个本地小时，`label` 是小时数。token 按模型堆叠（来自 `hourTokens`），请求是回复数。 */
export function hourlySeries(days: UsageDay[], today: string, metric: UsageMetric): { keys: string[]; bars: Bar[] } {
  const day = days.find((d) => d.date === today);
  const { top, keys } = metric === "requests" ? { top: [], keys: [REQUESTS] } : topModels(day ? [day] : []);
  const bars = Array.from({ length: 24 }, (_, h): Bar => {
    const bar: Bar = { label: String(h), total: 0, parts: emptyParts(), values: Object.fromEntries(keys.map((k) => [k, 0])) };
    if (metric === "requests") {
      bar.values[REQUESTS] = bar.total = day?.hours[h] ?? 0;
      return bar;
    }
    for (const [model, hours] of Object.entries(day?.hourTokens ?? {})) {
      const tokens = hours[h] ?? 0;
      if (!tokens) continue;
      const key = top.includes(model) ? modelLabel(model) : OTHER;
      bar.values[key] = (bar.values[key] ?? 0) + tokens;
      bar.total += tokens;
    }
    return bar;
  });
  return { keys, bars };
}

export interface HeatCell {
  date: string;
  value: number;
  /** 0 表示没有使用，1～4 按当期最大值分档。 */
  level: number;
  /** 还没到的日子（本周今天以后），只占位。 */
  future?: boolean;
}

/** 活跃热力图：最近 `weeks` 周，每列一周（周一在上），值是回复数；今天以后的格子是 null。 */
export function heatmap(days: UsageDay[], today: string, weeks: number): HeatCell[][] {
  const byDate = new Map(days.map((d) => [d.date, d.messages]));
  const start = addDays(weekStart(today), -7 * (weeks - 1));
  const columns: HeatCell[][] = [];
  let max = 0;
  for (let w = 0; w < weeks; w += 1) {
    const column: HeatCell[] = [];
    for (let i = 0; i < 7; i += 1) {
      const date = addDays(start, w * 7 + i);
      // 本周还没到的日子也占一格（空），表格始终完整，每过一天填上一格。
      if (date > today) {
        column.push({ date, value: 0, level: 0, future: true });
        continue;
      }
      const value = byDate.get(date) ?? 0;
      max = Math.max(max, value);
      column.push({ date, value, level: 0 });
    }
    columns.push(column);
  }
  for (const column of columns) for (const cell of column) if (cell && cell.value > 0) cell.level = Math.min(4, Math.ceil((4 * cell.value) / max));
  return columns;
}
