import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ConnectDialog, ModelMenu, WorkspaceDialog } from "./Dialogs";
import { Icon } from "./Icon";
import { firstAsk, isSending, isWaiting, type Ask, type Todo } from "./model";
import { describeCwd, type Session, type Store } from "./store";
import { describeTool, ThreadView } from "./Thread";

function askHint(ask?: Ask): string {
  if (ask?.kind === "plan") return "方案等你确认";
  if (ask?.kind === "question") return "有个问题要问你";
  return ask?.toolName === "Bash" ? "要运行一条命令" : "要你批准一个操作";
}

function SessionRow({ store, session }: { store: Store; session: Session }) {
  const waiting = isWaiting(session.thread);
  const current = store.selected === session.id;
  return (
    <button className={`row${current ? " current" : ""}`} onClick={() => store.select(session.id)}>
      <span className={`dot${waiting ? " wait" : session.running ? " run" : ""}`} />
      <span className="name">
        {session.title}
        {waiting ? <small>{askHint(firstAsk(session.thread))}</small> : null}
      </span>
    </button>
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

function Sidebar({ store }: { store: Store }) {
  const { waiting, running, recent } = store.groups();
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
        <span>服务器可用内存</span>
        <span>{store.memAvailableMb == null ? "—" : `${store.memAvailableMb} MB`}</span>
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
      <div className="crumb">
        <b>{session?.title ?? "新会话"}</b>
        {project ? <><span className="sep">/</span><span>{project}</span><span className="sep">/</span><span>{device}</span></> : null}
      </div>
      <div className="top-right">
        <div className="health">
          <button className={connClass} onClick={() => store.toggleSettings()}><i />{store.url ? connText : "未连接"}</button>
          {session ? <span className={offline ? "bad" : ""}><i />{offline ? "设备离线" : "设备在线"}</span> : null}
        </div>
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

function Activity({ store, session }: { store: Store; session: Session }) {
  const thread = session.thread;
  const ask = firstAsk(thread);
  const busy = !ask && thread.phase !== "idle";
  // 只在运行中每秒刷新用时，窗口不在前台时不刷新。
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => document.hasFocus() && setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  let text = "";
  if (!ask && isSending(thread)) text = session.deviceOnline ? (thread.claudeSessionId ? "正在发送" : "正在启动会话") : "设备离线，恢复后发送";
  else if (ask) text = ask.kind === "plan" ? "等待你确认方案" : ask.kind === "question" ? "等待你回答" : "等待你批准";
  else if (thread.phase === "thinking") text = "思考中";
  else if (thread.phase === "replying") text = "正在回复";
  else if (thread.phase === "tool") {
    const tool = thread.items.find((item) => item.kind === "tool" && item.id === thread.activeTool);
    if (tool?.kind === "tool") {
      const { verb, target } = describeTool(tool, session.cwd);
      text = `正在${verb} ${target}`;
    } else text = "正在执行";
  } else if (thread.background.size) text = `这一轮已结束，后台还有 ${thread.background.size} 个任务在运行`;
  else if (thread.lastTurn?.durationMs != null) {
    const tokens = thread.lastTurn.outputTokens;
    text = `上一轮用时 ${formatDuration(thread.lastTurn.durationMs)}${tokens ? ` · ${tokens} tokens` : ""}`;
  } else if (!session.running) text = "进程已休眠，发消息时自动恢复";

  const live = busy || thread.background.size > 0;
  return (
    <div className="activity">
      {ask || live ? <span className="pulse" style={ask ? { animation: "none" } : undefined} /> : null}
      <span className="activity-text">{text}</span>
      {busy && thread.turnStartedAt ? <time>· {formatDuration(now - thread.turnStartedAt)}</time> : null}
      {busy ? <span className="esc" role="button" onClick={() => store.interrupt(session)}>Esc 中断</span> : null}
    </div>
  );
}

function Composer({ store, session }: { store: Store; session: Session }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const thread = session.thread;
  const busy = thread.phase !== "idle" && !firstAsk(thread);
  const send = () => {
    if (!text.trim()) return;
    store.sendText(session, text);
    setText("");
  };
  // 有卡片等决定时不抢焦点，回车和 Esc 留给卡片。
  useEffect(() => {
    if (!firstAsk(session.thread)) ref.current?.focus();
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
      <textarea
        ref={ref}
        rows={1}
        aria-label="输入消息"
        placeholder={busy ? "继续补充，这一轮结束后会处理" : "继续补充"}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            send();
          }
        }}
      />
      <div className="tools">
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
  const [text, setText] = useState("");
  const [model, setModel] = useState("");
  const send = () => {
    if (!text.trim()) return;
    // 还没选工作区时先选，文字留在输入框里。
    if (!store.cwd) store.openWorkspace();
    else store.newSession(text, store.cwd, model);
  };
  const { project, device } = describeCwd(store.cwd);
  return (
    <section className="welcome">
      <h1>今天想让它做点什么？</h1>
      <form className="composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
        <textarea
          autoFocus
          aria-label="输入任务"
          placeholder="描述任务，它会在后台持续运行，需要你时再叫你"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
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

  const conn = store.connection;
  return (
    <div className="app">
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
            <ThreadView store={store} session={session} />
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
    </div>
  );
}
