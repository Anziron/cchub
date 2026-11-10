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

export type Item =
  | { kind: "user"; id: string; text: string; state?: "sending" | "failed" }
  | { kind: "text"; id: string; text: string; live: boolean }
  | { kind: "thinking"; id: string; text: string }
  | ToolItem
  | { kind: "ask"; id: string; requestId: string }
  | { kind: "interrupted"; id: string }
  /** 本地命令的输出（如切换模型），不是用户说的话，也不会让模型开始回复。 */
  | { kind: "notice"; id: string; text: string }
  | { kind: "error"; id: string; text: string };

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
  cwd?: string;
  /** 所有任务。转入后台的会在一轮结束后继续跑，一轮结束不等于任务完成。 */
  tasks: Map<string, Task>;
  /** 上下文已用 token 和上限。 */
  context?: { used: number; max?: number };
  lastTurn?: { durationMs?: number; outputTokens?: number };
}

const MAX_RESULT = 64 * 1024;

export function newThread(): Thread {
  return {
    items: [],
    asks: new Map(),
    todos: [],
    phase: "idle",
    tasks: new Map(),
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
    .map((part: Json) => part.text ?? part.tool_name ?? "")
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
 * 本地命令的输出：`set_model` 时 CLI 回显 `<local-command-stdout>Set model to …`，
 * 会话记录里还带着 `/model` 命令本身。其他带命令名的仍按内置命令回传处理。
 */
function localNotice(content: string): string | null {
  const output = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(content)?.[1]?.trim();
  if (output === undefined) return null;
  const command = commandText(content);
  if (command && !command.startsWith("/model")) return null;
  const model = /^Set model to `?([^`]+?)`?$/.exec(output)?.[1];
  return model ? `已切换模型：${model}` : output;
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
    return { fiveHour: pick(windows.five_hour), sevenDay: pick(windows.seven_day) };
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
  return { fiveHour: newer(old.fiveHour, next.fiveHour), sevenDay: newer(old.sevenDay, next.sevenDay) };
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

function onUser(thread: Thread, event: Json): void {
  const content = event.message?.content;
  if (typeof content === "string") {
    if (event.parent_tool_use_id) return;
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
      thread.items.push({ kind: "notice", id: event.uuid ?? `n${thread.items.length}`, text: notice });
      return;
    }
    const command = commandText(content);
    // 发送时已经先显示了，回传只是确认送达。
    const sent = findLast(thread, (item) => item.kind === "user" && item.id === event.uuid);
    if (sent >= 0) {
      replaceItem(thread, sent, { kind: "user", id: event.uuid, text: command ?? content });
      if (command) return;
    } else if (command) {
      // 内置命令的回传排在回复后面，重放时放回回复前面。
      const last = thread.items.length - 1;
      const at = thread.items[last]?.kind === "text" ? last : thread.items.length;
      thread.items.splice(at, 0, { kind: "user", id: event.uuid ?? `u${thread.items.length}`, text: command });
      return;
    } else {
      thread.items.push({ kind: "user", id: event.uuid ?? `u${thread.items.length}`, text: content });
    }
    thread.phase = "thinking";
    thread.activeTool = undefined;
    const at = Date.parse(event.timestamp ?? "");
    thread.turnStartedAt = Number.isNaN(at) ? Date.now() : at;
    return;
  }
  if (!Array.isArray(content)) return;
  for (const part of content as Json[]) {
    if (part.type === "tool_result") {
      onToolResult(thread, part);
      thread.phase = "thinking";
      thread.activeTool = undefined;
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

function onAssistant(thread: Thread, event: Json): void {
  const message: Json = event.message ?? {};
  const parent: string | null = event.parent_tool_use_id ?? null;
  if (message.model && !parent) thread.model = message.model;
  const usage: Json | undefined = message.usage;
  if (usage && !parent) {
    const used = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    if (used) thread.context = { ...thread.context, used };
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
  if (event.is_error && !interrupted) {
    const errors = Array.isArray(event.errors) ? event.errors.join("\n") : "";
    thread.items.push({
      kind: "error",
      id: event.uuid ?? `e${thread.items.length}`,
      text: event.result || errors || "这一轮出错了",
    });
  }
}

/** 应用一行事件。不认识的事件直接忽略，CLI 新增类型不影响显示。 */
export function apply(thread: Thread, line: string): void {
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
        thread.cwd = event.cwd;
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
    case "control_request":
      if (event.request?.subtype === "can_use_tool") addAsk(thread, event);
      break;
    case "control_cancel_request":
      removeAsk(thread, event.request_id);
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

export function userLine(text: string, uuid?: string): string {
  return JSON.stringify({ type: "user", ...(uuid ? { uuid } : {}), message: { role: "user", content: text } });
}

/** 发送时立刻显示，不等服务器回传。回传带同一个 uuid，到时候转为已送达。 */
export function addSending(thread: Thread, id: string, text: string): void {
  thread.items.push({ kind: "user", id, text, state: "sending" });
  if (thread.phase === "idle") {
    thread.phase = "thinking";
    thread.activeTool = undefined;
    thread.turnStartedAt = Date.now();
  }
}

export const isSending = (thread: Thread): boolean =>
  thread.items.some((item) => item.kind === "user" && item.state === "sending");

/** 服务器报错时，还没确认的消息都算没发出去。 */
export function failSending(thread: Thread): void {
  if (!isSending(thread)) return;
  thread.items = thread.items.map((item) =>
    item.kind === "user" && item.state === "sending" ? { ...item, state: "failed" } : item,
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
}

/** 从事件里取模型列表。只认 `requestId` 这一次请求的回复，重放旧日志不能覆盖新列表。 */
export function parseModels(line: string, requestId: string): ModelOption[] | null {
  const models = initializeReply(line, requestId)?.models;
  if (!Array.isArray(models)) return null;
  const valid = models.filter((m) => typeof m?.value === "string" && typeof m?.displayName === "string");
  return valid.length ? valid : null;
}

export function parseCommands(line: string, requestId: string): SlashCommand[] | null {
  const commands = initializeReply(line, requestId)?.commands;
  if (!Array.isArray(commands)) return null;
  const valid = commands.filter((c) => typeof c?.name === "string");
  return valid.length ? valid : null;
}

function initializeReply(line: string, requestId: string): Json | null {
  if (!line.includes(requestId)) return null;
  try {
    const event = JSON.parse(line);
    if (event.type !== "control_response" || event.response?.request_id !== requestId) return null;
    return event.response.response ?? null;
  } catch {
    return null;
  }
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

function controlRequest(request: Json): string {
  const id = `cchub-${request.subtype}-${Date.now()}`;
  return JSON.stringify({ type: "control_request", request_id: id, request });
}

export const interruptLine = () => controlRequest({ subtype: "interrupt" });
export function initializeLine(requestId: string): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } });
}
export const stopTaskLine = (taskId: string) => controlRequest({ subtype: "stop_task", task_id: taskId });
export const setModelLine = (model: string) => controlRequest({ subtype: "set_model", model });
