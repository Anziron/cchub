import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CommandMenu, ConfirmDialog, ConnectDialog, ModelMenu, TasksDialog, WorkspaceDialog } from "./Dialogs";
import { Icon } from "./Icon";
import { isAndroid, isTouch, takeOpenedSession } from "./platform";
import { firstAsk, isSending, isWaiting, matchCommands, runningTasks, type Ask, type SlashCommand, type Todo } from "./model";
import { describeCwd, NEW_DRAFT, type Session, type Store } from "./store";
import { describeTool, ThreadView } from "./Thread";

function askHint(ask?: Ask): string {
  if (ask?.kind === "plan") return "方案等你确认";
  if (ask?.kind === "question") return "有个问题要问你";
  return ask?.toolName === "Bash" ? "要运行一条命令" : "要你批准一个操作";
}

function SessionRow({ store, session }: { store: Store; session: Session }) {
  const waiting = isWaiting(session.thread);
  const current = store.selected === session.id;
  const status = waiting || !session.running ? "" : sessionStatus(session);
  const started = session.thread.phase !== "idle" ? session.thread.turnStartedAt : undefined;
  return (
    <div className="row-wrap">
      <button className={`row${current ? " current" : ""}`} onClick={() => store.select(session.id)}>
        <span className={`dot${waiting ? " wait" : session.running ? " run" : ""}`} />
        <span className="name">
          {session.title}
          {waiting ? <small>{askHint(firstAsk(session.thread))}</small> : null}
          {status ? <small className="status">{status}{started ? ` · ${formatDuration(Date.now() - started)}` : ""}</small> : null}
        </span>
      </button>
      {session.running ? (
        <button className="row-stop" aria-label={`结束会话 ${session.title}`} title="结束会话" onClick={() => store.askStop(session)}><Icon name="close" size={12} /></button>
      ) : null}
    </div>
  );
}

const VISIBLE_SESSIONS = 5;
const COLLAPSED_KEY = "cchub.collapsedProjects";

function ProjectGroup({ store, project, sessions, collapsed, toggle }: {
  store: Store;
  project: string;
  sessions: Session[];
  collapsed: boolean;
  toggle: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  // 正在看的会话不能被收起来。
  const shown = sessions.filter((s, i) => (collapsed ? false : showAll || i < VISIBLE_SESSIONS) || s.id === store.selected);
  const hidden = collapsed ? 0 : sessions.length - shown.length;
  return (
    <div className={`group${collapsed ? " closed" : ""}`}>
      <button className="row project" title={sessions[0]?.cwd} aria-expanded={!collapsed} onClick={toggle}>
        <Icon name="chev" size={11} />
        <span className="name">{project || "未指定目录"}</span>
        <span className="hint">{sessions.length}</span>
      </button>
      {shown.map((s) => <SessionRow key={s.id} store={store} session={s} />)}
      {hidden > 0 ? <button className="row more" onClick={() => setShowAll(true)}>展开其余 {hidden} 个</button> : null}
      {showAll && !collapsed && sessions.length > VISIBLE_SESSIONS ? <button className="row more" onClick={() => setShowAll(false)}>收起</button> : null}
    </div>
  );
}

type QuotaWindow = { utilization: number; resetsAt: number };

function Quota({ label, window }: { label: string; window?: QuotaWindow }) {
  // 窗口已过期的旧数据不显示。
  const at = window ? window.resetsAt * 1000 : 0;
  const percent = window && at > Date.now() ? Math.round(window.utilization * 100) : null;
  const minutes = Math.round((at - Date.now()) / 60000);
  const reset = minutes < 60 ? `${minutes} 分钟后` : minutes < 2880 ? `${Math.round(minutes / 60)} 小时后` : `${Math.round(minutes / 1440)} 天后`;
  return (
    <div className="quota" title={percent != null ? `${reset}重置（${new Date(at).toLocaleString()}）` : "还没有数据，下一轮回复后更新"}>
      <span>{label}</span>
      <span className="quota-bar"><i className={percent != null && percent >= 80 ? "high" : ""} style={{ width: `${percent ?? 0}%` }} /></span>
      <span className="num">{percent != null ? `${percent}%` : "—"}</span>
    </div>
  );
}

/** 有会话在跑时每秒刷新用时，窗口不在前台时不刷新。 */
function useTick(active: boolean) {
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { if (document.hasFocus()) setNow(Date.now()); }, 1000);
    return () => clearInterval(timer);
  }, [active]);
}

function Sidebar({ store }: { store: Store }) {
  const { waiting, running, recent } = store.groups();
  useTick(running.length > 0);
  const projects = new Map<string, Session[]>();
  // 按完整路径分组：不同设备上可能有同名项目。
  for (const session of recent) {
    const key = session.cwd ?? "";
    projects.set(key, [...(projects.get(key) ?? []), session]);
  }
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    } catch {
      return [];
    }
  });
  const toggle = (key: string) => {
    const next = collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key];
    setCollapsed(next);
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
  };
  return (
    <aside className="side">
      <button className="row new" onClick={() => store.select(null)}>
        <i><Icon name="plus" size={13} /></i><span className="name">新建会话</span>
      </button>
      <div className="side-scroll">
        {waiting.length ? (
          <section className="attention">
            <h2>等你决定</h2>
            {waiting.map((s) => <SessionRow key={s.id} store={store} session={s} />)}
          </section>
        ) : null}
        {running.length ? (
          <section>
            <h2>进行中</h2>
            {running.map((s) => <SessionRow key={s.id} store={store} session={s} />)}
          </section>
        ) : null}
        {recent.length ? (
          <section>
            <h2>最近</h2>
            {[...projects].map(([key, sessions]) => (
              <ProjectGroup
                key={key}
                store={store}
                project={describeCwd(key).project}
                sessions={sessions}
                collapsed={collapsed.includes(key)}
                toggle={() => toggle(key)}
              />
            ))}
          </section>
        ) : null}
      </div>
      <div className="side-foot">
        <Quota label="5 小时" window={store.limits.fiveHour} />
        <Quota label="本周" window={store.limits.sevenDay} />
        <div className="quota">
          <span>服务器可用内存</span>
          <span className="num mem">{store.memAvailableMb == null ? "—" : `${store.memAvailableMb} MB`}</span>
        </div>
      </div>
    </aside>
  );
}

function useTheme() {
  const [theme, setTheme] = useState(
    () => localStorage.getItem("cchub.theme") ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("cchub.theme", theme);
  }, [theme]);
  return () => {
    const root = document.documentElement;
    root.classList.add("switching");
    setTheme((t) => (t === "dark" ? "light" : "dark"));
    setTimeout(() => root.classList.remove("switching"), 280);
  };
}

function TopBar({ store, session, toggleTheme }: { store: Store; session?: Session; toggleTheme: () => void }) {
  const { project, device } = describeCwd(session?.cwd);
  const conn = store.connection;
  const connClass = conn === "connected" ? "" : conn === "disconnected" ? "bad" : "pending";
  const connText = conn === "connected" ? "已连接" : conn === "disconnected" ? "已断开" : "重连中";
  const offline = session && !session.deviceOnline;
  return (
    <header className="top">
      <button className="icon drawer-open" aria-label="会话列表" onClick={() => store.openDrawer()}><Icon name="back" /></button>
      <div className="crumb">
        <b>{session?.title ?? "新会话"}</b>
        {project ? <><span className="sep">/</span><span>{project}</span><span className="sep">/</span><span>{device}</span></> : null}
      </div>
      <div className="top-right">
        <div className="health">
          <button className={connClass} onClick={() => store.toggleSettings()}><i />{store.url ? connText : "未连接"}</button>
          {session ? <span className={offline ? "bad" : ""}><i />{offline ? "设备离线" : "设备在线"}</span> : null}
        </div>
        {session?.running ? <button className="btn quiet end-session" onClick={() => store.askStop(session)}>结束会话</button> : null}
        <button className="icon" aria-label="切换深浅色" onClick={toggleTheme}><Icon name="moon" /></button>
        <button className="icon" aria-label="连接服务器" onClick={() => store.toggleSettings()}><Icon name="gear" /></button>
      </div>
    </header>
  );
}

function TodoBar({ todos }: { todos: Todo[] }) {
  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  const doing = todos.find((t) => t.status === "in_progress");
  return (
    <details className="todo">
      <summary>
        <span className="bar"><i style={{ width: `${(done / todos.length) * 100}%` }} /></span>
        <span className="now">{doing?.activeForm ?? doing?.content ?? (done === todos.length ? "全部完成" : todos[done]?.content)}</span>
        <span className="count">{done} / {todos.length}</span>
      </summary>
      <ul>
        {todos.map((t) => (
          <li key={t.content} className={t.status === "completed" ? "done" : t.status === "in_progress" ? "doing" : ""}>{t.content}</li>
        ))}
      </ul>
    </details>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** 这个会话现在在做什么，状态行和侧边栏共用。 */
function sessionStatus(session: Session): string {
  const thread = session.thread;
  const ask = firstAsk(thread);
  if (!ask && isSending(thread)) return session.deviceOnline ? (thread.claudeSessionId ? "正在发送" : "正在启动会话") : "设备离线，恢复后发送";
  if (ask) return ask.kind === "plan" ? "等待你确认方案" : ask.kind === "question" ? "等待你回答" : "等待你批准";
  if (thread.phase === "thinking") return "思考中";
  if (thread.phase === "replying") return "正在回复";
  if (thread.phase === "tool") {
    const tool = thread.items.find((item) => item.kind === "tool" && item.id === thread.activeTool);
    if (tool?.kind !== "tool") return "正在执行";
    const { verb, target } = describeTool(tool, session.cwd);
    return `正在${verb} ${target}`;
  }
  const background = runningTasks(thread).length;
  if (background) return `后台还有 ${background} 个任务`;
  return session.running ? "空闲" : "";
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function ContextMeter({ session }: { session: Session }) {
  const context = session.thread.context;
  if (!context) return null;
  const percent = context.max ? Math.round((context.used / context.max) * 100) : null;
  return (
    <span className={`context${percent != null && percent >= 80 ? " high" : ""}`} title="这个会话已占用的上下文。接近上限时可以发 /compact 压缩。">
      上下文 {formatTokens(context.used)}{context.max ? ` / ${formatTokens(context.max)}` : ""}{percent != null ? ` · ${percent}%` : ""}
    </span>
  );
}

const INTERRUPT_TIMEOUT_MS = 5000;

function Activity({ store, session }: { store: Store; session: Session }) {
  const thread = session.thread;
  const ask = firstAsk(thread);
  const busy = !ask && thread.phase !== "idle";
  const background = runningTasks(thread).length;
  // 只在运行中每秒刷新用时，窗口不在前台时不刷新。
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => document.hasFocus() && setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  let text = busy || ask ? sessionStatus(session) : "";
  if (!text && background) text = `这一轮已结束，后台还有 ${background} 个任务在运行`;
  else if (!text && thread.lastTurn?.durationMs != null) {
    const tokens = thread.lastTurn.outputTokens;
    text = `上一轮用时 ${formatDuration(thread.lastTurn.durationMs)}${tokens ? ` · ${tokens} tokens` : ""}`;
  } else if (!text && !session.running) text = "进程已结束，发消息时自动恢复";

  const interruptAt = busy ? thread.interruptAt : undefined;
  const unresponsive = interruptAt != null && now - interruptAt >= INTERRUPT_TIMEOUT_MS;
  if (interruptAt != null) text = unresponsive ? "进程没有响应，可以结束会话" : "正在中断…";

  const live = busy || background > 0;
  const hasTasks = [...thread.tasks.values()].some((task) => task.backgrounded);
  return (
    <div className="activity">
      {ask || live ? <span className="pulse" style={ask ? { animation: "none" } : undefined} /> : null}
      <span className="activity-text">{text}</span>
      {busy && thread.turnStartedAt ? <time>· {formatDuration(now - thread.turnStartedAt)}</time> : null}
      <span className="activity-right">
        {hasTasks ? <button onClick={() => store.openTasks()}><Icon name="tasks" size={13} />后台任务{background ? ` ${background}` : ""}</button> : null}
        {unresponsive ? <button onClick={() => store.askStop(session)}>结束会话</button> : null}
        {busy && interruptAt == null ? <span className="esc" role="button" onClick={() => store.interrupt(session)}>{isTouch ? "中断" : "Esc 中断"}</span> : null}
      </span>
    </div>
  );
}

/** 输入框的 `/` 菜单：和 CLI 一样，输入 `/` 就列命令，列表直接来自 CLI。 */
function useCommandMenu(commands: SlashCommand[], text: string, setText: (text: string) => void, submit: (text: string) => void) {
  const [index, setIndex] = useState(0);
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const matches = closedFor === text ? [] : matchCommands(commands, text);
  const selected = Math.min(index, Math.max(0, matches.length - 1));
  useEffect(() => setIndex(0), [text]);
  const choose = (command: SlashCommand, run: boolean) => {
    // 需要参数的命令先填进去，等用户写完。
    if (run && !command.argumentHint) submit(`/${command.name}`);
    else setText(`/${command.name} `);
  };
  const onKeyDown = (event: ReactKeyboardEvent): boolean => {
    if (!matches.length) return false;
    if (event.key === "ArrowDown") setIndex((selected + 1) % matches.length);
    else if (event.key === "ArrowUp") setIndex((selected - 1 + matches.length) % matches.length);
    else if (event.key === "Tab") choose(matches[selected], false);
    else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) choose(matches[selected], true);
    else if (event.key === "Escape") { event.stopPropagation(); setClosedFor(text); }
    else return false;
    event.preventDefault();
    return true;
  };
  const menu = matches.length ? <CommandMenu commands={matches} selected={selected} onChoose={(command) => choose(command, true)} /> : null;
  return { menu, onKeyDown };
}

function Composer({ store, session }: { store: Store; session: Session }) {
  const [text, setTextState] = useState(() => store.draft(session.id));
  const ref = useRef<HTMLTextAreaElement>(null);
  const thread = session.thread;
  const busy = thread.phase !== "idle" && !firstAsk(thread);
  const setText = (next: string) => {
    setTextState(next);
    store.setDraft(session.id, next);
  };
  const submit = (message: string) => {
    if (!message.trim()) return;
    store.sendText(session, message);
    setText("");
  };
  const send = () => submit(text);
  const commands = useCommandMenu(store.commandsFor(session), text, setText, submit);
  // 有卡片等决定时不抢焦点，回车和 Esc 留给卡片。
  useEffect(() => {
    // 触屏上聚焦会弹出键盘，挡住内容。
    if (!isTouch && !firstAsk(session.thread)) ref.current?.focus();
  }, [session]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "26px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);
  useEffect(() => {
    if (!busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") store.interrupt(session);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [busy, store, session]);
  return (
    <form className="composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
      {commands.menu}
      <textarea
        ref={ref}
        rows={1}
        aria-label="输入消息"
        placeholder={busy ? "继续补充，这一轮结束后会处理" : "继续补充"}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (commands.onKeyDown(event)) return;
          if (!isTouch && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            send();
          }
        }}
      />
      <div className="tools">
        <ContextMeter session={session} />
        <ModelMenu models={store.models} model={thread.model} onChange={(value) => store.setModel(session, value)} />
        {busy && !text ? (
          <button type="button" className="send stop" aria-label="中断" onClick={() => store.interrupt(session)}><Icon name="stop" /></button>
        ) : (
          <button className="send" aria-label="发送"><Icon name="up" /></button>
        )}
      </div>
    </form>
  );
}

function Welcome({ store }: { store: Store }) {
  const [text, setTextState] = useState(() => store.draft(NEW_DRAFT));
  const [model, setModel] = useState("");
  const setText = (next: string) => {
    setTextState(next);
    store.setDraft(NEW_DRAFT, next);
  };
  const submit = (message: string) => {
    if (!message.trim()) return;
    // 还没选工作区时先选，文字留在输入框里。
    if (!store.cwd) {
      setText(message);
      store.openWorkspace();
      return;
    }
    setText("");
    store.newSession(message, store.cwd, model);
  };
  const send = () => submit(text);
  const commands = useCommandMenu(store.commandsFor(), text, setText, submit);
  const { project, device } = describeCwd(store.cwd);
  return (
    <section className="welcome">
      <h1>今天想让它做点什么？</h1>
      <form className="composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
        {commands.menu}
        <textarea
          autoFocus={!isTouch}
          aria-label="输入任务"
          placeholder="描述任务，它会在后台持续运行，需要你时再叫你"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (commands.onKeyDown(event)) return;
            if (!isTouch && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="tools">
          <button type="button" className="workspace" title={store.cwd || undefined} onClick={() => store.openWorkspace()}>
            <Icon name="folder" size={14} />
            <span>{project || "选择工作区"}</span>
            {device ? <small>{device}</small> : null}
          </button>
          <ModelMenu models={store.models} model={model || "default"} onChange={setModel} />
          <button className="send" aria-label="发送" disabled={!text.trim()}><Icon name="up" /></button>
        </div>
      </form>
    </section>
  );
}

export function App({ store }: { store: Store }) {
  useSyncExternalStore(store.subscribe, store.getVersion);
  const toggleTheme = useTheme();
  const session = store.selected ? store.sessions.get(store.selected) : undefined;

  // 窗口回到前台时刷新一次会话列表和内存，平时不轮询。
  useEffect(() => {
    const onFocus = () => { document.body.classList.remove("blurred"); if (store.connection === "connected") store.refresh(); };
    const onBlur = () => document.body.classList.add("blurred");
    addEventListener("focus", onFocus);
    addEventListener("blur", onBlur);
    return () => { removeEventListener("focus", onFocus); removeEventListener("blur", onBlur); };
  }, [store]);

  // Android 上由系统回调：返回键，以及从通知跳到对应会话。
  useEffect(() => {
    if (!isAndroid) return;
    const hooks = window as unknown as Record<string, unknown>;
    hooks.__cchubBack = () => store.back();
    hooks.__cchubOpen = (id: string) => { store.select(id); return true; };
    void takeOpenedSession().then((id) => { if (id) store.select(id); });
    const onVisible = () => { if (!document.hidden && store.connection === "connected") store.refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [store]);

  const conn = store.connection;
  return (
    <div className={`app${store.showDrawer ? " drawer" : ""}`}>
      <Sidebar store={store} />
      <main className="main">
        <TopBar store={store} session={session} toggleTheme={toggleTheme} />
        {conn === "disconnected" || (conn === "connecting" && store.url) ? (
          <div className="notice on"><Icon name="alert" /><span>与服务器的连接已断开，任务仍在服务器上运行。正在重连…</span></div>
        ) : null}
        {session && !session.deviceOnline ? (
          <div className="notice on"><Icon name="alert" /><span>设备离线。新消息已排队，这段时间的文件错误可能由离线造成，写入也可能不完整。</span></div>
        ) : null}
        {store.error ? (
          <div className="notice on"><Icon name="alert" /><span>{store.error}</span><button onClick={() => store.dismissError()}>知道了</button></div>
        ) : null}
        {session ? (
          <>
            <TodoBar todos={session.thread.todos} />
            <ThreadView key={session.id} store={store} session={session} />
            <footer className="dock">
              <Activity store={store} session={session} />
              <Composer key={session.id} store={store} session={session} />
            </footer>
          </>
        ) : (
          <Welcome store={store} />
        )}
      </main>
      {store.showSettings ? <ConnectDialog store={store} /> : null}
      {store.showWorkspace ? <WorkspaceDialog store={store} /> : null}
      {store.stopping ? <ConfirmDialog store={store} session={store.stopping} /> : null}
      {store.showTasks && session ? <TasksDialog store={store} session={session} /> : null}
    </div>
  );
}
