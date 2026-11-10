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
}

export interface ProjectGroupData<T extends RowSession> {
  /** 分组键：完整 cwd，没有 cwd 时为空串。 */
  key: string;
  project: string;
  /** 只在同名项目冲突时有值。 */
  device: string;
  sessions: T[];
}

const byTime = (a: RowSession, b: RowSession) => b.updated - a.updated;

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
