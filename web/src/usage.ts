// 使用情况窗格：解析 `cchub-usage` 的输出并做汇总。纯函数，不依赖浏览器；日期都是客户端时区的 "YYYY-MM-DD"。

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
  /** 各模型的 token（input + output + cache 写）。 */
  models: Record<string, number>;
  /** 各项目目录的回复数；没有目录的是空串。 */
  projects: Record<string, number>;
  /** 每个本地小时的回复数，长度 24。 */
  hours: number[];
}

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
    return value && value.version === 1 && Array.isArray(value.days) ? value : null;
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

export const dayTokens = (d: UsageDay) => d.input + d.output + d.cacheWrite;

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
  tokens: number;
  activeDays: number;
  /** 到今天（今天还没用就到昨天）为止连续有使用的天数，按全部数据算。 */
  streak: number;
  /** 回复最多的本地小时；没有数据时为 null。 */
  peakHour: number | null;
  models: (Ranked & { tokens: number })[];
  projects: (Ranked & { messages: number })[];
}

function sumBy(days: UsageDay[], field: "models" | "projects"): Map<string, number> {
  const map = new Map<string, number>();
  for (const d of days) for (const [key, value] of Object.entries(d[field])) map.set(key, (map.get(key) ?? 0) + value);
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
    activeDays: list.filter((d) => d.messages > 0).length,
    streak,
    peakHour: peak > 0 ? hours.indexOf(peak) : null,
    models: ranked(sumBy(list, "models")).map(([key, tokens, share]) => ({ key, name: modelLabel(key), tokens, share })),
    projects: ranked(sumBy(list, "projects")).map(([key, messages, share]) => ({ key, name: projectLabel(key), messages, share })),
  };
}

export const OTHER = "其他";
const TOP_MODELS = 3;

export interface Bar {
  /** 这根柱子的起始日期（“全部”时是那一周的周一）。 */
  label: string;
  total: number;
  values: Record<string, number>;
}

/** 每日用量柱状图：7 天、30 天按天补齐；“全部”按周合并。按模型堆叠，前 3 个以外并入“其他”。 */
export function dailySeries(days: UsageDay[], range: UsageRange, today: string): { keys: string[]; bars: Bar[] } {
  const list = pick(days, range, today);
  const top = ranked(sumBy(list, "models")).slice(0, TOP_MODELS).map(([key]) => key);
  const rest = sumBy(list, "models").size > top.length;
  const keys = [...top.map(modelLabel), ...(rest ? [OTHER] : [])];
  const bucket = range === "all" ? weekStart : (date: string) => date;
  const step = range === "all" ? 7 : 1;
  const first = range === "all" ? (list[0] ? weekStart(list[0].date) : weekStart(today)) : addDays(today, 1 - RANGE_DAYS[range]);
  const bars = new Map<string, Bar>();
  for (let date = first; date <= today; date = addDays(date, step)) {
    bars.set(date, { label: date, total: 0, values: Object.fromEntries(keys.map((k) => [k, 0])) });
  }
  for (const d of list) {
    const bar = bars.get(bucket(d.date));
    if (!bar) continue;
    for (const [model, tokens] of Object.entries(d.models)) {
      const key = top.includes(model) ? modelLabel(model) : OTHER;
      bar.values[key] = (bar.values[key] ?? 0) + tokens;
      bar.total += tokens;
    }
  }
  return { keys, bars: [...bars.values()] };
}

/** “今天”的柱状图：每个本地小时的回复数（统计里没有按小时的 token）。 */
export function hourlySeries(days: UsageDay[], today: string): number[] {
  const day = days.find((d) => d.date === today);
  return Array.from({ length: 24 }, (_, h) => day?.hours[h] ?? 0);
}

export interface HeatCell {
  date: string;
  value: number;
  /** 0 表示没有使用，1～4 按当期最大值分档。 */
  level: number;
}

/** 活跃热力图：最近 `weeks` 周，每列一周（周一在上），值是回复数；今天以后的格子是 null。 */
export function heatmap(days: UsageDay[], today: string, weeks: number): (HeatCell | null)[][] {
  const byDate = new Map(days.map((d) => [d.date, d.messages]));
  const start = addDays(weekStart(today), -7 * (weeks - 1));
  const columns: (HeatCell | null)[][] = [];
  let max = 0;
  for (let w = 0; w < weeks; w += 1) {
    const column: (HeatCell | null)[] = [];
    for (let i = 0; i < 7; i += 1) {
      const date = addDays(start, w * 7 + i);
      if (date > today) {
        column.push(null);
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
