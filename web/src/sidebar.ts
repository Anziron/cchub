// 侧边栏的分组、排序和相对时间：纯函数，不依赖 React。时间戳都是秒。

export const SERVER_GROUP = "服务器";

// 与 store.ts 的 describeCwd 同规则；store 依赖浏览器环境，纯函数测试里不能 import。
function describeCwd(cwd: string): { project: string; device: string } {
  const parts = cwd.split("/").filter(Boolean);
  return { project: parts[parts.length - 1] ?? "/", device: parts[0] === "mnt" && parts[1] ? parts[1] : SERVER_GROUP };
}

export interface RowSession {
  id: string;
  cwd?: string;
  updated: number;
  /** 最后一次用户发言时间；排序用，没有时退回 `updated`。 */
  active?: number | null;
}

export interface ProjectGroupData<T extends RowSession> {
  /** 分组键：完整 cwd，没有 cwd 时为空串。 */
  key: string;
  project: string;
  /** 只在同名项目冲突时有值。 */
  device: string;
  sessions: T[];
}

/** 排序键：只随用户发言变化，模型输出不影响顺序。 */
export const sortKey = (s: RowSession) => s.active ?? s.updated;

const byTime = (a: RowSession, b: RowSession) => sortKey(b) - sortKey(a);

/** 按完整 cwd 分组；组按组内最新会话倒序，组内按时间倒序。 */
export function groupProjects<T extends RowSession>(sessions: T[]): ProjectGroupData<T>[] {
  const map = new Map<string, T[]>();
  for (const session of [...sessions].sort(byTime)) {
    const key = session.cwd ?? "";
    map.set(key, [...(map.get(key) ?? []), session]);
  }
  const groups = [...map].map(([key, list]) => ({ key, project: key ? describeCwd(key).project : SERVER_GROUP, device: "", sessions: list }));
  const count = new Map<string, number>();
  for (const g of groups) count.set(g.project, (count.get(g.project) ?? 0) + 1);
  for (const g of groups) if (g.key && (count.get(g.project) ?? 0) > 1) g.device = describeCwd(g.key).device;
  return groups.sort((a, b) => byTime(a.sessions[0]!, b.sessions[0]!));
}

/** 所有会话按时间倒序，最多 limit 条，附项目名。 */
export function recentSessions<T extends RowSession>(sessions: T[], limit = 10): { session: T; project: string }[] {
  return [...sessions].sort(byTime).slice(0, limit).map((session) => ({ session, project: session.cwd ? describeCwd(session.cwd).project : SERVER_GROUP }));
}

/** 相对时间：刚刚 / N 分钟 / N 小时 / 昨天 / N 天。 */
export function formatAgo(updated: number, now: number): string {
  const sec = Math.max(0, now - updated);
  if (sec < 60) return "刚刚";
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时`;
  if (sec < 172800) return "昨天";
  return `${Math.floor(sec / 86400)} 天`;
}

export interface DateGroupData<T extends RowSession> {
  key: string;
  label: string;
  sessions: T[];
}

/** 按最后发言时间分组：今天 / 昨天 / 7 天内 / 更早（按本地日期算）。空组不返回。 */
export function groupByDate<T extends RowSession>(sessions: T[], now: number): DateGroupData<T>[] {
  const today = new Date(now * 1000);
  today.setHours(0, 0, 0, 0);
  const start = today.getTime() / 1000;
  const groups: DateGroupData<T>[] = [
    { key: "#today", label: "今天", sessions: [] },
    { key: "#yesterday", label: "昨天", sessions: [] },
    { key: "#week", label: "7 天内", sessions: [] },
    { key: "#older", label: "更早", sessions: [] },
  ];
  for (const session of [...sessions].sort(byTime)) {
    const t = sortKey(session);
    const index = t >= start ? 0 : t >= start - 86400 ? 1 : t >= start - 6 * 86400 ? 2 : 3;
    groups[index].sessions.push(session);
  }
  return groups.filter((g) => g.sessions.length);
}

export interface OverviewStats {
  /** 近 7 天有用户发言的会话数。 */
  week: number;
  /** 这些会话涉及的项目（cwd）数。 */
  projects: number;
  running: number;
  /** 近 30 天会话最多的项目；并列时取最近用过的。 */
  top?: { project: string; count: number };
}

/** 新会话页的统计卡：只用会话列表里已有的时间和 cwd，不读会话记录。 */
export function overviewStats(sessions: (RowSession & { running: boolean })[], now: number): OverviewStats {
  const week = sessions.filter((s) => sortKey(s) >= now - 7 * 86400);
  const counts = new Map<string, number>();
  // 按时间倒序累计，Map 的插入顺序就是最近使用顺序，并列时先出现的胜出。
  for (const s of [...sessions].sort(byTime)) {
    if (sortKey(s) < now - 30 * 86400) break;
    const key = s.cwd ?? "";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let top: OverviewStats["top"];
  for (const [key, count] of counts) {
    if (!top || count > top.count) top = { project: key ? describeCwd(key).project : SERVER_GROUP, count };
  }
  return { week: week.length, projects: new Set(week.map((s) => s.cwd ?? "")).size, running: sessions.filter((s) => s.running).length, top };
}
