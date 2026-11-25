/** 服务器负载（hubd 的 `host_load`）：会话栏底部的一行和「服务器」窗格共用。纯逻辑，状态由 `store.ts` 持有。 */
import type { HostLoad } from "./generated/HostLoad.ts";

/** 页面看得见时多久问一次。 */
export const HOST_LOAD_REFRESH_MS = 5000;
/** 走势图显示多久。 */
export const HISTORY_MS = 10 * 60_000;
/** 可用内存低于这个数就提醒（hubd 默认低于 100 MB 时不再启动会话）。 */
export const LOW_MEMORY_MB = 300;

/** 走势图上的一个点：CPU 和内存都是百分比。 */
export interface LoadPoint {
  at: number;
  cpu: number;
  mem: number;
}

export interface HostLoadState {
  load: HostLoad | null;
  error: string | null;
  /** 服务器是不认识这个请求的旧版 hubd：不再问，会话栏照旧只显示可用内存。 */
  unsupported: boolean;
  /** 打开窗口以后的记录，只留最近 10 分钟，不存本地。 */
  history: LoadPoint[];
}

export const emptyHostLoad = (): HostLoadState => ({ load: null, error: null, unsupported: false, history: [] });

/** 千分比换成整数百分比。 */
export const percent = (permille: number): number => Math.round(permille / 10);

/** 内存已用的百分比：总量减去可用量（可回收的缓存不算已用）。 */
export function memoryPercent(load: HostLoad): number {
  if (!load.mem_total_mb) return 0;
  return ((load.mem_total_mb - load.mem_available_mb) / load.mem_total_mb) * 100;
}

/** 整台机器的颜色分级，和额度条一样：60% 起偏黄，85% 起强调色。 */
export function level(pct: number): "" | "mid" | "high" {
  return pct >= 85 ? "high" : pct >= 60 ? "mid" : "";
}

/** 单个会话或进程占整台机器的份额：15% 起偏黄，30% 起强调色（两个核的机器上就是一个核用了三成、六成）。 */
export function shareLevel(permille: number): "" | "mid" | "high" {
  return permille >= 300 ? "high" : permille >= 150 ? "mid" : "";
}

/** 收到一次统计：记下结果，走势图加一个点，丢掉 10 分钟以前的。失败时保留上一次的结果，同时显示错误。 */
export function applyHostLoad(state: HostLoadState, load: HostLoad | null, error: string | null, now = Date.now()): HostLoadState {
  if (!load) return { ...state, error: error ?? "服务器没有返回负载" };
  const point = { at: now, cpu: load.cpu_permille / 10, mem: memoryPercent(load) };
  const history = [...state.history.filter((p) => p.at > now - HISTORY_MS), point];
  return { load, error: null, unsupported: false, history };
}

/** 旧 hubd 不认识 `host_load` 时回的报错（见 ws.rs 的 `serve`、model.ts 的 `serverErrorText`）。 */
export function isUnsupported(message: string): boolean {
  return message.startsWith("无法解析消息：unknown variant `host_load`");
}

/** 负载乘 100 的整数，显示成一位小数。 */
export const formatLoad = (x100: number): string => (x100 / 100).toFixed(1);

/** 1 分钟平均负载到核数 2 倍以上时的提醒。 */
export function loadWarning(load: HostLoad): string | null {
  const ratio = (load.load_x100[0] ?? 0) / 100 / Math.max(1, load.cpus);
  return ratio >= 2 ? `负载是核数的 ${Math.round(ratio)} 倍，回复会明显变慢` : null;
}

export function memoryWarning(load: HostLoad): string | null {
  return load.mem_available_mb < LOW_MEMORY_MB ? `可用不到 ${LOW_MEMORY_MB} MB，再开会话可能起不来` : null;
}

/** 点在走势图上的横向位置（0–1）：右边是 `now`，左边是 10 分钟前。 */
export const chartX = (at: number, now: number): number => (at - (now - HISTORY_MS)) / HISTORY_MS;

/** 走势图折线的 `points`：画布 300 × 100，纵轴向下，所以取 100 减百分比。 */
export function chartPoints(history: LoadPoint[], key: "cpu" | "mem", now: number): string {
  return history
    .map((p) => `${(chartX(p.at, now) * 300).toFixed(1)},${(100 - Math.min(100, Math.max(0, p[key]))).toFixed(1)}`)
    .join(" ");
}

/** 离横向位置 `x`（0–1）最近的点，没有点时为 -1。 */
export function nearestPoint(history: LoadPoint[], x: number, now: number): number {
  let best = -1;
  history.forEach((p, i) => {
    if (best < 0 || Math.abs(chartX(p.at, now) - x) < Math.abs(chartX(history[best].at, now) - x)) best = i;
  });
  return best;
}

/** “几秒前”“几分几秒前”。 */
export function agoText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 5) return "现在";
  return seconds < 60 ? `${seconds} 秒前` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒前`;
}
