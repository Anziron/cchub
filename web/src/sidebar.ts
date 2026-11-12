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

/** `warn`：Tailscale 在线，但有项目目录读不到（挂载断了）。 */
export type DeviceState = "online" | "offline" | "warn" | "unknown";

export const DEVICE_STATE: Record<DeviceState, string> = {
  online: "在线",
  offline: "离线",
  warn: "目录读不到",
  unknown: "未检测",
};

export interface DeviceProject {
  cwd: string;
  project: string;
  sessions: number;
  running: number;
}

export interface DeviceEntry {
  name: string;
  os: string | null;
  state: DeviceState;
  projects: DeviceProject[];
}

/**
 * 侧栏底部的设备：登记的设备全部列出，在线状态以 hubd 的登记表（Tailscale）为准；
 * 已订阅会话的挂载探测用来发现“设备在线但目录读不到”。还没拿到登记表时只按探测，没订阅的是“未检测”。
 * 在线的排前面，其余按名字。
 */
export function deviceList(
  registry: { name: string; os: string | null; online: boolean }[] | null,
  sessions: { cwd?: string; attached: boolean; deviceOnline: boolean; running: boolean }[],
): DeviceEntry[] {
  const probes = new Map<string, DeviceState>();
  const projects = new Map<string, Map<string, DeviceProject>>();
  for (const s of sessions) {
    const parts = (s.cwd ?? "").split("/").filter(Boolean);
    if (parts[0] !== "mnt" || !parts[1] || !s.cwd) continue;
    const device = parts[1];
    const prev = probes.get(device) ?? "unknown";
    const next: DeviceState = !s.attached ? "unknown" : s.deviceOnline ? "online" : "offline";
    // 有一个目录读不到就记下来；登记表说在线时据此提示挂载有问题。
    probes.set(device, prev === "offline" || next === "unknown" ? prev : next);
    const list = projects.get(device) ?? new Map<string, DeviceProject>();
    const p = list.get(s.cwd) ?? { cwd: s.cwd, project: parts[parts.length - 1], sessions: 0, running: 0 };
    p.sessions++;
    if (s.running) p.running++;
    list.set(s.cwd, p);
    projects.set(device, list);
  }
  const names = new Set([...(registry ?? []).map((d) => d.name), ...probes.keys()]);
  const entries = [...names].map((name): DeviceEntry => {
    const reg = registry?.find((d) => d.name === name);
    const probe = probes.get(name) ?? "unknown";
    let state: DeviceState;
    if (!reg) state = registry ? probe : probe === "offline" && hasOnlineProbe(sessions, name) ? "online" : probe;
    else state = !reg.online ? "offline" : probe === "offline" ? "warn" : "online";
    const list = [...(projects.get(name)?.values() ?? [])].sort((a, b) => a.cwd.localeCompare(b.cwd));
    return { name, os: reg?.os ?? null, state, projects: list };
  });
  const rank = (s: DeviceState) => (s === "online" || s === "warn" ? 0 : 1);
  return entries.sort((a, b) => rank(a.state) - rank(b.state) || a.name.localeCompare(b.name));
}

/** 没有登记表时沿用旧规则：同一设备有一个目录探测在线就算在线。 */
const hasOnlineProbe = (sessions: { cwd?: string; attached: boolean; deviceOnline: boolean }[], device: string) =>
  sessions.some((s) => s.attached && s.deviceOnline && s.cwd?.startsWith(`/mnt/${device}/`));
