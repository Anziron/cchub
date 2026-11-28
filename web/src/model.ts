// 把 claude 的 stream-json 还原成界面模型。纯函数，不碰界面和网络，用录制数据测试。

export type AskKind = "approval" | "question" | "plan";

export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

export interface Ask {
  requestId: string;
  toolUseId?: string;
  kind: AskKind;
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
  suggestions?: unknown[];
  questions: Question[];
  plan?: string;
  /** 回复已发出，等 CLI 确认。 */
  sent: boolean;
  /** 回执说进程已不在：这张卡片没人能收到回复了。 */
  expired?: boolean;
  /** 回复没写进进程（卡住 / 不合法），卡片已解锁，这里是原因。 */
  error?: string;
  /** 用户在输入框里打字回复的原文，卡片结束后显示“你回复：…”。 */
  reply?: string;
}

export interface ToolItem {
  kind: "tool";
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  truncated?: boolean;
  isError?: boolean;
  /** CLI 自己拦下的调用，要原样显示。 */
  blocked?: boolean;
  /** 工具调用之外的补充内容，目前是技能正文。 */
  detail?: string;
  /** 子代理里调用的工具数。 */
  children: number;
}

/** 发送中 → hubd 回执成功（已送达，等 CLI 回传）→ 回传后没有状态；失败可重试。 */
export type UserState = "sending" | "delivered" | "failed";

/**
 * 消息里的图片（输入框里粘贴的截图）。`data` 是 base64；大图回传时被 hubd 省掉（见 protocol 的 `elide_base64`），
 * 这时是空串，界面再去本机缓存（`imageCache.ts`）里找。
 */
export interface MessageImage {
  mediaType: string;
  data: string;
}

export type Item =
  | { kind: "user"; id: string; text: string; images?: MessageImage[]; state?: UserState; error?: string }
  | { kind: "text"; id: string; text: string; live: boolean }
  | { kind: "thinking"; id: string; text: string }
  | ToolItem
  | { kind: "ask"; id: string; requestId: string }
  | { kind: "interrupted"; id: string }
  /** 本地命令的输出（如切换模型），不是用户说的话，也不会让模型开始回复。 */
  | { kind: "notice"; id: string; text: string }
  | { kind: "error"; id: string; text: string }
  /** 一轮正常结束：用时和输出 token，显示成一行小字。 */
  | { kind: "turn"; id: string; durationMs?: number; outputTokens?: number };

export interface Todo {
  content: string;
  status: string;
  activeForm?: string;
}

export interface Task {
  id: string;
  type?: string;
  description?: string;
  backgrounded: boolean;
  status: "running" | "completed" | "failed" | "stopped";
  /** 事件里没有开始时间，由 store 记录首次看到的时间。 */
  startedAt?: number;
  endedAt?: number;
  toolUseId?: string;
  outputFile?: string;
  summary?: string;
}

export type Phase = "idle" | "thinking" | "replying" | "tool";

export interface Thread {
  items: Item[];
  asks: Map<string, Ask>;
  todos: Todo[];
  phase: Phase;
  /** 正在运行的工具，用于状态行。 */
  activeTool?: string;
  turnStartedAt?: number;
  /** 发出中断的时间，这一轮结束时清除。 */
  interruptAt?: number;
  claudeSessionId?: string;
  model?: string;
  /** 一轮进行中选的模型：这一轮剩下的回复仍是旧模型，下一个 `system/init` 才生效。 */
  nextModel?: string;
  /** 推理强度。实时事件不带，只有 `.jsonl` 的 `assistant` 带；没有时表示跟随模型默认。 */
  effort?: string;
  cwd?: string;
  /** 所有任务。转入后台的会在一轮结束后继续跑，一轮结束不等于任务完成。 */
  tasks: Map<string, Task>;
  /** 上下文已用 token 和上限。 */
  context?: { used: number; max?: number };
  /** CLI 正在压缩上下文（`system/status: compacting`），压缩可能要几分钟，期间没有别的事件。 */
  compacting?: boolean;
  /** 压缩失败或被中断：CLI 接着发一条 `<synthetic>` 回复说明原因，要显示成提示。 */
  compactFailed?: boolean;
  lastTurn?: { durationMs?: number; outputTokens?: number };
  /** `system/init` 带的权限模式（default、acceptEdits、plan、auto、bypassPermissions）。 */
  permissionMode?: string;
  /** 这次运行（当前进程的 `out`）累计的轮数、用时和输出 token。 */
  stats: { turns: number; durationMs: number; outputTokens: number };
  /** 这一轮实时的输出 token，见 [`turnTokens`]。 */
  turnUsage: TurnUsage;
}

/**
 * 主线程：`message_delta` 带这条消息最终的 `output_tokens`，累加到 `done`；还在生成的消息按收到的字符数估算。
 * 子代理没有流式片段，按 `assistant` 事件里的 `usage` 记，同一条消息出现多次取最大值。
 */
export interface TurnUsage {
  done: number;
  liveChars: number;
  agents: Map<string, number>;
}

const newTurnUsage = (): TurnUsage => ({ done: 0, liveChars: 0, agents: new Map() });

/** 这一轮到目前为止的输出 token（含思考和子代理），生成中的部分按约 4 个字符 1 个 token 估算。 */
export function turnTokens(thread: Thread): number {
  const { done, liveChars, agents } = thread.turnUsage;
  let total = done + Math.round(liveChars / 4);
  for (const n of agents.values()) total += n;
  return total;
}

const MAX_RESULT = 64 * 1024;

export function newThread(): Thread {
  return {
    items: [],
    asks: new Map(),
    todos: [],
    phase: "idle",
    tasks: new Map(),
    stats: { turns: 0, durationMs: 0, outputTokens: 0 },
    turnUsage: newTurnUsage(),
  };
}

export function isWaiting(thread: Thread): boolean {
  for (const ask of thread.asks.values()) if (!ask.sent) return true;
  return false;
}

export function firstAsk(thread: Thread): Ask | undefined {
  for (const ask of thread.asks.values()) if (!ask.sent) return ask;
  return undefined;
}

type Json = Record<string, any>;

function replaceItem(thread: Thread, index: number, item: Item): void {
  // 替换对象而不是原地改，界面按引用判断哪一项要重画。
  thread.items[index] = item;
}

function findLast(thread: Thread, test: (item: Item) => boolean): number {
  for (let i = thread.items.length - 1; i >= 0; i--) {
    if (test(thread.items[i])) return i;
  }
  return -1;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    // 图片不显示（hubd 也会把大图的 base64 省掉），只留占位。
    .map((part: Json) => part.text ?? part.tool_name ?? (part.type === "image" ? "[图片]" : ""))
    .filter(Boolean)
    .join("\n");
}

function addAsk(thread: Thread, event: Json): void {
  const request: Json = event.request;
  const toolName: string = request.tool_name ?? "";
  const input: Json = request.input ?? {};
  let kind: AskKind = "approval";
  if (toolName === "AskUserQuestion") kind = "question";
  else if (toolName === "ExitPlanMode") kind = "plan";
  else if (request.requires_user_interaction) kind = "question";
  // 重放时事件会再来一遍，同一个请求只留一张卡片。
  if (thread.asks.has(event.request_id)) return;
  thread.asks.set(event.request_id, {
    requestId: event.request_id,
    toolUseId: request.tool_use_id,
    kind,
    toolName,
    input,
    description: request.description,
    suggestions: request.permission_suggestions,
    questions: Array.isArray(input.questions) ? input.questions : [],
    // 第一次方案确认可能是空的 `{}`。
    plan: typeof input.plan === "string" ? input.plan : undefined,
    sent: false,
  });
  thread.items.push({
    kind: "ask",
    id: `ask:${event.request_id}`,
    requestId: event.request_id,
  });
}

function removeAsk(thread: Thread, requestId: string): void {
  if (!thread.asks.delete(requestId)) return;
  const index = findLast(
    thread,
    (item) => item.kind === "ask" && item.requestId === requestId,
  );
  if (index >= 0) thread.items.splice(index, 1);
}

function clearAsks(thread: Thread): void {
  for (const id of [...thread.asks.keys()]) removeAsk(thread, id);
}

function onToolResult(thread: Thread, part: Json): void {
  const toolUseId: string | undefined = part.tool_use_id;
  // 有了结果就说明请求已经被回答，不管是这台设备还是别处回答的。
  for (const ask of [...thread.asks.values()]) {
    if (ask.toolUseId === toolUseId) removeAsk(thread, ask.requestId);
  }
  const index = findLast(
    thread,
    (item) => item.kind === "tool" && item.id === toolUseId,
  );
  if (index < 0) return;
  const tool = thread.items[index] as ToolItem;
  const text = resultText(part.content);
  replaceItem(thread, index, {
    ...tool,
    result: text.replace(/<\/?tool_use_error>/g, "").slice(0, MAX_RESULT),
    truncated: text.length > MAX_RESULT,
    isError: part.is_error === true,
    blocked: text.includes("<tool_use_error>Blocked:"),
  });
}

/** 还原内置命令的回传：`<command-name>/x</command-name><command-args>y</command-args>`。 */
function commandText(content: string): string | null {
  const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(content)?.[1];
  if (!name) return null;
  const args = /<command-args>\s*([^<]*?)\s*<\/command-args>/.exec(content)?.[1];
  return args ? `${name} ${args}` : name;
}

/**
 * 本地命令的输出，不是用户说的话。`set_model` 的回显 `Set model to …` 返回空串（吞掉，不显示）；
 * 会话记录里还带着 `/model` 命令本身。其他带命令名的仍按内置命令回传处理。
 */
function localNotice(content: string): string | null {
  const output = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(content)?.[1]?.trim();
  if (output === undefined) return null;
  const command = commandText(content);
  if (command && !command.startsWith("/model")) return null;
  // 切换提示由 `set_model` 的成功回复生成（见 `onControlResponse`），回显不再显示。
  if (/^Set model to /.test(output)) return "";
  // `/compact` 完成的提示由 `compact_boundary` 生成（带前后 token 数），这句英文不再显示。
  if (/^Compacted\b/.test(output)) return "";
  return output;
}

/** CLI 注入给模型的消息，不是用户说的话。 */
const isInjected = (event: Json): boolean => event.isSynthetic === true || event.isMeta === true;

/** 技能正文折叠进对应的工具行，其他注入内容不显示。 */
function onInjected(thread: Thread, event: Json, text: string): void {
  if (!text.startsWith("Base directory for this skill")) return;
  const id: string | undefined = event.sourceToolUseID;
  const index = findLast(
    thread,
    (item) => item.kind === "tool" && (id ? item.id === id : item.name === "Skill" && !item.detail),
  );
  if (index < 0) return;
  replaceItem(thread, index, { ...(thread.items[index] as ToolItem), detail: text.slice(0, MAX_RESULT) });
}

function ensureTask(thread: Thread, id: string): Task {
  let task = thread.tasks.get(id);
  if (!task) {
    task = { id, backgrounded: false, status: "running" };
    thread.tasks.set(id, task);
  }
  return task;
}

const TASK_STATUS: Record<string, Task["status"]> = {
  completed: "completed",
  failed: "failed",
  killed: "stopped",
  stopped: "stopped",
};

function onTaskEvent(thread: Thread, event: Json): void {
  if (event.subtype === "background_tasks_changed") {
    for (const item of (event.tasks ?? []) as Json[]) {
      const task = ensureTask(thread, item.task_id);
      task.backgrounded = true;
      task.type = item.task_type ?? task.type;
      task.description = item.description ?? task.description;
    }
    return;
  }
  const task = ensureTask(thread, event.task_id);
  if (event.subtype === "task_started") {
    task.type = event.task_type;
    task.description = event.description;
    task.toolUseId = event.tool_use_id;
    task.backgrounded = task.backgrounded || event.is_backgrounded === true;
  } else if (event.subtype === "task_updated") {
    const patch: Json = event.patch ?? {};
    if (patch.is_backgrounded !== undefined) task.backgrounded = patch.is_backgrounded === true;
    if (TASK_STATUS[patch.status]) task.status = TASK_STATUS[patch.status];
    if (patch.end_time) task.endedAt = patch.end_time;
  } else {
    task.status = TASK_STATUS[event.status] ?? "completed";
    task.endedAt = task.endedAt ?? Date.now();
    task.summary = event.summary;
    task.outputFile = event.output_file || task.outputFile;
    task.toolUseId = event.tool_use_id ?? task.toolUseId;
  }
}

/** 后台任务，新的在前。 */
export const backgroundTasks = (thread: Thread): Task[] =>
  [...thread.tasks.values()].filter((task) => task.backgrounded).reverse();

export const runningTasks = (thread: Thread): Task[] =>
  backgroundTasks(thread).filter((task) => task.status === "running");

/** 运行中的任务没有 `output_file`，路径写在启动它的工具结果里。 */
export function taskOutputPath(thread: Thread, task: Task): string | null {
  if (task.outputFile) return task.outputFile;
  const tool = thread.items.find((item) => item.kind === "tool" && item.id === task.toolUseId);
  const result = tool?.kind === "tool" ? tool.result : undefined;
  return result?.match(/\/tmp\/claude-[^\s"']+\/tasks\/[^\s"']+\.output/)?.[0] ?? null;
}

/** 子代理任务的输出是 hubd 筛过的对话行（`.jsonl`），普通任务是纯文本。 */
export const isTranscript = (text: string): boolean => text.startsWith("{");

/** 把子代理的对话行解析成条目，在后台任务面板里按对话显示。 */
export interface SearchLink {
  title: string;
  url: string;
}

/** `WebSearch` 的结果里每次搜索一行 `Links: [{"title","url"}...]`，取出来做成可点的列表，其余文字原样保留。 */
export function searchLinks(result: string): { links: SearchLink[]; rest: string } | null {
  const links: SearchLink[] = [];
  const rest: string[] = [];
  for (const line of result.split("\n")) {
    if (line.startsWith("Links: [")) {
      try {
        const list: unknown = JSON.parse(line.slice(7));
        if (Array.isArray(list)) {
          for (const item of list as Json[]) if (typeof item?.url === "string") links.push({ title: String(item.title ?? item.url), url: item.url });
          continue;
        }
      } catch {
        // 解析不了就当普通文字。
      }
    }
    rest.push(line);
  }
  return links.length ? { links, rest: rest.join("\n").trim() } : null;
}

export function parseTranscript(text: string): Item[] {
  const thread = newThread();
  for (const line of text.split("\n")) if (line) apply(thread, line);
  return thread.items;
}

/** 额度事件来自哪里，用来判断新旧。`rank`：运行中的会话用 `Number.MAX_SAFE_INTEGER`，否则用会话日志的最后更新时间。 */
export interface LimitSource {
  session: string;
  seq: number;
  rank: number;
}

export interface LimitWindow {
  utilization: number;
  resetsAt: number;
  source?: LimitSource;
}

export interface RateLimits {
  fiveHour?: LimitWindow;
  sevenDay?: LimitWindow;
  /** Fable 的周额度（`seven_day_overage_included`），只有带这个窗口的账号、用过 Fable 后才有。 */
  fable?: LimitWindow;
}

/**
 * 额度事件的新旧等级。运行中会话的实时事件最新；订阅时从头重放的历史（偏移小于 hubd `attached` 给的 `live`）
 * 和已结束的会话一样按日志更新时间算，否则打开会话时历史里的旧额度会一条条盖掉实时数据，界面来回跳。
 * 旧版 hubd 不发 `live`，全部按实时处理。
 */
export function limitRank(running: boolean, logUpdated: number, seq: number, live?: number): number {
  return running && (live === undefined || seq >= live) ? Number.MAX_SAFE_INTEGER : logUpdated;
}

/** 本地缓存读出来的额度去掉来源：上次运行时记下的“运行中”等级不能压住这次的任何数据。 */
export function cachedLimits(saved: RateLimits): RateLimits {
  const strip = (window?: LimitWindow) => (window ? { utilization: window.utilization, resetsAt: window.resetsAt } : undefined);
  return { fiveHour: strip(saved.fiveHour), sevenDay: strip(saved.sevenDay), fable: strip(saved.fable) };
}

/** 从 `rate_limit_event` 取额度。 */
export function parseRateLimits(line: string, source?: LimitSource): RateLimits | null {
  if (!line.includes("rate_limit_event")) return null;
  try {
    const event = JSON.parse(line);
    const windows = event.type === "rate_limit_event" ? event.rate_limit_info?.unifiedWindows : null;
    if (!windows) return null;
    const pick = (window: Json) =>
      typeof window?.utilization === "number" && typeof window?.resetsAt === "number"
        ? { utilization: window.utilization, resetsAt: window.resetsAt, ...(source ? { source } : {}) }
        : undefined;
    return { fiveHour: pick(windows.five_hour), sevenDay: pick(windows.seven_day), fable: pick(windows.seven_day_overage_included) };
  } catch {
    return null;
  }
}

/**
 * 重放旧日志不能盖掉新数据。重置时间更晚的窗口算新；同一窗口按来源判断：
 * 同一会话 seq 大的新，不同会话 `rank` 大的新。使用率不能当新旧依据，官方会提前清零。
 */
export function mergeRateLimits(old: RateLimits, next: RateLimits): RateLimits {
  const newer = (a?: LimitWindow, b?: LimitWindow) => {
    if (!a || !b) return b ?? a;
    if (b.resetsAt !== a.resetsAt) return b.resetsAt > a.resetsAt ? b : a;
    if (!a.source || !b.source) {
      // 本地缓存的旧数据没有来源，带来源的为准；都没有来源时只能取更高。
      if (b.source) return b;
      if (a.source) return a;
      return b.utilization >= a.utilization ? b : a;
    }
    if (a.source.session === b.source.session) return b.source.seq > a.source.seq ? b : a;
    return b.source.rank >= a.source.rank ? b : a;
  };
  return { fiveHour: newer(old.fiveHour, next.fiveHour), sevenDay: newer(old.sevenDay, next.sevenDay), fable: newer(old.fable, next.fable) };
}

/** `/` 命令，字段来自 CLI 的 `initialize` 回复。 */
export interface SlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
}

/** 输入框里只有一个还没打完的 `/词` 时才弹菜单。前缀匹配排在前面。 */
export function matchCommands(commands: SlashCommand[], text: string): SlashCommand[] {
  const query = /^\/(\S*)$/.exec(text)?.[1]?.toLowerCase();
  if (query === undefined) return [];
  const name = (c: SlashCommand) => c.name.toLowerCase();
  return [
    ...commands.filter((c) => name(c).startsWith(query)),
    ...commands.filter((c) => !name(c).startsWith(query) && name(c).includes(query)),
  ];
}

const RESUME_COMMAND: SlashCommand = { name: "resume", description: "找回已关闭的会话" };

/** `/resume` 由界面处理（CLI 的无界面模式没有这个命令），不发给 CLI。 */
export const isResumeCommand = (text: string): boolean => /^\/resume\s*$/.test(text.trim());

/** 命令菜单：CLI 没报 `/resume` 时补在最前面。 */
export const withResume = (commands: SlashCommand[]): SlashCommand[] =>
  commands.some((c) => c.name === "resume") ? commands : [RESUME_COMMAND, ...commands];

function onUser(thread: Thread, event: Json): void {
  const content = event.message?.content;
  if (typeof content === "string") {
    if (event.parent_tool_use_id) return;
    onUserText(thread, event, content);
    return;
  }
  if (!Array.isArray(content)) return;
  // 带图片的用户消息（输入框里粘贴的截图）：文字和图片合成一条，和纯文字一样按 uuid 确认送达。
  const images = userImages(event, content as Json[]);
  if (images) {
    const text = (content as Json[]).filter((part) => part.type === "text").map((part) => String(part.text)).join("\n\n");
    onUserText(thread, event, text, images);
    return;
  }
  for (const part of content as Json[]) {
    if (part.type === "tool_result") {
      onToolResult(thread, part);
      // 子代理的工具结果不代表主线程状态：主轮已结束或在等 Agent 时不能翻成“思考中”。
      if (!event.parent_tool_use_id) {
        thread.phase = "thinking";
        thread.activeTool = undefined;
      }
    } else if (part.type === "text" && !event.parent_tool_use_id) {
      if (String(part.text).startsWith("[Request interrupted")) {
        thread.items.push({ kind: "interrupted", id: event.uuid ?? `i${thread.items.length}` });
      } else if (isInjected(event)) {
        onInjected(thread, event, String(part.text));
      } else {
        thread.items.push({ kind: "user", id: event.uuid ?? `u${thread.items.length}`, text: part.text });
      }
    }
  }
}

/** 用户自己发的、带图片的消息里的图片；不是（工具结果、子代理、注入的消息、没有图片）返回 null。 */
function userImages(event: Json, content: Json[]): MessageImage[] | null {
  if (event.parent_tool_use_id || isInjected(event)) return null;
  if (!content.some((part) => part.type === "image") || content.some((part) => part.type === "tool_result")) return null;
  return content
    .filter((part) => part.type === "image")
    .map((part) => ({ mediaType: String(part.source?.media_type ?? "image/png"), data: typeof part.source?.data === "string" ? part.source.data : "" }));
}

/** 回传的图片数据被 hubd 省掉时，沿用发送时本地那份。 */
function keepImageData(echoed: MessageImage[] | undefined, local: MessageImage[] | undefined): MessageImage[] | undefined {
  if (!echoed) return local;
  return echoed.map((image, i) => (image.data || !local?.[i] ? image : { ...image, data: local[i].data }));
}

/** 用户说的话（纯文字，或带图片的消息里的文字）。 */
function onUserText(thread: Thread, event: Json, content: string, images?: MessageImage[]): void {
  // 后台任务结束时 CLI 发给模型的通知，不是用户说的话，内容在后台任务面板里。
  if (event.origin?.kind === "task-notification" || content.startsWith("<task-notification>")) {
    thread.phase = "thinking";
    thread.activeTool = undefined;
    return;
  }
  if (isInjected(event)) {
    onInjected(thread, event, content);
    return;
  }
  const notice = localNotice(content);
  if (notice !== null) {
    if (notice) thread.items.push({ kind: "notice", id: event.uuid ?? `n${thread.items.length}`, text: notice });
    return;
  }
  const command = commandText(content);
  // 发送时已经先显示了，回传只是确认送达。
  const sent = findLast(thread, (item) => item.kind === "user" && item.id === event.uuid);
  const prior = sent >= 0 ? thread.items[sent] : undefined;
  // 已经回传过（气泡没有发送状态了）又来一次：hubd 重启后客户端按原 id 补发，CLI 认出 uuid 重复、
  // 只回显不处理（实验见设计仓库 experiments/k2-dup.py）。什么都不改，否则会一直显示“思考中”。
  if (prior?.kind === "user" && prior.state === undefined) return;
  if (sent >= 0) {
    const kept = keepImageData(images, prior?.kind === "user" ? prior.images : undefined);
    replaceItem(thread, sent, { kind: "user", id: event.uuid, text: command ?? content, ...(kept ? { images: kept } : {}) });
    if (command) return;
  } else if (command) {
    // 内置命令的回传排在回复后面，重放时放回回复前面。
    const last = thread.items.length - 1;
    const at = thread.items[last]?.kind === "text" ? last : thread.items.length;
    thread.items.splice(at, 0, { kind: "user", id: event.uuid ?? `u${thread.items.length}`, text: command });
    return;
  } else {
    thread.items.push({ kind: "user", id: event.uuid ?? `u${thread.items.length}`, text: content, ...(images ? { images } : {}) });
  }
  thread.phase = "thinking";
  thread.activeTool = undefined;
  const at = Date.parse(event.timestamp ?? "");
  thread.turnStartedAt = Number.isNaN(at) ? Date.now() : at;
  thread.turnUsage = newTurnUsage();
}

/** 本地命令（`/context`、`/compact` 等）的输出是 CLI 合成的回复，不是模型说的。 */
const SYNTHETIC_MODEL = "<synthetic>";

function onAssistant(thread: Thread, event: Json): void {
  const message: Json = event.message ?? {};
  const parent: string | null = event.parent_tool_use_id ?? null;
  if (thread.compactFailed && !parent && message.model === SYNTHETIC_MODEL) {
    thread.compactFailed = false;
    const reason = ((message.content ?? []) as Json[]).map((block) => (block.type === "text" ? block.text : "")).join("").trim();
    const text = !reason || /^Compaction canceled\.?$/.test(reason) ? "已取消压缩，上下文没有变" : `压缩失败：${reason}`;
    pushNotice(thread, `compact:${message.id ?? event.uuid ?? thread.items.length}`, text);
    return;
  }
  // 一轮中切了模型：CLI 这一轮不回显新模型，回复里还是旧的，不能改回去。合成回复不是模型，不算。
  if (message.model && message.model !== SYNTHETIC_MODEL && !parent && !thread.nextModel) thread.model = message.model;
  if (typeof event.effort === "string" && !parent && !event.isSidechain) thread.effort = event.effort;
  const usage: Json | undefined = message.usage;
  if (usage && !parent) {
    const used = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    if (used) thread.context = { ...thread.context, used };
  }
  if (usage && parent && typeof message.id === "string" && typeof usage.output_tokens === "number") {
    const agents = thread.turnUsage.agents;
    agents.set(message.id, Math.max(agents.get(message.id) ?? 0, usage.output_tokens));
  }
  for (const block of (message.content ?? []) as Json[]) {
    if (parent) {
      // 子代理的内容折叠进父调用，只计数。
      if (block.type === "tool_use") {
        const index = findLast(thread, (item) => item.kind === "tool" && item.id === parent);
        if (index >= 0) {
          const tool = thread.items[index] as ToolItem;
          replaceItem(thread, index, { ...tool, children: tool.children + 1 });
        }
      }
      continue;
    }
    if (block.type === "text") {
      const index = findLast(
        thread,
        (item) => item.kind === "text" && item.live && item.id.startsWith(`${message.id}:`),
      );
      if (index >= 0) {
        const item = thread.items[index];
        replaceItem(thread, index, { ...item, text: block.text, live: false } as Item);
      } else {
        thread.items.push({ kind: "text", id: `${message.id}:f${thread.items.length}`, text: block.text, live: false });
      }
      thread.phase = "replying";
    } else if (block.type === "thinking") {
      // CLI 常发内容为空的思考块，没有东西可看，“思考中”由状态行显示。
      if (block.thinking) {
        thread.items.push({ kind: "thinking", id: `${message.id}:t${thread.items.length}`, text: block.thinking });
      }
      thread.phase = "thinking";
    } else if (block.type === "tool_use") {
      if (block.name === "TodoWrite" && Array.isArray(block.input?.todos)) {
        thread.todos = block.input.todos;
        continue;
      }
      if (findLast(thread, (item) => item.kind === "tool" && item.id === block.id) >= 0) continue;
      thread.items.push({
        kind: "tool",
        id: block.id,
        name: block.name,
        input: block.input ?? {},
        children: 0,
      });
      thread.phase = "tool";
      thread.activeTool = block.id;
    }
  }
}

function onStreamEvent(thread: Thread, outer: Json): void {
  if (outer.parent_tool_use_id) return;
  const event: Json = outer.event ?? {};
  const usage = thread.turnUsage;
  if (event.type === "message_start") {
    usage.liveChars = 0;
  } else if (event.type === "message_delta" && typeof event.usage?.output_tokens === "number") {
    usage.done += event.usage.output_tokens;
    usage.liveChars = 0;
  } else if (event.type === "content_block_delta") {
    const delta: Json = event.delta ?? {};
    const piece = delta.text ?? delta.thinking ?? delta.partial_json;
    if (typeof piece === "string") usage.liveChars += piece.length;
  }
  if (event.type !== "content_block_delta" || event.delta?.type !== "text_delta") return;
  const id = `${outer.api_message_id}:${event.index}`;
  const index = findLast(thread, (item) => item.kind === "text" && item.id === id);
  if (index >= 0) {
    const item = thread.items[index] as Extract<Item, { kind: "text" }>;
    // 完整消息已到，迟到的片段不再追加。
    if (item.live) replaceItem(thread, index, { ...item, text: item.text + event.delta.text });
  } else {
    thread.items.push({ kind: "text", id, text: event.delta.text, live: true });
  }
  thread.phase = "replying";
}

function onResult(thread: Thread, event: Json): void {
  clearAsks(thread);
  thread.interruptAt = undefined;
  thread.compacting = false;
  thread.compactFailed = false;
  const models: Json = event.modelUsage ?? {};
  const max = (models[thread.model ?? ""] ?? (Object.values(models)[0] as Json | undefined))?.contextWindow;
  if (thread.context && max) thread.context.max = max;
  thread.phase = "idle";
  thread.activeTool = undefined;
  thread.lastTurn = {
    durationMs: event.duration_ms,
    outputTokens: event.usage?.output_tokens,
  };
  // 中断的 result 也是 is_error，不能显示成失败。
  const interrupted =
    event.subtype === "error_during_execution" ||
    event.terminal_reason === "aborted_tools" ||
    thread.items[thread.items.length - 1]?.kind === "interrupted";
  thread.stats.turns += 1;
  thread.stats.durationMs += event.duration_ms ?? 0;
  thread.stats.outputTokens += event.usage?.output_tokens ?? 0;
  if (!event.is_error && !interrupted && (event.duration_ms != null || event.usage?.output_tokens)) {
    thread.items.push({
      kind: "turn",
      id: event.uuid ?? `r${thread.items.length}`,
      durationMs: event.duration_ms,
      outputTokens: event.usage?.output_tokens,
    });
  }
  if (event.is_error && !interrupted) {
    const errors = Array.isArray(event.errors) ? event.errors.join("\n") : "";
    thread.items.push({
      kind: "error",
      id: event.uuid ?? `e${thread.items.length}`,
      text: event.result || errors || "这一轮出错了",
    });
  }
}

function pushNotice(thread: Thread, id: string, text: string): void {
  // 重放时事件会再来一遍，同一条提示只留一条。
  if (findLast(thread, (item) => item.kind === "notice" && item.id === id) >= 0) return;
  thread.items.push({ kind: "notice", id, text });
}

/** `claude-opus-5-5` → `Opus 5.5`，`claude-fable-5-2` → `Fable 5.2`；带日期后缀也认，认不出原样返回。 */
export function modelDisplayName(id: string): string {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/.exec(id);
  if (!match) return id;
  return `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]}.${match[3]}`;
}

/**
 * 所选模型（可能是别名 `opus`）和实际模型（完整 ID）是不是同一个。
 * 列表里找不到所选的、判断不了时按相同处理：宁可不提示，也不误报。
 */
export function sameModel(models: ModelOption[], chosen: string, actual: string): boolean {
  if (chosen === actual) return true;
  const option = findModel(models, chosen);
  if (!option) return true;
  if (option.resolvedModel) return option.resolvedModel === actual;
  // 还是内置别名列表（没有 resolvedModel）：完整 ID 里含别名就算同一个；“默认”判断不了。
  return option.value === "default" || actual.includes(option.value);
}

/** 新一轮的 `system/init`：一轮中选的模型到这里才生效，没生效要说一声。 */
function onInitModel(thread: Thread, actual: unknown, models: ModelOption[]): void {
  const chosen = thread.nextModel;
  thread.nextModel = undefined;
  if (!chosen || typeof actual !== "string" || sameModel(models, chosen, actual)) return;
  const name = findModel(models, chosen)?.displayName ?? chosen;
  thread.items.push({ kind: "notice", id: `nm${thread.items.length}`, text: `所选模型 ${name} 没有生效，当前是 ${modelDisplayName(actual)}` });
}

/** `system/status`：只关心压缩的开始和结束，其他状态（`requesting` 等）不影响显示。 */
function onStatus(thread: Thread, event: Json): void {
  if (event.status === "compacting") {
    thread.compacting = true;
    return;
  }
  if (!thread.compacting) return;
  thread.compacting = false;
  if (event.compact_result === "failed") thread.compactFailed = true;
}

/** 压缩完成（手动 `/compact` 或自动压缩）：一行前后 token 数，上下文用量换成压缩后的。 */
function onCompactBoundary(thread: Thread, event: Json): void {
  thread.compacting = false;
  const meta: Json = event.compact_metadata ?? {};
  const head = meta.trigger === "auto" ? "自动压缩了上下文" : "已压缩上下文";
  const sizes = typeof meta.pre_tokens === "number" && typeof meta.post_tokens === "number"
    ? `：${formatTokens(meta.pre_tokens)} → ${formatTokens(meta.post_tokens)} tokens`
    : "";
  const seconds = typeof meta.duration_ms === "number" ? meta.duration_ms / 1000 : 0;
  const took = !seconds ? "" : seconds < 60 ? `，用时 ${seconds.toFixed(1)} 秒` : `，用时 ${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
  pushNotice(thread, event.uuid ?? `compact${thread.items.length}`, head + sizes + took);
  if (typeof meta.post_tokens === "number") thread.context = { ...thread.context, used: meta.post_tokens };
}

/** 安全机制拦下回复后 CLI 自动换了模型。 */
function onModelFallback(thread: Thread, event: Json): void {
  const from = typeof event.original_model === "string" ? modelDisplayName(event.original_model) : "原模型";
  const to = typeof event.fallback_model === "string" ? event.fallback_model : undefined;
  const reason = [event.api_refusal_explanation, event.content].find((r) => typeof r === "string" && r);
  const text = `${from} 的安全机制拦下了回复，本会话已自动换成 ${to ? modelDisplayName(to) : "备用模型"}${reason ? `。${reason}` : ""}`;
  pushNotice(thread, event.uuid ?? `mf${thread.items.length}`, text);
  if (to) thread.model = to;
  thread.nextModel = undefined;
}

/** `set_model` 的回复生成切换提示，一次切换一条（按 request_id 去重，重放也只有一条）。 */
function onControlResponse(thread: Thread, event: Json): void {
  const response: Json = event.response ?? {};
  const requestId: unknown = response.request_id;
  if (typeof requestId !== "string") return;
  // 强度：CLI 的回复不带值，按 request_id 里记的值恢复（刷新后重放 `out` 也能拿回来）。
  const effort = EFFORT_REQUEST.exec(requestId)?.[1];
  if (effort) {
    if (response.subtype === "success") thread.effort = effort === "default" ? undefined : effort;
    return;
  }
  if (!requestId.startsWith(SET_MODEL_PREFIX)) return;
  const id = `model:${requestId}`;
  if (response.subtype === "success") {
    const model = response.response?.model;
    const name = typeof model === "string" ? modelDisplayName(model) : "新模型";
    // 回复带完整模型 ID：空闲时立即生效；一轮进行中到下一个 `system/init` 才生效。
    if (typeof model === "string") {
      if (thread.phase === "idle") thread.model = model;
      else thread.nextModel = model;
    }
    pushNotice(thread, id, `已切换模型：${name}${thread.phase !== "idle" ? "（下一轮生效）" : ""}`);
  } else if (response.subtype === "error") {
    pushNotice(thread, id, `切换模型失败：${response.error ?? "未知错误"}`);
  }
}

/** 应用一行事件。不认识的事件直接忽略，CLI 新增类型不影响显示。 */
export function apply(thread: Thread, line: string, models: ModelOption[] = []): void {
  let event: Json;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  switch (event.type) {
    case "system":
      if (event.subtype === "init") {
        thread.claudeSessionId = event.session_id;
        thread.model = event.model;
        onInitModel(thread, event.model, models);
        thread.cwd = event.cwd;
        if (typeof event.permissionMode === "string") thread.permissionMode = event.permissionMode;
      } else if (event.subtype === "status") {
        onStatus(thread, event);
      } else if (event.subtype === "compact_boundary") {
        onCompactBoundary(thread, event);
      } else if (event.subtype === "model_refusal_fallback") {
        onModelFallback(thread, event);
      } else if (["task_started", "task_updated", "task_notification", "background_tasks_changed"].includes(event.subtype)) {
        onTaskEvent(thread, event);
      }
      break;
    case "stream_event":
      onStreamEvent(thread, event);
      break;
    case "assistant":
      onAssistant(thread, event);
      break;
    case "user":
      onUser(thread, event);
      break;
    case "control_response":
      onControlResponse(thread, event);
      break;
    case "control_request":
      if (event.request?.subtype === "can_use_tool") addAsk(thread, event);
      break;
    case "control_cancel_request":
      removeAsk(thread, event.request_id);
      break;
    case "conversation_reset":
      // `/clear`：CLI 换了新的会话 ID（随后的 `system/init` 带上），旧对话留在界面上可回看。
      pushNotice(thread, event.uuid ?? `reset${thread.items.length}`, "已清空上下文，下面是新的对话");
      thread.context = undefined;
      break;
    case "result":
      onResult(thread, event);
      break;
  }
}

/** 进程结束后没人能回复了，待决定的请求全部作废。 */
export function onProcessExit(thread: Thread): void {
  clearAsks(thread);
  thread.phase = "idle";
  thread.activeTool = undefined;
  thread.interruptAt = undefined;
  for (const task of thread.tasks.values()) {
    if (task.status === "running") {
      task.status = "stopped";
      task.endedAt = Date.now();
    }
  }
}

// 发给 claude 的消息。

/** 带图片时内容是数组：图片在前、文字在后（图片放在前面模型理解得更好）。 */
export function userLine(text: string, uuid?: string, images?: MessageImage[]): string {
  const content = images?.length
    ? [
        ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } })),
        ...(text ? [{ type: "text", text }] : []),
      ]
    : text;
  return JSON.stringify({ type: "user", ...(uuid ? { uuid } : {}), message: { role: "user", content } });
}

/** 发送时立刻显示，不等服务器回传。回传带同一个 uuid，到时候转为已送达。 */
export function addSending(thread: Thread, id: string, text: string, images?: MessageImage[]): void {
  thread.items.push({ kind: "user", id, text, ...(images?.length ? { images } : {}), state: "sending" });
  if (thread.phase === "idle") {
    thread.phase = "thinking";
    thread.activeTool = undefined;
    thread.turnStartedAt = Date.now();
    thread.turnUsage = newTurnUsage();
  }
}

/** 还没被 CLI 回传确认的消息（发送中或已送达）。 */
export const isSending = (thread: Thread): boolean =>
  thread.items.some((item) => item.kind === "user" && (item.state === "sending" || item.state === "delivered"));

/**
 * 执行 `/` 命令时状态行显示什么。压缩期间、以及本地命令回显之前（回显排在输出后面，`/insights`
 * 这类可能跑好几分钟）都没有别的事件，不能显示成“正在发送”或“思考中”。没有要说的返回 null。
 */
export function commandStatus(thread: Thread): string | null {
  if (thread.compacting) return "正在压缩上下文，大会话可能要几分钟";
  const pending = thread.items.find((item) => item.kind === "user" && item.state === "delivered" && item.text.trimStart().startsWith("/"));
  return pending?.kind === "user" ? `正在执行 ${pending.text.trim().split(/\s+/)[0]}` : null;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
}

function relativeTo(path: unknown, cwd?: string): string {
  const text = String(path ?? "");
  return cwd && text.startsWith(`${cwd}/`) ? text.slice(cwd.length + 1) : text;
}

/** 工具调用的一行说明：动词、对象、图标。对话流、审批卡片、侧栏状态行共用。 */
export function describeTool(tool: Pick<ToolItem, "name" | "input">, cwd?: string): { verb: string; target: string; icon: string } {
  const input = tool.input;
  const line = (value: unknown) => String(value ?? "").split("\n")[0];
  switch (tool.name) {
    case "Bash":
      return { verb: "运行", target: line(input.command), icon: "term" };
    case "Read":
      return { verb: "读取", target: relativeTo(input.file_path, cwd), icon: "file" };
    case "Edit":
    case "MultiEdit":
      return { verb: "编辑", target: relativeTo(input.file_path, cwd), icon: "file" };
    case "Write":
      return { verb: "写入", target: relativeTo(input.file_path, cwd), icon: "file" };
    case "Grep":
      return { verb: "搜索", target: line(input.pattern), icon: "file" };
    case "Glob":
      return { verb: "查找", target: line(input.pattern), icon: "file" };
    case "WebFetch":
      return { verb: "打开", target: line(input.url), icon: "file" };
    case "WebSearch":
      return { verb: "搜索网页", target: line(input.query), icon: "file" };
    case "Task":
    case "Agent":
      return { verb: "子任务：", target: line(input.description), icon: "agents" };
    case "Skill":
      return { verb: "使用技能", target: line(input.skill), icon: "file" };
    case "AskUserQuestion":
      return { verb: "提问", target: "", icon: "think" };
    case "ExitPlanMode":
      return { verb: "提交方案", target: "", icon: "think" };
    default:
      return { verb: tool.name, target: "", icon: "file" };
  }
}

/** hubd 回执成功：写给进程了，等 CLI 回传。只有还在“发送中”的才变，回传早于回执时不倒退。 */
export function markDelivered(thread: Thread, id: string): void {
  thread.items = thread.items.map((item) => (item.kind === "user" && item.id === id && item.state === "sending" ? { ...item, state: "delivered" } : item));
}

/** 单条消息发送失败，`error` 是显示在旁边的原因。和 `failSending` 一样结束“思考中”。 */
export function failUser(thread: Thread, id: string, error?: string): void {
  const item = thread.items.find((i) => i.kind === "user" && i.id === id);
  if (!item || item.kind !== "user" || item.state === undefined) return;
  thread.items = thread.items.map((i) => (i === item ? { ...item, state: "failed", error } : i));
  if (!isSending(thread)) {
    thread.phase = "idle";
    thread.turnStartedAt = undefined;
    thread.interruptAt = undefined;
  }
}

/** 找一条消息的当前状态；回传后没有状态，返回 undefined。 */
export function userState(thread: Thread, id: string): UserState | undefined {
  const item = thread.items.find((i) => i.kind === "user" && i.id === id);
  return item?.kind === "user" ? item.state : undefined;
}

/** 输入没有写给进程的原因（hubd 回执的 `error`）。 */
export function ackReason(error: "not_running" | "stalled" | "invalid"): string {
  if (error === "not_running") return "进程已结束";
  if (error === "stalled") return "Claude 没有读取输入，进程可能卡住了";
  return "消息太长或格式不对，没有发出";
}

/**
 * 服务器报错的显示文字。新增的请求类型不升协议版本（宽松规则，见 `protocol/tests/wire_compat.rs`），
 * 旧 hubd 收到不认识的请求会回“无法解析消息：unknown variant `…`”（ws.rs 的 `serve`），改成说人话。
 */
export function serverErrorText(message: string): string {
  const unknown = /^无法解析消息：unknown variant `([^`]+)`/.exec(message);
  return unknown ? `服务器的 hubd 版本较旧，不支持这个功能（${unknown[1]}），升级服务器后再用` : message;
}

/** 服务器报错时，还没确认的消息都算没发出去。 */
export function failSending(thread: Thread): void {
  if (!isSending(thread)) return;
  thread.items = thread.items.map((item) =>
    item.kind === "user" && (item.state === "sending" || item.state === "delivered") ? { ...item, state: "failed" } : item,
  );
  thread.phase = "idle";
  thread.turnStartedAt = undefined;
  thread.interruptAt = undefined;
}

/** 记下发出中断的时间。进程卡住时不会有回复，界面靠它判断要不要提示。 */
export function markInterrupting(thread: Thread, now = Date.now()): void {
  if (thread.phase !== "idle") thread.interruptAt ??= now;
}

export function removeItem(thread: Thread, id: string): void {
  thread.items = thread.items.filter((item) => item.id !== id);
}

/** 模型列表里的一项，字段来自 CLI 的 `initialize` 回复。 */
export interface ModelOption {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description?: string;
  /** 这个模型支持的推理强度，不支持时没有。 */
  supportedEffortLevels?: string[];
}

/** 推理强度的显示名，顺序同 CLI。`max` 不能写进设置文件，但会话里可以用。 */
export const EFFORTS: { value: string; label: string; description: string }[] = [
  { value: "low", label: "低", description: "最快，适合简单任务" },
  { value: "medium", label: "中", description: "速度和深度兼顾" },
  { value: "high", label: "高", description: "复杂任务想得更深" },
  { value: "xhigh", label: "超高", description: "难题，耗时和用量更多" },
  { value: "max", label: "最高", description: "最难的问题，最慢最贵" },
];

/** 当前模型可选的强度。匹配不到或还是内置的别名列表（没有 `resolvedModel`）时给出全部；CLI 说不支持的给空。 */
export function effortsFor(option?: ModelOption): typeof EFFORTS {
  if (option?.supportedEffortLevels) return EFFORTS.filter((e) => option.supportedEffortLevels!.includes(e.value));
  return option?.resolvedModel ? [] : EFFORTS;
}

/** 从事件里取模型列表。只认 `requestId` 这一次请求的回复，重放旧日志不能覆盖新列表。 */
export function parseModels(line: string, requestId: string): ModelOption[] | null {
  const models = controlReply(line, requestId)?.models;
  if (!Array.isArray(models)) return null;
  const valid = models.filter((m) => typeof m?.value === "string" && typeof m?.displayName === "string");
  return valid.length ? valid : null;
}

export function parseCommands(line: string, requestId: string): SlashCommand[] | null {
  const commands = controlReply(line, requestId)?.commands;
  if (!Array.isArray(commands)) return null;
  const valid = commands.filter((c) => typeof c?.name === "string");
  return valid.length ? valid : null;
}

/** 撤回请求的回复：`true` 已撤回，`false` 已经交给模型（来不及了）；不是这条请求的回复返回 null。 */
export function parseCancelled(line: string, requestId: string): boolean | null {
  const cancelled = controlReply(line, requestId)?.cancelled;
  return typeof cancelled === "boolean" ? cancelled : null;
}

/** 我们发出的控制请求的回复内容（按 `request_id` 认）。 */
function controlReply(line: string, requestId: string): Json | null {
  if (!line.includes(requestId)) return null;
  try {
    const event = JSON.parse(line);
    if (event.type !== "control_response" || event.response?.request_id !== requestId) return null;
    return event.response.response ?? null;
  } catch {
    return null;
  }
}

/** 可选的模型：去掉 CLI 的 `default` 项（它只是指向某个具体模型，那个模型另有一项）。 */
export const pickableModels = (models: ModelOption[]): ModelOption[] => models.filter((m) => m.value !== "default");

/** 默认模型：用户选过且还在列表里就用它，否则用 CLI 的 `default` 指向的那个具体模型；都不知道时 undefined（不带 `--model`）。 */
export function defaultModelFor(models: ModelOption[], saved?: string): string | undefined {
  const list = pickableModels(models);
  if (saved && list.some((m) => m.value === saved)) return saved;
  const cli = models.find((m) => m.value === "default")?.resolvedModel;
  return cli ? list.find((m) => m.resolvedModel === cli)?.value : undefined;
}

/** 默认强度：默认模型支持才用，否则跟随模型（undefined）。 */
export function defaultEffortFor(models: ModelOption[], model: string | undefined, saved?: string): string | undefined {
  if (!saved) return undefined;
  return effortsFor(findModel(models, model)).some((e) => e.value === saved) ? saved : undefined;
}

/**
 * 会话进程不在时选的模型 / 强度：写进 FIFO 会丢，存在本地（刷新、重启不丢），恢复进程时带上。
 * `effort: null` 表示跟随模型；没有这个字段表示没改过强度。
 */
export interface PendingChoice {
  model?: string;
  effort?: string | null;
}

/** 重放 `out` 之后套上还没生效的选择：界面显示用户选的，而不是进程上次用的。 */
export function applyPending(thread: Thread, pending?: PendingChoice): void {
  if (!pending) return;
  if (pending.model) thread.model = pending.model;
  if (pending.effort !== undefined) thread.effort = pending.effort ?? undefined;
}

/** 当前模型对应哪一项。`thread.model` 可能是别名，也可能是完整模型 ID。 */
export function findModel(models: ModelOption[], model?: string): ModelOption | undefined {
  if (!model) return undefined;
  return (
    models.find((m) => m.value === model) ??
    // “默认”和具体模型解析到同一个 ID 时，显示具体模型。
    models.find((m) => m.value !== "default" && m.resolvedModel === model) ??
    models.find((m) => m.resolvedModel === model) ??
    // 还没拿到列表时只有别名，完整 ID 里含别名就算匹配。
    models.find((m) => !m.resolvedModel && model.includes(m.value))
  );
}

const HUB_PORT = 7878;

/** 用户只填 IP，也接受带端口或完整地址。不合法返回 null。 */
export function hubUrl(input: string): string | null {
  const host = input.trim().replace(/^(wss?|https?):\/\//, "").replace(/\/.*$/, "");
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) return null;
  return `ws://${host.includes(":") ? host : `${host}:${HUB_PORT}`}/ws`;
}

/** 从完整地址还原给用户看的部分，默认端口不显示。 */
export function hubHost(url: string): string {
  return url.replace(/^wss?:\/\//, "").replace(/\/.*$/, "").replace(`:${HUB_PORT}`, "");
}

function controlResponse(requestId: string, response: Json): string {
  return JSON.stringify({
    type: "control_response",
    response: { subtype: "success", request_id: requestId, response },
  });
}

export function allowLine(ask: Ask, always = false): string {
  const response: Json = { behavior: "allow", updatedInput: ask.input };
  if (always && ask.suggestions?.length) response.updatedPermissions = ask.suggestions;
  return controlResponse(ask.requestId, response);
}

export function denyLine(ask: Ask, message: string): string {
  return controlResponse(ask.requestId, { behavior: "deny", message });
}

export function answerLine(ask: Ask, answers: Record<string, string>): string {
  return controlResponse(ask.requestId, {
    behavior: "allow",
    updatedInput: { ...ask.input, answers },
  });
}

function controlRequest(request: Json, tag: string = request.subtype): string {
  const id = `cchub-${tag}-${Date.now()}`;
  return JSON.stringify({ type: "control_request", request_id: id, request });
}

export const interruptLine = () => controlRequest({ subtype: "interrupt" });
export function initializeLine(requestId: string): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } });
}
export const stopTaskLine = (taskId: string) => controlRequest({ subtype: "stop_task", task_id: taskId });
/**
 * 撤回插入的消息：CLI 还没把它接进这一轮时（下一个工具结果之前）从队列里删掉，模型看不到。
 * 已经接进去就撤不回，回复 `cancelled: false`。2026-11-12 实测 claude 2.1.322。
 */
export function cancelInsertLine(requestId: string, uuid: string): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "cancel_async_message", message_uuid: uuid } });
}
const SET_MODEL_PREFIX = "cchub-set_model-";
export const setModelLine = (model: string) => controlRequest({ subtype: "set_model", model });
/**
 * 设推理强度：合并进 CLI 的 flag 设置层，只在当前进程有效，`--resume` 后要重发。`null` 恢复默认。
 * CLI 的回复只有 request_id，所以把值记在 request_id 里（`cchub-effort-high-<时间>`），重放 `out` 时据此恢复。
 */
export const setEffortLine = (effort: string | null) =>
  controlRequest({ subtype: "apply_flag_settings", settings: { effortLevel: effort } }, `effort-${effort ?? "default"}`);
const EFFORT_REQUEST = /^cchub-effort-([a-z]+)-\d+$/;

// 本会话经工具写入的改动，按文件汇总（不含 Bash 等命令产生的改动）。

export interface FileEdit {
  toolId: string;
  /** Write 是整个文件，没有旧内容。 */
  oldText: string;
  newText: string;
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  edits: FileEdit[];
}

const countLines = (text: string) => (text ? text.split("\n").length : 0);

/** 按首次改动的顺序列出文件。只算成功执行的调用（没有结果或出错的不算）。 */
export function collectChanges(items: Item[]): FileChange[] {
  const files = new Map<string, FileChange>();
  for (const item of items) {
    if (item.kind !== "tool" || item.isError || item.blocked || item.result == null) continue;
    const input = item.input;
    const path = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : "";
    if (!path) continue;
    const edits: FileEdit[] = [];
    if (item.name === "Edit" && typeof input.new_string === "string") {
      edits.push({ toolId: item.id, oldText: String(input.old_string ?? ""), newText: input.new_string });
    } else if (item.name === "MultiEdit" && Array.isArray(input.edits)) {
      for (const edit of input.edits as Json[]) edits.push({ toolId: item.id, oldText: String(edit?.old_string ?? ""), newText: String(edit?.new_string ?? "") });
    } else if (item.name === "Write" && typeof input.content === "string") {
      edits.push({ toolId: item.id, oldText: "", newText: input.content });
    } else continue;
    const file = files.get(path) ?? { path, added: 0, removed: 0, edits: [] };
    for (const edit of edits) {
      file.added += countLines(edit.newText);
      file.removed += countLines(edit.oldText);
      file.edits.push(edit);
    }
    files.set(path, file);
  }
  return [...files.values()];
}

export interface ChangeGroup {
  /** 项目内是相对目录（根目录为空串），项目外是完整目录；都以 `/` 结尾。 */
  dir: string;
  outside: boolean;
  files: (FileChange & { name: string })[];
  added: number;
  removed: number;
}

/**
 * 改动窗格按目录分组，只分一层：组标题是目录，行里只放文件名，窄窗格里也看得清。
 * 项目内的组在前（根目录最前），项目外的排在后面；目录和文件名按字母排。
 */
export function groupChanges(changes: FileChange[], cwd: string | undefined): ChangeGroup[] {
  const root = cwd?.replace(/\/+$/, "");
  const groups = new Map<string, ChangeGroup>();
  for (const file of changes) {
    const outside = !root || !file.path.startsWith(`${root}/`);
    const rel = outside ? file.path : file.path.slice(root!.length + 1);
    const cut = rel.lastIndexOf("/") + 1;
    const dir = rel.slice(0, cut);
    const key = `${outside ? 1 : 0}${dir}`;
    const group = groups.get(key) ?? { dir, outside, files: [], added: 0, removed: 0 };
    group.files.push({ ...file, name: rel.slice(cut) });
    group.added += file.added;
    group.removed += file.removed;
    groups.set(key, group);
  }
  const list = [...groups.values()];
  for (const g of list) g.files.sort((a, b) => a.name.localeCompare(b.name));
  return list.sort((a, b) => Number(a.outside) - Number(b.outside) || a.dir.localeCompare(b.dir));
}

/** 最近一次提交的方案：方案确认请求或 ExitPlanMode 调用里的 `plan`。 */
export function latestPlan(thread: Thread): string | undefined {
  for (let i = thread.items.length - 1; i >= 0; i--) {
    const item = thread.items[i];
    if (item.kind === "tool" && item.name === "ExitPlanMode" && typeof item.input.plan === "string" && item.input.plan) return item.input.plan;
    if (item.kind === "ask") {
      const plan = thread.asks.get(item.requestId)?.plan;
      if (plan) return plan;
    }
  }
  return undefined;
}

export type RenderBlock = { kind: "item"; item: Item } | { kind: "tools"; id: string; tools: ToolItem[] };

/**
 * 连续两个以上的工具调用合并成一块（“用了 N 个工具”）。中间夹着的空思考块不显示，不打断合并；
 * 审批、提问、方案卡片不是工具条目，永远单独显示。
 */
export function groupTools(items: Item[]): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  let run: ToolItem[] = [];
  const flush = () => {
    if (run.length >= 2) blocks.push({ kind: "tools", id: `g-${run[0].id}`, tools: run });
    else for (const tool of run) blocks.push({ kind: "item", item: tool });
    run = [];
  };
  for (const item of items) {
    if (item.kind === "tool") run.push(item);
    else if (item.kind === "thinking" && !item.text.trim()) continue;
    else {
      flush();
      blocks.push({ kind: "item", item });
    }
  }
  flush();
  return blocks;
}
