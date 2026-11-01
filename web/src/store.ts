import type { ConnectionState } from "./generated/ConnectionState";
import type { SessionInfo } from "./generated/SessionInfo";
import type { UiEvent } from "./generated/UiEvent";
import type { Hub } from "./hub";
import {
  addSending,
  allowLine,
  answerLine,
  apply,
  denyLine,
  failSending,
  initializeLine,
  interruptLine,
  isWaiting,
  newThread,
  onProcessExit,
  parseModels,
  removeItem,
  setModelLine,
  userLine,
  type Ask,
  type ModelOption,
  type Thread,
} from "./model";

export interface Session {
  id: string;
  title: string;
  cwd?: string;
  running: boolean;
  updated: number;
  deviceOnline: boolean;
  attached: boolean;
  thread: Thread;
}

const URL_KEY = "cchub.url";
const MODELS_KEY = "cchub.models";
const CWD_KEY = "cchub.cwd";

/** 还没有任何会话返回过模型列表时用，只放 CLI 长期支持的别名。 */
const FALLBACK_MODELS: ModelOption[] = [
  { value: "default", displayName: "默认" },
  { value: "opus", displayName: "Opus" },
  { value: "sonnet", displayName: "Sonnet" },
  { value: "haiku", displayName: "Haiku" },
];

function loadModels(): ModelOption[] {
  try {
    const saved = JSON.parse(localStorage.getItem(MODELS_KEY) ?? "null");
    return Array.isArray(saved) && saved.length ? saved : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
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
  private modelsRequest: string | null = null;
  private modelsRefreshed = false;

  constructor(private hub: Hub) {
    void hub.onEvent((event) => this.onEvent(event));
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
          session.running = info.running;
          // 运行中的都订阅，这样才能知道哪个在等人决定。
          if (info.running || info.id === this.selected) this.attach(session);
        }
        {
          // 窗口一打开就更新模型列表，新会话页也要用。
          const running = event.sessions.find((info) => info.running);
          const session = running && this.sessions.get(running.id);
          if (session) this.refreshModels(session);
        }
        break;
      case "event": {
        const session = this.sessions.get(event.session);
        if (session) {
          if (this.modelsRequest) this.takeModels(event.payload, this.modelsRequest);
          apply(session.thread, event.payload);
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
      case "error":
        this.error = event.message;
        if (event.session) {
          const session = this.sessions.get(event.session);
          if (session) failSending(session.thread);
        }
        break;
    }
    this.changed();
  }

  private takeModels(line: string, requestId: string): void {
    const models = parseModels(line, requestId);
    if (!models) return;
    this.models = models;
    this.modelsRequest = null;
    localStorage.setItem(MODELS_KEY, JSON.stringify(models));
  }

  /** 问 CLI 当前有哪些模型。不调用模型，也不写进会话记录；每次打开窗口问一次就够。 */
  private refreshModels(session: Session): void {
    if (this.modelsRefreshed) return;
    this.modelsRefreshed = true;
    this.modelsRequest = `cchub-models-${crypto.randomUUID()}`;
    void this.send({ type: "input", session: session.id, line: initializeLine(this.modelsRequest) });
  }

  private attach(session: Session): void {
    if (session.attached) return;
    session.attached = true;
    void this.send({ type: "attach", session: session.id, after: 0 });
  }

  select(id: string | null): void {
    this.selected = id;
    this.showSettings = false;
    const session = id ? this.sessions.get(id) : undefined;
    if (session) {
      this.attach(session);
      if (session.running) this.refreshModels(session);
    }
    this.changed();
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
    const sessions = [...this.sessions.values()].sort((a, b) => b.updated - a.updated);
    const cwds = sessions.flatMap((s) => (s.cwd && !s.cwd.startsWith("/tmp/") ? [s.cwd] : []));
    return [...new Set(cwds)];
  }

  private sendUser(session: Session, text: string): void {
    const id = crypto.randomUUID();
    addSending(session.thread, id, text);
    session.updated = Math.floor(Date.now() / 1000);
    void this.hub.send({ type: "input", session: session.id, line: userLine(text, id) }).catch((error) => {
      failSending(session.thread);
      this.error = String(error);
      this.changed();
    });
  }

  newSession(text: string, cwd: string, model: string): void {
    const id = crypto.randomUUID();
    const title = text.split("\n")[0].slice(0, 40);
    const session = this.session({ id, title, cwd, running: true, updated: null });
    session.cwd = cwd;
    session.running = true;
    session.attached = true;
    this.selected = id;
    void this.send({ type: "start", session: id, cwd, title });
    void this.send({ type: "attach", session: id, after: 0 });
    this.modelsRefreshed = false;
    this.refreshModels(session);
    if (model) void this.send({ type: "input", session: id, line: setModelLine(model) });
    this.sendUser(session, text);
    this.refresh();
    this.changed();
  }

  sendText(session: Session, text: string): void {
    if (!session.running) {
      // 进程已回收：用记录的 ID 恢复，消息写进 FIFO 等它读。
      void this.send({
        type: "start",
        session: session.id,
        resume: session.thread.claudeSessionId,
      });
      session.running = true;
      this.modelsRefreshed = false;
      this.refreshModels(session);
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
    void this.send({ type: "input", session: session.id, line: interruptLine() });
  }

  setModel(session: Session, model: string): void {
    // `/model` 回复成功但不生效，必须走控制消息。
    void this.send({ type: "input", session: session.id, line: setModelLine(model) });
    session.thread.model = model;
    this.changed();
  }

  groups(): { waiting: Session[]; running: Session[]; recent: Session[] } {
    const all = [...this.sessions.values()].sort((a, b) => b.updated - a.updated);
    const waiting = all.filter((s) => isWaiting(s.thread));
    const running = all.filter((s) => !isWaiting(s.thread) && s.running);
    const recent = all.filter((s) => !isWaiting(s.thread) && !s.running);
    return { waiting, running, recent };
  }
}

/** `/mnt/<设备>/...` 是挂载的设备目录，其他是服务器本地目录。 */
export function describeCwd(cwd?: string): { project: string; device: string } {
  if (!cwd) return { project: "", device: "" };
  const parts = cwd.split("/").filter(Boolean);
  const project = parts[parts.length - 1] ?? "/";
  return { project, device: parts[0] === "mnt" && parts[1] ? parts[1] : "服务器" };
}
