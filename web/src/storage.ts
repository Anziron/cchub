/**
 * `store.ts` 的本地存储（localStorage 的 `cchub.*`）：键名、格式、读不出时的兜底都在这张表里。
 * 键名和格式是老用户数据的约定：要改就兼容旧值（`web/test/store.test.ts` 钉着现在的格式）。
 * 别的模块自己的键在各自文件里：外观 `appearance.ts`、宽度 `Resizer.tsx`、侧栏 `SessionList.tsx`、
 * 问候语 `Composer.tsx`、置顶 `TopBar.tsx`、使用情况 `UsagePane.tsx`；`demo.ts` 按地址参数改写其中一些。
 */
import type { ModelOption, PendingChoice, RateLimits, SlashCommand, Task } from "./model.ts";

function loadJson<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? "null") as T) ?? fallback;
  } catch {
    return fallback;
  }
}

const text = (key: string, fallback = "") => ({
  get: (): string => localStorage.getItem(key) ?? fallback,
  set: (value: string) => localStorage.setItem(key, value),
  clear: () => localStorage.removeItem(key),
});

/** 开关存成 "1" / "0"。 */
const flag = (key: string) => ({
  get: (): boolean => localStorage.getItem(key) === "1",
  set: (on: boolean) => localStorage.setItem(key, on ? "1" : "0"),
});

const json = <T>(key: string, fallback: T) => ({
  get: (): T => loadJson(key, fallback),
  set: (value: T) => localStorage.setItem(key, JSON.stringify(value)),
});

/** 进程不在时选的模型 / 强度，按会话 ID。 */
export type PendingChoices = Record<string, PendingChoice>;

export const saved = {
  /** hubd 地址；空的时候先弹设置。 */
  url: text("cchub.url"),
  /** 新会话要用的工作区，服务器上的路径。 */
  cwd: text("cchub.cwd"),
  /** 图标栏当前视图。 */
  view: text("cchub.view", "home"),
  /** 右侧窗格；值由 `nav.ts` 校验。 */
  pane: text("cchub.pane"),
  sideCollapsed: flag("cchub.sideCollapsed"),
  /** 详细档：工具调用逐条展开。 */
  verbose: flag("cchub.verbose"),
  /** 上次 `initialize` 回复的模型列表，用 `savedModels()` 读。 */
  models: json<ModelOption[]>("cchub.models", []),
  commands: json<SlashCommand[]>("cchub.commands", []),
  /** 用户自选的默认模型和强度，每台设备各存一份。 */
  defaults: json<{ model?: string; effort?: string }>("cchub.defaults", {}),
  /** 恢复进程时带上，见 `PendingChoice`。 */
  pending: json<PendingChoices>("cchub.pending", {}),
  /** 额度缓存；读出来要先 `cachedLimits` 去掉来源。 */
  limits: json<RateLimits>("cchub.limits", {}),
  /** 草稿，按会话 ID（新会话页是空串）。 */
  drafts: json<Record<string, string>>("cchub.drafts", {}),
  /** 任务开始时间，见 `stampTaskTimes`。 */
  taskTimes: json<Record<string, number>>("cchub.taskTimes", {}),
};

/** 还没有任何会话返回过模型列表时用，只放 CLI 长期支持的别名。 */
const FALLBACK_MODELS: ModelOption[] = [
  { value: "default", displayName: "默认" },
  { value: "opus", displayName: "Opus" },
  { value: "sonnet", displayName: "Sonnet" },
  { value: "haiku", displayName: "Haiku" },
];

export function savedModels(): ModelOption[] {
  const models = saved.models.get();
  return Array.isArray(models) && models.length ? models : FALLBACK_MODELS;
}

/** 记下一个会话进程不在时选的模型 / 强度，和已有的合并。 */
export const withPending = (all: PendingChoices, id: string, change: PendingChoice): PendingChoices => ({ ...all, [id]: { ...all[id], ...change } });

/** 取走一个会话的待定选择；没有时 `rest` 就是原来的记录。 */
export function withoutPending(all: PendingChoices, id: string): { pending?: PendingChoice; rest: PendingChoices } {
  const pending = all[id];
  if (!pending) return { rest: all };
  const { [id]: _, ...rest } = all;
  return { pending, rest };
}

/** 任务开始时间最多记多少条，按记下的先后挤掉旧的。 */
const MAX_TASK_TIMES = 200;

/**
 * 任务事件没有时间戳：第一次看到还在跑的任务时记下 `now`，套到 `startedAt` 上，窗口重建后重放还能用。
 * 重放时第一次看到的就是已结束的任务，开始时间未知，不记。有新记的才返回新记录，否则返回 null。
 */
export function stampTaskTimes(tasks: Iterable<Task>, times: Record<string, number>, now: number): Record<string, number> | null {
  let next: Record<string, number> | null = null;
  for (const task of tasks) {
    if (task.startedAt) continue;
    let at = (next ?? times)[task.id];
    if (!at) {
      if (task.endedAt) continue;
      next ??= { ...times };
      at = next[task.id] = now;
    }
    task.startedAt = at;
  }
  if (!next) return null;
  const entries = Object.entries(next);
  return entries.length > MAX_TASK_TIMES ? Object.fromEntries(entries.slice(-MAX_TASK_TIMES)) : next;
}
