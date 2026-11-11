import type { ConnectionState } from "./generated/ConnectionState";
import type { SessionInfo } from "./generated/SessionInfo";
import type { UiEvent } from "./generated/UiEvent";
import type { Hub } from "./hub";
import { isNarrow } from "./platform";
import { sortKey } from "./sidebar";
import { parseUsage, type UsageStats } from "./usage";
import {
  addSending,
  allowLine,
  answerLine,
  apply,
  denyLine,
  failSending,
  mergeRateLimits,
  initializeLine,
  interruptLine,
  markInterrupting,
  newThread,
  onProcessExit,
  parseCommands,
  parseModels,
  parseRateLimits,
  runningTasks,
  removeItem,
  setEffortLine,
  setModelLine,
  stopTaskLine,
  userLine,
  type Ask,
  type ModelOption,
  type RateLimits,
  type SlashCommand,
  type Thread,
} from "./model";

export interface Session {
  id: string;
  title: string;
  cwd?: string;
  running: boolean;
  updated: number;
  /** 最后一次用户发言时间（Unix 秒），侧边栏排序用；服务器没报时为 null，退回 `updated`。 */
  active: number | null;
  /** 服务器报的日志最后更新时间（Unix 秒），重放时不会变，用来判断额度事件的新旧。 */
  logUpdated: number;
  deviceOnline: boolean;
  attached: boolean;
  thread: Thread;
  /** 这个项目的 `/` 命令。不同项目的技能不同。 */
  commands?: SlashCommand[];
  /** 进程没在运行时选的模型：写进 FIFO 会丢，等下次启动时在用户消息之前补发。 */
  pendingModel?: string;
  /** 已关闭：不在侧边栏显示，用 `/resume` 找回。 */
  archived: boolean;
}

const URL_KEY = "cchub.url";
const MODELS_KEY = "cchub.models";
const CWD_KEY = "cchub.cwd";
const COMMANDS_KEY = "cchub.commands";
const LIMITS_KEY = "cchub.limits";
const DRAFTS_KEY = "cchub.drafts";
const TASK_TIMES_KEY = "cchub.taskTimes";
const MAX_TASK_TIMES = 200;
/** 新会话发出后刷新列表的时间点：haiku 起标题一般 4～6 秒。 */
const TITLE_REFRESH_MS = [7000, 20000];
/** 新会话页的草稿。 */
export const NEW_DRAFT = "";

export type PaneId = "changes" | "tasks" | "todos" | "plan" | "info" | "usage";
const PANES: PaneId[] = ["changes", "tasks", "todos", "plan", "info", "usage"];
/** 不依赖会话的窗格，新会话页也能打开。 */
export const GLOBAL_PANES: PaneId[] = ["usage"];
const PANE_KEY = "cchub.pane";
const storedPane = (): PaneId | null => PANES.find((p) => p === localStorage.getItem(PANE_KEY)) ?? null;
const VERBOSE_KEY = "cchub.verbose";

function loadJson<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? "null") as T) ?? fallback;
  } catch {
    return fallback;
  }
}

/** 还没有任何会话返回过模型列表时用，只放 CLI 长期支持的别名。 */
const FALLBACK_MODELS: ModelOption[] = [
  { value: "default", displayName: "默认" },
  { value: "opus", displayName: "Opus" },
  { value: "sonnet", displayName: "Sonnet" },
  { value: "haiku", displayName: "Haiku" },
];

function loadModels(): ModelOption[] {
  const saved = loadJson<ModelOption[]>(MODELS_KEY, []);
  return Array.isArray(saved) && saved.length ? saved : FALLBACK_MODELS;
}

export interface BrowseState {
  device: string | null;
  path: string | null;
  parent: string | null;
  entries: string[];
  error: string | null;
  loading: boolean;
}

export class Store {
  connection: ConnectionState | null = null;
  sessions = new Map<string, Session>();
  selected: string | null = null;
  memAvailableMb: number | null = null;
  error: string | null = null;
  url = localStorage.getItem(URL_KEY) ?? "";
  showSettings = this.url === "";
  models = loadModels();
  commands = loadJson<SlashCommand[]>(COMMANDS_KEY, []);
  limits = loadJson<RateLimits>(LIMITS_KEY, {});
  /** 右侧窗格：改动、后台任务、待办、方案、会话信息。记在本地，切换会话时保留。 */
  pane: PaneId | null = isNarrow() ? null : storedPane();
  /** 详细档：工具调用逐条展开显示，不合并（Ctrl+O 切换）。 */
  verbose = localStorage.getItem(VERBOSE_KEY) === "1";
  /** 窄屏下会话列表是否展开，手机上打开 App 先看列表。 */
  showDrawer = isNarrow();
  /** 等确认结束的会话。 */
  stopping: Session | null = null;
  /** 确认结束后是关闭会话还是只结束进程。 */
  archiveAfterStop = false;
  /** `/resume` 弹窗。 */
  showResume = false;
  taskOutput: { path: string; text: string | null; error: string | null } | null = null;
  /** 整体用量（使用情况窗格），打开窗格或点刷新时向服务器要一次。 */
  usage: { stats: UsageStats | null; error: string | null; loading: boolean } = { stats: null, error: null, loading: false };
  /** 新会话要用的工作区，服务器上的路径。 */
  cwd = localStorage.getItem(CWD_KEY) ?? "";
  showWorkspace = false;
  browse: BrowseState = { device: null, path: null, parent: null, entries: [], error: null, loading: false };
  mounting = false;
  mountError: string | null = null;
  version = 0;

  private listeners = new Set<() => void>();
  private frame = 0;
  private browsesInFlight = 0;
  /** 等 `initialize` 回复的请求，只认当次的，重放旧日志不算。 */
  private initRequests = new Map<string, Session>();
  private initialized = new Set<string>();
  private drafts = loadJson<Record<string, string>>(DRAFTS_KEY, {});
  private taskTimes = loadJson<Record<string, number>>(TASK_TIMES_KEY, {});

  constructor(private hub: Hub) {
    void hub.onEvent((events) => {
      for (const event of events) this.onEvent(event);
      this.changed();
    });
    if (this.url) void this.connect(this.url);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = () => this.version;

  /** 一帧最多刷新一次界面。隐藏时 rAF 不触发，模型照常更新，显示时补一次。 */
  private changed(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.version++;
      for (const listener of this.listeners) listener();
    });
  }

  async connect(url: string): Promise<void> {
    this.url = url;
    localStorage.setItem(URL_KEY, url);
    // 窗口重建时连接还在，要主动问一次状态。
    this.setConnection(await this.hub.connect(url));
    this.changed();
  }

  toggleSettings(): void {
    this.showSettings = !this.showSettings;
    this.changed();
  }

  private setConnection(state: ConnectionState): void {
    this.connection = state;
    if (state === "connected") {
      this.showSettings = false;
      this.refresh();
    }
  }

  refresh(): void {
    void this.send({ type: "list" });
  }

  private send(msg: Parameters<Hub["send"]>[0]): Promise<void> {
    return this.hub.send(msg).catch((error) => {
      this.error = String(error);
      this.changed();
    });
  }

  private session(info: SessionInfo): Session {
    let session = this.sessions.get(info.id);
    if (!session) {
      session = {
        id: info.id,
        title: info.title ?? "未命名会话",
        running: false,
        updated: 0,
        active: info.active,
        logUpdated: 0,
        archived: false,
        deviceOnline: true,
        attached: false,
        thread: newThread(),
      };
      this.sessions.set(info.id, session);
    }
    return session;
  }

  private onEvent(event: UiEvent): void {
    switch (event.type) {
      case "connection":
        this.setConnection(event.state);
        break;
      case "sessions":
        this.memAvailableMb = event.mem_available_mb;
        for (const info of event.sessions) {
          const session = this.session(info);
          session.title = info.title ?? session.title;
          session.cwd = info.cwd ?? session.cwd;
          session.updated = info.updated ?? session.updated;
          session.active = info.active ?? session.active;
          session.logUpdated = info.updated ?? session.logUpdated;
          session.archived = info.archived ?? false;
          session.running = info.running;
          // 运行中的都订阅，这样才能知道哪个在等人决定。
          if (info.running || info.id === this.selected) this.attach(session);
        }
        {
          // 窗口一打开就更新模型列表，新会话页也要用。
          const running = event.sessions.find((info) => info.running);
          const session = running && this.sessions.get(running.id);
          if (session) this.requestInit(session);
        }
        break;
      case "event": {
        const session = this.sessions.get(event.session);
        if (session) {
          this.takeInit(event.payload);
          this.takeLimits(session, event.seq, event.payload);
          apply(session.thread, event.payload);
          this.stampTasks(session, event.payload);
          // 不改 active：事件到达不能影响侧边栏顺序。
          session.updated = Math.floor(Date.now() / 1000);
        }
        break;
      }
      case "status": {
        const session = this.sessions.get(event.session);
        if (session) {
          session.running = event.running;
          if (!event.running) onProcessExit(session.thread);
        }
        break;
      }
      case "device": {
        const session = this.sessions.get(event.session);
        if (session) session.deviceOnline = event.online;
        break;
      }
      case "browse":
        this.browsesInFlight = Math.max(0, this.browsesInFlight - 1);
        // 连点时只显示最后一次的结果。
        if (!this.browsesInFlight) this.browse = { ...event, loading: false };
        break;
      case "mounted":
        this.mounting = false;
        if (event.cwd) this.chooseWorkspace(event.cwd);
        else this.mountError = event.error ?? "挂载失败";
        break;
      case "task_output":
        if (this.taskOutput?.path === event.path) this.taskOutput = { path: event.path, text: event.text, error: event.error };
        break;
      case "usage": {
        const stats = event.stats ? parseUsage(event.stats) : null;
        const error = event.error ?? (stats ? null : "统计结果的格式不对，服务器上的统计命令可能和桌面端版本不匹配");
        // 失败时保留上一次的结果，界面同时提示错误。
        this.usage = { stats: stats ?? this.usage.stats, error, loading: false };
        break;
      }
      case "error":
        this.error = event.message;
        if (event.session) {
          const session = this.sessions.get(event.session);
          if (session) {
            failSending(session.thread);
            // 启动可能失败了，问一次真实状态，下次发送才会重新启动进程。
            this.refresh();
          }
        }
        break;
    }
  }

  private takeInit(line: string): void {
    for (const [requestId, session] of this.initRequests) {
      if (!line.includes(requestId)) continue;
      this.initRequests.delete(requestId);
      const models = parseModels(line, requestId);
      if (models) {
        this.models = models;
        localStorage.setItem(MODELS_KEY, JSON.stringify(models));
      }
      const commands = parseCommands(line, requestId);
      if (commands) {
        session.commands = commands;
        this.commands = commands;
        localStorage.setItem(COMMANDS_KEY, JSON.stringify(commands));
      }
      return;
    }
  }

  private takeLimits(session: Session, seq: number, line: string): void {
    const rank = session.running ? Number.MAX_SAFE_INTEGER : session.logUpdated;
    const next = parseRateLimits(line, { session: session.id, seq, rank });
    if (!next) return;
    this.limits = mergeRateLimits(this.limits, next);
    localStorage.setItem(LIMITS_KEY, JSON.stringify(this.limits));
  }

  /** 任务事件没有时间戳，首次看到时记下来，窗口重建后重放还能用。 */
  private stampTasks(session: Session, line: string): void {
    if (!line.includes("task")) return;
    let changed = false;
    for (const task of session.thread.tasks.values()) {
      if (task.startedAt) continue;
      if (!this.taskTimes[task.id]) {
        // 重放时才第一次看到已结束的任务，开始时间未知。
        if (task.endedAt) continue;
        this.taskTimes[task.id] = Date.now();
        changed = true;
      }
      task.startedAt = this.taskTimes[task.id];
    }
    if (!changed) return;
    const entries = Object.entries(this.taskTimes);
    if (entries.length > MAX_TASK_TIMES) this.taskTimes = Object.fromEntries(entries.slice(-MAX_TASK_TIMES));
    localStorage.setItem(TASK_TIMES_KEY, JSON.stringify(this.taskTimes));
  }

  /** 问 CLI 当前有哪些模型和命令。不调用模型，也不写进会话记录；每个进程问一次就够。 */
  private requestInit(session: Session): void {
    if (this.initialized.has(session.id)) return;
    this.initialized.add(session.id);
    const requestId = `cchub-init-${crypto.randomUUID()}`;
    this.initRequests.set(requestId, session);
    void this.send({ type: "input", session: session.id, line: initializeLine(requestId) });
  }

  draft(key: string): string {
    return this.drafts[key] ?? "";
  }

  /** 草稿存在本地：切换会话和关窗（WebView 会销毁）都不能丢。 */
  setDraft(key: string, text: string): void {
    if (text) this.drafts[key] = text;
    else delete this.drafts[key];
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(this.drafts));
  }

  commandsFor(session?: Session): SlashCommand[] {
    const commands = session?.commands ?? this.commands;
    return commands.some((c) => c.name === "resume") ? commands : [RESUME_COMMAND, ...commands];
  }

  private attach(session: Session): void {
    if (session.attached) return;
    session.attached = true;
    void this.send({ type: "attach", session: session.id, after: 0 });
  }

  select(id: string | null): void {
    this.selected = id;
    this.showSettings = false;
    this.showDrawer = false;
    const session = id ? this.sessions.get(id) : undefined;
    if (session) {
      this.attach(session);
      if (session.running) this.requestInit(session);
    }
    this.changed();
  }

  openDrawer(): void {
    this.showDrawer = true;
    this.changed();
  }

  /** 系统返回键：先关弹窗，再回会话列表；已在列表时返回 false，由系统退到后台。 */
  back(): boolean {
    if (this.stopping) this.cancelStop();
    else if (this.showResume) this.closeResume();
    else if (this.pane) this.closePane();
    else if (this.showWorkspace) this.closeWorkspace();
    else if (this.showSettings && this.url) this.toggleSettings();
    else if (!this.showDrawer) this.openDrawer();
    else return false;
    return true;
  }

  dismissError(): void {
    this.error = null;
    this.changed();
  }

  openWorkspace(): void {
    this.showWorkspace = true;
    this.mountError = null;
    this.browseTo(null, null);
  }

  closeWorkspace(): void {
    this.showWorkspace = false;
    this.changed();
  }

  browseTo(device: string | null, path: string | null): void {
    this.browse = { ...this.browse, device, loading: true, error: null };
    this.browsesInFlight++;
    this.mountError = null;
    void this.send({ type: "browse", device, path });
    this.changed();
  }

  mount(device: string, path: string): void {
    this.mounting = true;
    this.mountError = null;
    void this.send({ type: "mount", device, path });
    this.changed();
  }

  chooseWorkspace(cwd: string): void {
    this.cwd = cwd;
    this.showWorkspace = false;
    localStorage.setItem(CWD_KEY, cwd);
    this.changed();
  }

  /** 选过的工作区，最近用过的在前。临时目录是测试留下的，不列出来。 */
  recentWorkspaces(): string[] {
    const sessions = [...this.sessions.values()].sort((a, b) => sortKey(b) - sortKey(a));
    const cwds = sessions.flatMap((s) => (s.cwd && !s.cwd.startsWith("/tmp/") ? [s.cwd] : []));
    return [...new Set(cwds)];
  }

  private sendUser(session: Session, text: string): void {
    const id = crypto.randomUUID();
    addSending(session.thread, id, text);
    session.updated = session.active = Math.floor(Date.now() / 1000);
    void this.hub.send({ type: "input", session: session.id, line: userLine(text, id) }).catch((error) => {
      failSending(session.thread);
      this.error = String(error);
      this.changed();
    });
  }

  newSession(text: string, cwd: string, model: string, effort?: string): void {
    const id = crypto.randomUUID();
    const title = text.split("\n")[0].slice(0, 40);
    const session = this.session({ id, title, cwd, running: true, updated: null, active: Math.floor(Date.now() / 1000), archived: false });
    session.cwd = cwd;
    session.running = true;
    session.attached = true;
    this.selected = id;
    this.showDrawer = false;
    // 第一条消息交给 hubd 在后台概括成标题（`/` 命令不概括），几秒后刷新列表拿到。
    const prompt = text.trimStart().startsWith("/") ? undefined : text;
    void this.send({ type: "start", session: id, cwd, title, prompt });
    if (prompt) for (const delay of TITLE_REFRESH_MS) setTimeout(() => this.refresh(), delay);
    void this.send({ type: "attach", session: id, after: 0 });
    this.requestInit(session);
    if (model) {
      session.thread.model = model;
      void this.send({ type: "input", session: id, line: setModelLine(model) });
    }
    if (effort) {
      session.thread.effort = effort;
      void this.send({ type: "input", session: id, line: setEffortLine(effort) });
    }
    this.sendUser(session, text);
    this.refresh();
    this.changed();
  }

  sendText(session: Session, text: string): void {
    if (isResumeCommand(text)) {
      this.openResume();
      return;
    }
    if (!session.running) {
      // 进程已回收：用记录的 ID 恢复，消息写进 FIFO 等它读。
      void this.send({
        type: "start",
        session: session.id,
        resume: session.thread.claudeSessionId,
      });
      session.running = true;
      this.initialized.delete(session.id);
      this.requestInit(session);
      if (session.pendingModel) {
        void this.send({ type: "input", session: session.id, line: setModelLine(session.pendingModel) });
        session.pendingModel = undefined;
      }
      // 强度只存在进程的 flag 设置层里，`--resume` 后会回到默认，每次恢复都要重发。
      if (session.thread.effort) void this.send({ type: "input", session: session.id, line: setEffortLine(session.thread.effort) });
    }
    // `/model` 回复成功但不生效，要走控制消息。其他命令都原样交给 CLI。
    const model = /^\/model\s+(\S+)\s*$/.exec(text)?.[1];
    if (model) {
      this.setModel(session, model);
      return;
    }
    this.sendUser(session, text);
    this.changed();
  }

  retry(session: Session, id: string, text: string): void {
    removeItem(session.thread, id);
    this.sendText(session, text);
  }

  private reply(session: Session, ask: Ask, line: string): void {
    ask.sent = true;
    void this.send({ type: "input", session: session.id, line });
    this.changed();
  }

  allow = (session: Session, ask: Ask, always = false) =>
    this.reply(session, ask, allowLine(ask, always));

  deny = (session: Session, ask: Ask, message: string) =>
    this.reply(session, ask, denyLine(ask, message));

  answer = (session: Session, ask: Ask, answers: Record<string, string>) =>
    this.reply(session, ask, answerLine(ask, answers));

  interrupt(session: Session): void {
    markInterrupting(session.thread);
    void this.send({ type: "input", session: session.id, line: interruptLine() });
    this.changed();
  }

  /** 正在干活时先确认，空闲时结束没有损失，直接结束。 */
  askStop(session: Session): void {
    const working = session.thread.phase !== "idle" || runningTasks(session.thread).length > 0;
    if (working) {
      this.stopping = session;
      this.changed();
    } else this.stopSession(session);
  }

  cancelStop(): void {
    this.stopping = null;
    this.archiveAfterStop = false;
    this.changed();
  }

  /** 结束进程。之后再发消息会用 `--resume` 接着聊。 */
  stopSession(session: Session): void {
    this.stopping = null;
    void this.send({ type: "stop", session: session.id });
    session.running = false;
    onProcessExit(session.thread);
    // 进程没回传的消息不算送达，留下重试入口。
    failSending(session.thread);
    this.initialized.delete(session.id);
    // 不刷新列表：`stop` 可能还没执行完，会把会话又标回运行中。状态由 hubd 推送。
    this.changed();
  }

  /** 关闭会话：从侧边栏移走，进程在运行就一起结束。正在干活时先确认。 */
  askArchive(session: Session): void {
    const working = session.thread.phase !== "idle" || runningTasks(session.thread).length > 0;
    if (working) {
      this.stopping = session;
      this.archiveAfterStop = true;
      this.changed();
    } else this.archive(session);
  }

  archive(session: Session): void {
    this.stopping = null;
    this.archiveAfterStop = false;
    void this.send({ type: "archive", session: session.id, archived: true });
    if (session.running) {
      session.running = false;
      onProcessExit(session.thread);
      failSending(session.thread);
      this.initialized.delete(session.id);
    }
    session.archived = true;
    if (this.selected === session.id) this.selected = null;
    this.changed();
  }

  openResume(): void {
    this.showResume = true;
    this.changed();
  }

  closeResume(): void {
    this.showResume = false;
    this.changed();
  }

  /** 找回关闭的会话：回到侧边栏并打开，发消息时用 `--resume` 接着聊。 */
  unarchive(session: Session): void {
    void this.send({ type: "archive", session: session.id, archived: false });
    session.archived = false;
    this.showResume = false;
    this.select(session.id);
    this.changed();
  }

  archivedSessions(): Session[] {
    return [...this.sessions.values()].filter((s) => s.archived).sort((a, b) => sortKey(b) - sortKey(a));
  }

  openPane(pane: PaneId): void {
    this.pane = pane;
    localStorage.setItem(PANE_KEY, pane);
    this.changed();
  }

  /** 同一个窗格再点一次就关上。 */
  togglePane(pane: PaneId): void {
    if (this.pane === pane) this.closePane();
    else this.openPane(pane);
  }

  closePane(): void {
    this.pane = null;
    this.taskOutput = null;
    localStorage.removeItem(PANE_KEY);
    this.changed();
  }

  openTasks(): void {
    this.openPane("tasks");
  }

  toggleVerbose(): void {
    this.verbose = !this.verbose;
    localStorage.setItem(VERBOSE_KEY, this.verbose ? "1" : "0");
    this.changed();
  }

  stopTask(session: Session, taskId: string): void {
    void this.send({ type: "input", session: session.id, line: stopTaskLine(taskId) });
  }

  requestUsage(): void {
    if (this.usage.loading) return;
    this.usage = { ...this.usage, loading: true, error: null };
    // 按客户端时区切日期：东八区传 480。
    void this.hub.send({ type: "usage", tz_offset: -new Date().getTimezoneOffset() }).catch((error) => {
      this.usage = { ...this.usage, loading: false, error: String(error) };
      this.changed();
    });
    this.changed();
  }

  readTaskOutput(path: string): void {
    if (this.taskOutput?.path !== path) this.taskOutput = { path, text: null, error: null };
    void this.send({ type: "task_output", path });
    this.changed();
  }

  setModel(session: Session, model: string): void {
    // `/model` 回复成功但不生效，必须走控制消息；它不进会话记录，模型看不到。
    // 进程已回收时写进 FIFO 会丢，先记下，下次发消息恢复进程时补发。
    if (session.running) void this.send({ type: "input", session: session.id, line: setModelLine(model) });
    else session.pendingModel = model;
    session.thread.model = model;
    this.changed();
  }

  /** `undefined` 恢复模型默认。进程没在运行时只记下，恢复时重发。 */
  setEffort(session: Session, effort?: string): void {
    if (session.running) void this.send({ type: "input", session: session.id, line: setEffortLine(effort ?? null) });
    session.thread.effort = effort;
    this.changed();
  }
}

const RESUME_COMMAND: SlashCommand = { name: "resume", description: "找回已关闭的会话" };

/** `/resume` 由界面处理（CLI 的无界面模式没有这个命令），不发给 CLI。 */
export const isResumeCommand = (text: string): boolean => /^\/resume\s*$/.test(text.trim());

/** `/mnt/<设备>/...` 是挂载的设备目录，其他是服务器本地目录。 */
export function describeCwd(cwd?: string): { project: string; device: string } {
  if (!cwd) return { project: "", device: "" };
  const parts = cwd.split("/").filter(Boolean);
  const project = parts[parts.length - 1] ?? "/";
  return { project, device: parts[0] === "mnt" && parts[1] ? parts[1] : "服务器" };
}
