import type { ConnectionState } from "./generated/ConnectionState.ts";
import type { SessionInfo } from "./generated/SessionInfo.ts";
import type { UiEvent } from "./generated/UiEvent.ts";
import type { Hub } from "./hub.ts";
import { isNarrow } from "./platform.ts";
import { sortKey } from "./sidebar.ts";
import { parseUsage, type UsageStats } from "./usage.ts";
import { afterTurn, confirmInserted, joinQueued, settleCancel, settleInsert, type Queued } from "./queue.ts";
import { dropRef, mountTarget, type DropRef } from "./paths.ts";
import { choiceAck, controlNotice, inputNotice, replyAck, resumeChoice, startModel, userAck, type AckResult } from "./uplink.ts";
import type { DeviceInfo } from "./generated/DeviceInfo.ts";
import {
  addSending,
  allowLine,
  answerLine,
  apply,
  cancelInsertLine,
  denyLine,
  serverErrorText,
  failSending,
  failUser,
  markDelivered,
  cachedLimits,
  limitRank,
  mergeRateLimits,
  initializeLine,
  interruptLine,
  markInterrupting,
  newThread,
  onProcessExit,
  parseCancelled,
  parseCommands,
  applyPending,
  defaultEffortFor,
  defaultModelFor,
  parseModels,
  parseRateLimits,
  runningTasks,
  removeItem,
  setEffortLine,
  setModelLine,
  stopTaskLine,
  userLine,
  userState,
  type Ask,
  type ModelOption,
  type PendingChoice,
  type RateLimits,
  type SlashCommand,
  type Thread,
} from "./model.ts";

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
  /** 最近一次订阅时 hubd 报的日志长度：偏移更小的事件是重放的历史。旧版 hubd 不报。 */
  live?: number;
  deviceOnline: boolean;
  attached: boolean;
  thread: Thread;
  /** 这个项目的 `/` 命令。不同项目的技能不同。 */
  commands?: SlashCommand[];
  /** 已关闭：不在侧边栏显示，用 `/resume` 找回。 */
  archived: boolean;
  /** 一轮进行中发的消息，见 `queue.ts`。 */
  queue: Queued[];
}

const URL_KEY = "cchub.url";
const MODELS_KEY = "cchub.models";
const CWD_KEY = "cchub.cwd";
const COMMANDS_KEY = "cchub.commands";
/** 用户自选的默认模型和强度，每台设备各存一份。 */
const DEFAULTS_KEY = "cchub.defaults";
/** 会话进程不在时选的模型 / 强度（按会话 ID），恢复进程时带上，见 `PendingChoice`。 */
const PENDING_KEY = "cchub.pending";
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
const VIEW_KEY = "cchub.view";
const SIDE_COLLAPSED_KEY = "cchub.sideCollapsed";
const HISTORY_MAX = 50;
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
  /** 用户选的默认模型和强度（可能已不在模型列表里，用 `defaultModel` / `defaultEffort` 取有效值）。 */
  defaults = loadJson<{ model?: string; effort?: string }>(DEFAULTS_KEY, {});
  private pending = loadJson<Record<string, PendingChoice>>(PENDING_KEY, {});
  limits = cachedLimits(loadJson<RateLimits>(LIMITS_KEY, {}));
  /** 右侧窗格：改动、后台任务、待办、方案、会话信息。记在本地，切换会话时保留。 */
  pane: PaneId | null = isNarrow() ? null : storedPane();
  /** 详细档：工具调用逐条展开显示，不合并（Ctrl+O 切换）。 */
  verbose = localStorage.getItem(VERBOSE_KEY) === "1";
  /** 窄屏下会话列表是否展开，手机上打开 App 先看列表。 */
  showDrawer = isNarrow();
  /** 图标栏当前视图（会话栏和主区域的内容）。 */
  view = localStorage.getItem(VIEW_KEY) ?? "home";
  /** 会话栏手动收起（记在本地）。 */
  sideCollapsed = localStorage.getItem(SIDE_COLLAPSED_KEY) === "1";
  /** 消息区太窄、会话栏改成浮层时，浮层是否展开。 */
  sideFloatOpen = false;
  /** 后退 / 前进的历史：看过的会话 id，null 是新会话页。 */
  private history: (string | null)[] = [null];
  private historyAt = 0;
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
  /** 登记的设备和在线状态（hubd 查 Tailscale），没拿到时为 null。 */
  devices: DeviceInfo[] | null = null;
  devicesError: string | null = null;
  devicesLoading = false;
  /** 草稿被界面以外的逻辑改写（排队消息放回输入框）时加一，输入框据此重读。 */
  draftRev = 0;
  version = 0;
  /** 协议版本不一致时连接层已停止收发，界面整个主区域换成阻断页，握手成功后清掉。 */
  versionProblem: { server: number | null; client: number } | null = null;

  private listeners = new Set<() => void>();
  private frame = 0;
  private browsesInFlight = 0;
  /** 等 `initialize` 回复的请求，只认当次的，重放旧日志不算。 */
  private initRequests = new Map<string, Session>();
  /** 撤回插入消息的请求：request_id → 会话、消息 uuid、撤回后是否放回输入框。 */
  private cancelRequests = new Map<string, { session: Session; id: string; edit: boolean }>();
  /** 等 hubd 回执的 input：id → 回执到了怎么办。回执只处理一次。 */
  private acks = new Map<string, (error: AckResult | null) => void>();
  private initialized = new Set<string>();
  private drafts = loadJson<Record<string, string>>(DRAFTS_KEY, {});
  private attached: Record<string, DropRef[]> = {};
  /** 为拖入的文件挂载目录，等结果的标签；键是 `设备\n目录`。 */
  private fileMounts = new Map<string, { key: string; path: string; name: string }[]>();
  private taskTimes = loadJson<Record<string, number>>(TASK_TIMES_KEY, {});
  private limitsSave: ReturnType<typeof setTimeout> | 0 = 0;

  private hub: Hub;

  constructor(hub: Hub) {
    this.hub = hub;
    void hub.onEvent((events) => {
      // 整批都是不影响界面的事件（如内容没变的任务输出轮询）时不刷新。
      let dirty = false;
      for (const event of events) if (this.onEvent(event) !== false) dirty = true;
      if (dirty) this.changed();
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

  openSettings(): void {
    this.showSettings = true;
    this.changed();
  }

  toggleSettings(): void {
    this.showSettings = !this.showSettings;
    this.changed();
  }

  private setConnection(state: ConnectionState): void {
    this.connection = state;
    if (state === "connected") {
      this.versionProblem = null;
      this.showSettings = false;
      this.refresh();
      this.requestDevices();
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

  /**
   * 所有 input 都从这里发：带 id，hubd 按 id 回执（`ack` 事件）。`onAck` 收到回执结果，
   * `null` 是已写给进程；连接层发送失败时收到 `send`，错误已记进 `this.error`。
   */
  private input(session: Session, line: string, onAck?: (error: AckResult | null) => void, id: string = crypto.randomUUID()): void {
    if (onAck) this.acks.set(id, onAck);
    this.hub.send({ type: "input", session: session.id, id, line }).catch((error) => {
      this.acks.delete(id);
      this.error = String(error);
      onAck?.("send");
      this.changed();
    });
  }

  /** 控制消息：失败就在顶部提示；连接层发送失败时 `input` 已经提示过。 */
  private control(session: Session, line: string, label: string): void {
    this.input(session, line, (error) => {
      const notice = controlNotice(label, error);
      if (notice) {
        this.error = notice;
        this.changed();
      }
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
        queue: [],
      };
      this.sessions.set(info.id, session);
    }
    return session;
  }

  /** 返回 `false` 表示这条事件没有改变界面要显示的东西。 */
  private onEvent(event: UiEvent): boolean | void {
    switch (event.type) {
      case "connection":
        this.setConnection(event.state);
        break;
      case "version":
        this.versionProblem = { server: event.server, client: event.client };
        break;
      case "ack": {
        const onAck = this.acks.get(event.id);
        // 断线重连后补发的回执可能重复，没人等就忽略。
        if (!onAck) return false;
        this.acks.delete(event.id);
        onAck(event.error);
        break;
      }
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
          if (info.running) this.flushPending(session);
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
          this.takeCancel(event.payload);
          this.takeLimits(session, event.seq, event.payload);
          const interrupting = session.thread.interruptAt != null;
          apply(session.thread, event.payload, this.models);
          applyPending(session.thread, this.pending[session.id]);
          this.stampTasks(session, event.payload);
          // 不改 active：事件到达不能影响侧边栏顺序。
          session.updated = Math.floor(Date.now() / 1000);
          if (session.queue.length) this.settleQueue(session, interrupting);
        }
        break;
      }
      case "status": {
        const session = this.sessions.get(event.session);
        if (session) {
          session.running = event.running;
          if (event.running) this.flushPending(session);
          else {
            onProcessExit(session.thread);
            this.restoreQueue(session);
          }
        }
        break;
      }
      case "device": {
        const session = this.sessions.get(event.session);
        if (session) session.deviceOnline = event.online;
        break;
      }
      case "attached": {
        const session = this.sessions.get(event.session);
        if (session) session.live = event.live;
        break;
      }
      case "browse":
        this.browsesInFlight = Math.max(0, this.browsesInFlight - 1);
        // 连点时只显示最后一次的结果。
        if (!this.browsesInFlight) this.browse = { ...event, loading: false };
        break;
      case "mounted":
        // 为拖入文件挂的目录不是选工作区，不能切换工作区。
        if (this.takeFileMount(event.device, event.path, event.cwd, event.error)) break;
        this.mounting = false;
        if (event.cwd) this.chooseWorkspace(event.cwd);
        else this.mountError = event.error ?? "挂载失败";
        break;
      case "task_output":
        // 内容没变就保留原对象，输出区按引用和文本判断，不用重画。
        if (this.taskOutput?.path !== event.path || (this.taskOutput.text === event.text && this.taskOutput.error === event.error)) return false;
        this.taskOutput = { path: event.path, text: event.text, error: event.error };
        break;
      case "usage": {
        const stats = event.stats ? parseUsage(event.stats) : null;
        const error = event.error ?? (stats ? null : "统计结果的格式不对，服务器上的统计命令可能和桌面端版本不匹配");
        // 失败时保留上一次的结果，界面同时提示错误。
        this.usage = { stats: stats ?? this.usage.stats, error, loading: false };
        break;
      }
      case "devices":
        this.devicesLoading = false;
        this.devicesError = event.error;
        // 失败时保留上一次的列表。
        if (!event.error) this.devices = event.devices;
        break;
      case "error":
        this.error = serverErrorText(event.message);
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

  private takeCancel(line: string): void {
    if (!this.cancelRequests.size || !line.includes("control_response")) return;
    for (const [requestId, { session, id, edit }] of this.cancelRequests) {
      const cancelled = parseCancelled(line, requestId);
      if (cancelled === null) continue;
      this.cancelRequests.delete(requestId);
      const item = session.queue.find((q) => q.id === id);
      session.queue = settleCancel(session.queue, id, cancelled);
      if (cancelled && edit && item) this.appendDraft(session.id, item.text);
      return;
    }
  }

  private takeLimits(session: Session, seq: number, line: string): void {
    const rank = limitRank(session.running, session.logUpdated, seq, session.live);
    const next = parseRateLimits(line, { session: session.id, seq, rank });
    if (!next) return;
    this.limits = mergeRateLimits(this.limits, next);
    // 重放时每条额度事件都会进来，localStorage 是同步写盘：合并到 1 秒后写一次。
    if (this.limitsSave) return;
    this.limitsSave = setTimeout(() => {
      this.limitsSave = 0;
      localStorage.setItem(LIMITS_KEY, JSON.stringify(this.limits));
    }, 1000);
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
    this.input(session, initializeLine(requestId), (error) => {
      // 失败可以静默，下次再问。
      if (!error) return;
      this.initRequests.delete(requestId);
      this.initialized.delete(session.id);
    });
  }

  draft(key: string): string {
    return this.drafts[key] ?? "";
  }

  /** 拖进输入框、还没发出的文件引用，按草稿分开；只在内存里。 */
  files(key: string): DropRef[] {
    return this.attached[key] ?? [];
  }

  addFiles(key: string, refs: DropRef[]): void {
    const have = this.files(key);
    const fresh = refs.filter((ref) => !have.some((h) => h.path === ref.path));
    if (!fresh.length) return;
    this.attached[key] = [...have, ...fresh];
    this.changed();
  }

  /**
   * 从系统拖进来的文件。项目外、同一台设备上的文件先挂载它所在的目录（hubd 的 `mount`，
   * 和选工作区一样），挂上后换成服务器上的绝对路径；挂不上才标成读不到。
   */
  dropFiles(key: string, paths: string[], cwd: string | undefined): void {
    const mounts: { device: string; dir: string }[] = [];
    const refs = paths.map((path): DropRef => {
      const ref = dropRef(path, cwd);
      const target = ref.reachable ? null : mountTarget(path, cwd);
      if (!target) return ref;
      const id = `${target.device}\n${target.dir}`;
      const waiting = this.fileMounts.get(id);
      if (waiting) waiting.push({ key, path, name: target.name });
      else {
        this.fileMounts.set(id, [{ key, path, name: target.name }]);
        mounts.push(target);
      }
      return { path, reachable: false, pending: true };
    });
    // 先放标签再发请求：回复可能马上到，到时要能找到等它的标签。
    this.addFiles(key, refs);
    for (const m of mounts) void this.send({ type: "mount", device: m.device, path: m.dir });
  }

  /** 文件所在目录挂载完成：等它的标签换成服务器路径，失败时标出原因。 */
  private takeFileMount(device: string, dir: string, cwd: string | null, error: string | null): boolean {
    const id = `${device}\n${dir}`;
    const waiting = this.fileMounts.get(id);
    if (!waiting) return false;
    this.fileMounts.delete(id);
    for (const w of waiting) {
      this.attached[w.key] = this.files(w.key).map((ref) =>
        ref.path !== w.path ? ref
        : cwd ? { path: `${cwd.replace(/\/+$/, "")}/${w.name}`, reachable: true }
        : { path: w.path, reachable: false, error: error ?? "挂载失败" },
      );
    }
    return true;
  }

  removeFile(key: string, path: string): void {
    this.attached[key] = this.files(key).filter((ref) => ref.path !== path);
    this.changed();
  }

  /** 发送时取走文件引用。 */
  takeFiles(key: string): DropRef[] {
    const refs = this.files(key);
    delete this.attached[key];
    return refs;
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

  /** `fromHistory`：后退 / 前进触发的切换，不再记进历史。 */
  select(id: string | null, fromHistory = false): void {
    this.selected = id;
    if (!fromHistory) this.remember(id);
    this.showSettings = false;
    this.showDrawer = false;
    this.sideFloatOpen = false;
    const session = id ? this.sessions.get(id) : undefined;
    if (session) {
      this.attach(session);
      if (session.running) this.requestInit(session);
    }
    this.changed();
  }

  /** 记一个新位置：丢掉“前进”那一截，连续重复的不记。 */
  private remember(id: string | null): void {
    if (this.history[this.historyAt] === id) return;
    this.history = this.history.slice(0, this.historyAt + 1);
    this.history.push(id);
    if (this.history.length > HISTORY_MAX) this.history.shift();
    this.historyAt = this.history.length - 1;
  }

  /** 往 `step` 方向第一个还能去的位置（已关闭或不存在的会话跳过），没有就是 -1。 */
  private historyTarget(step: -1 | 1): number {
    for (let i = this.historyAt + step; i >= 0 && i < this.history.length; i += step) {
      const id = this.history[i];
      const session = id === null ? undefined : this.sessions.get(id);
      if (id === null || (session && !session.archived)) return i;
    }
    return -1;
  }

  canGo(step: -1 | 1): boolean {
    return this.historyTarget(step) >= 0;
  }

  /** 后退（-1）/ 前进（1），像浏览器一样在看过的会话之间来回。 */
  go(step: -1 | 1): void {
    const i = this.historyTarget(step);
    if (i < 0) return;
    this.historyAt = i;
    this.select(this.history[i], true);
  }

  /** 图标栏的“首页”：回到首页视图并打开新会话页。 */
  goHome(): void {
    if (this.view !== "home") {
      this.view = "home";
      localStorage.setItem(VIEW_KEY, "home");
    }
    this.select(null);
  }

  /** 标题栏的“收起侧栏”：窄屏开关抽屉，否则和再点一次当前视图图标一样。 */
  toggleSide(floating: boolean): void {
    if (isNarrow()) {
      this.showDrawer = !this.showDrawer;
      this.changed();
    } else {
      this.clickView(this.view, floating);
    }
  }

  /**
   * 点图标栏的视图图标。当前视图再点一次：收起或展开会话栏（浮层模式下是开关浮层）；
   * 换视图：切过去并展开。和窄屏抽屉（`showDrawer`）互不干扰。
   */
  clickView(id: string, floating: boolean): void {
    if (id === this.view) {
      if (floating) this.sideFloatOpen = !this.sideFloatOpen;
      else this.setSideCollapsed(!this.sideCollapsed);
    } else {
      this.view = id;
      localStorage.setItem(VIEW_KEY, id);
      if (floating) this.sideFloatOpen = true;
      else this.setSideCollapsed(false);
    }
    this.changed();
  }

  closeSideFloat(): void {
    if (!this.sideFloatOpen) return;
    this.sideFloatOpen = false;
    this.changed();
  }

  private setSideCollapsed(value: boolean): void {
    this.sideCollapsed = value;
    localStorage.setItem(SIDE_COLLAPSED_KEY, value ? "1" : "0");
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

  /** 问 hubd 登记了哪些设备、是否在线。hubd 缓存 15 秒，侧栏每分钟问一次。 */
  requestDevices(): void {
    if (this.connection !== "connected") return;
    this.devicesLoading = true;
    void this.send({ type: "devices" });
    this.changed();
  }

  /** 选择工作区弹窗：顺带刷新设备在线状态（设备列表里显示）。 */
  openWorkspace(): void {
    this.showWorkspace = true;
    this.mountError = null;
    this.browseTo(null, null);
    this.requestDevices();
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
    this.deliverUser(session, id, userLine(text, id), false);
  }

  /** 发用户消息并按回执处理（规则见 `uplink.ts` 的 `userAck`）；`retried` 是恢复进程后的那次重发。 */
  private deliverUser(session: Session, id: string, line: string, retried: boolean): void {
    this.input(session, line, (error) => {
      const thread = session.thread;
      const action = userAck(error, userState(thread, id), retried);
      if (action.kind === "ignore") return;
      if (action.kind === "delivered") markDelivered(thread, id);
      else if (action.kind === "retry") {
        this.resume(session);
        this.deliverUser(session, id, line, true);
      } else {
        failUser(thread, id, action.reason);
        if (action.notice) this.error = action.notice;
      }
      this.changed();
    }, id);
  }

  /** 进程已回收：用记录的 ID 恢复，带上待定的模型、重发强度（`resumeChoice`）。 */
  private resume(session: Session): void {
    const choice = resumeChoice(this.takePending(session.id), session.thread.effort);
    void this.send({
      type: "start",
      session: session.id,
      resume: session.thread.claudeSessionId,
      model: choice.model,
    });
    session.running = true;
    this.initialized.delete(session.id);
    this.requestInit(session);
    if (choice.effort) this.control(session, setEffortLine(choice.effort), "设置推理强度");
  }

  /** 进程不在时选的模型 / 强度存到本地，刷新、重启后照样显示，恢复进程时带上。 */
  private setPending(session: Session, change: PendingChoice): void {
    this.pending = { ...this.pending, [session.id]: { ...this.pending[session.id], ...change } };
    localStorage.setItem(PENDING_KEY, JSON.stringify(this.pending));
  }

  private takePending(id: string): PendingChoice | undefined {
    const pending = this.pending[id];
    if (!pending) return undefined;
    const { [id]: _, ...rest } = this.pending;
    this.pending = rest;
    localStorage.setItem(PENDING_KEY, JSON.stringify(rest));
    return pending;
  }

  /** 进程在运行（比如别的设备先拉起来了），本机还有没生效的选择：补发给它。 */
  private flushPending(session: Session): void {
    const pending = this.takePending(session.id);
    if (!pending) return;
    if (pending.model) this.setModel(session, pending.model);
    if (pending.effort !== undefined) this.setEffort(session, pending.effort ?? undefined);
  }

  newSession(text: string, cwd: string, model: string, effort?: string): void {
    const id = crypto.randomUUID();
    const title = text.split("\n")[0].slice(0, 40);
    const session = this.session({ id, title, cwd, running: true, updated: null, active: Math.floor(Date.now() / 1000), archived: false });
    session.cwd = cwd;
    session.running = true;
    session.attached = true;
    this.selected = id;
    this.remember(id);
    this.showDrawer = false;
    // 第一条消息交给 hubd 在后台概括成标题（`/` 命令不概括），几秒后刷新列表拿到。
    const prompt = text.trimStart().startsWith("/") ? undefined : text;
    void this.send({ type: "start", session: id, cwd, title, prompt, model: startModel(model) });
    if (prompt) for (const delay of TITLE_REFRESH_MS) setTimeout(() => this.refresh(), delay);
    void this.send({ type: "attach", session: id, after: 0 });
    this.requestInit(session);
    if (model) session.thread.model = model;
    if (effort) {
      session.thread.effort = effort;
      this.control(session, setEffortLine(effort), "设置推理强度");
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
    // 进程已回收：先恢复，消息写进 FIFO 等它读。
    if (!session.running) this.resume(session);
    // `/model` 回复成功但不生效，要走控制消息。其他命令都原样交给 CLI。
    const model = /^\/model\s+(\S+)\s*$/.exec(text)?.[1];
    if (model) {
      this.setModel(session, model);
      return;
    }
    this.sendUser(session, text);
    this.changed();
  }

  /**
   * 一轮进行中再发消息。插入：马上写给 CLI，它在下一个工具结果之后插进这一轮，回传同一 uuid 后移出队列。
   * 等结束：留在本地，这一轮正常结束后合成一条发出。`/` 命令只能等结束。
   */
  enqueue(session: Session, text: string, mode: Queued["mode"]): void {
    const id = crypto.randomUUID();
    if (mode === "insert" && !text.trimStart().startsWith("/")) {
      session.queue = [...session.queue, { id, text, mode }];
      session.updated = session.active = Math.floor(Date.now() / 1000);
      this.input(session, userLine(text, id), (error) => {
        session.queue = settleInsert(session.queue, id, !error);
        // 进程不在时 status 事件会把队列放回输入框，不另外提示。
        const notice = inputNotice(error);
        if (notice) this.error = notice;
        this.changed();
      }, id);
    } else {
      session.queue = [...session.queue, { id, text, mode: "wait" }];
    }
    this.changed();
  }

  /** 从队列里取回一条等结束的消息（编辑时放回输入框）。 */
  unqueue(session: Session, id: string): string {
    const item = session.queue.find((q) => q.id === id && q.mode === "wait");
    if (!item) return "";
    session.queue = session.queue.filter((q) => q !== item);
    this.changed();
    return item.text;
  }

  private settleQueue(session: Session, interrupted: boolean): void {
    session.queue = confirmInserted(session.queue, session.thread);
    const action = afterTurn(session.queue, session.thread, interrupted);
    if (action === "flush") {
      const text = joinQueued(session.queue);
      session.queue = [];
      if (text) this.sendText(session, text);
    } else if (action === "restore") {
      this.restoreQueue(session);
    }
  }

  /**
   * 撤回一条还没回传的插入消息。CLI 的回复到了才知道结果（`takeCancel`）：撤回成功就移出队列，
   * `edit` 时放回输入框；来不及（已交给模型）就标成 late，等回传。
   */
  cancelInsert(session: Session, id: string, edit: boolean): void {
    const item = session.queue.find((q) => q.id === id && q.mode === "insert" && !q.cancelling && !q.late);
    if (!item) return;
    const requestId = `cchub-cancel-${crypto.randomUUID()}`;
    this.cancelRequests.set(requestId, { session, id, edit });
    session.queue = session.queue.map((q) => (q === item ? { ...q, cancelling: true } : q));
    this.input(session, cancelInsertLine(requestId, id), (error) => {
      if (!error) return;
      this.cancelRequests.delete(requestId);
      session.queue = session.queue.map((q) => (q.id === id ? { ...q, cancelling: false } : q));
      const notice = controlNotice("撤回", error);
      if (notice) this.error = notice;
      this.changed();
    });
    this.changed();
  }

  private appendDraft(key: string, text: string): void {
    const draft = this.draft(key);
    this.setDraft(key, draft.trim() ? `${draft.trimEnd()}\n\n${text}` : text);
    this.draftRev++;
  }

  /** 被中断或进程结束：没发出的消息放回输入框，不自作主张发出去。没回传的插入消息也一起放回。 */
  private restoreQueue(session: Session): void {
    if (!session.queue.length) return;
    const text = joinQueued(session.queue);
    session.queue = [];
    for (const [requestId, request] of this.cancelRequests) if (request.session === session) this.cancelRequests.delete(requestId);
    this.appendDraft(session.id, text);
    this.changed();
  }

  retry(session: Session, id: string, text: string): void {
    removeItem(session.thread, id);
    this.sendText(session, text);
  }

  /**
   * 回复卡片。进程已不在：卡片标成失效，不能重试；卡住 / 不合法：解锁并写上原因，可以再点。
   * `shown` 是用户在输入框里打的原文，卡片结束后显示；没发出去时放回输入框。
   */
  private reply(session: Session, ask: Ask, line: string, shown?: string): void {
    ask.sent = true;
    ask.error = undefined;
    ask.reply = shown;
    this.input(session, line, (error) => {
      const action = replyAck(error);
      if (action.kind === "ok") return;
      if (action.kind === "expired") ask.expired = true;
      else {
        ask.sent = false;
        ask.reply = undefined;
        ask.error = action.error;
        if (shown) this.appendDraft(session.id, shown);
      }
      this.changed();
    });
    this.changed();
  }

  allow = (session: Session, ask: Ask, always = false) =>
    this.reply(session, ask, allowLine(ask, always));

  deny = (session: Session, ask: Ask, message: string, shown?: string) =>
    this.reply(session, ask, denyLine(ask, message), shown);

  answer = (session: Session, ask: Ask, answers: Record<string, string>) =>
    this.reply(session, ask, answerLine(ask, answers));

  interrupt(session: Session): void {
    markInterrupting(session.thread);
    this.control(session, interruptLine(), "中断");
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
    this.restoreQueue(session);
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
    this.control(session, stopTaskLine(taskId), "停止任务");
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
    void this.send({ type: "task_output", path });
    // 轮询同一个任务时不刷新界面，等结果回来、内容变了再刷新。
    if (this.taskOutput?.path === path) return;
    this.taskOutput = { path, text: null, error: null };
    this.changed();
  }

  setModel(session: Session, model: string): void {
    // `/model` 回复成功但不生效，必须走控制消息；它不进会话记录，模型看不到。
    // 进程已回收时写进 FIFO 会丢，先记在本地，下次发消息恢复进程时带上。
    const previous = session.thread.model;
    // 一轮进行中：这一轮剩下的回复仍是旧模型，下个 `system/init` 才生效。
    if (session.thread.phase !== "idle") session.thread.nextModel = model;
    if (session.running) {
      this.input(session, setModelLine(model), (error) => {
        const action = choiceAck("切换模型", error);
        if (action.kind === "ok") return;
        session.thread.nextModel = undefined;
        if (action.kind === "pending") this.setPending(session, { model });
        else {
          session.thread.model = previous;
          if (action.notice) this.error = action.notice;
        }
        this.changed();
      });
    } else this.setPending(session, { model });
    session.thread.model = model;
    this.changed();
  }

  /** 新会话用的模型：用户选的默认，没选过就是 CLI 默认指向的具体模型。 */
  get defaultModel(): string | undefined {
    return defaultModelFor(this.models, this.defaults.model);
  }

  /** 新会话用的强度、“恢复默认”恢复到的强度；undefined 表示跟随模型。 */
  get defaultEffort(): string | undefined {
    return defaultEffortFor(this.models, this.defaultModel, this.defaults.effort);
  }

  setDefaults(change: { model?: string; effort?: string | null }): void {
    const next = { ...this.defaults };
    if (change.model) next.model = change.model;
    if (change.effort !== undefined) next.effort = change.effort ?? undefined;
    this.defaults = next;
    localStorage.setItem(DEFAULTS_KEY, JSON.stringify(next));
    this.changed();
  }

  /** `undefined` 跟随模型。进程没在运行时记在本地，恢复时带上。 */
  setEffort(session: Session, effort?: string): void {
    if (session.running) {
      this.input(session, setEffortLine(effort ?? null), (error) => {
        const action = choiceAck("设置推理强度", error);
        if (action.kind === "pending") this.setPending(session, { effort: effort ?? null });
        else if (action.kind === "rejected" && action.notice) {
          this.error = action.notice;
          this.changed();
        }
      });
    } else this.setPending(session, { effort: effort ?? null });
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
