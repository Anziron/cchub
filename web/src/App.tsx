import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "./Icon";
import { firstAsk, isWaiting, type Ask, type Todo } from "./model";
import { describeCwd, type Session, type Store } from "./store";
import { describeTool, ThreadView } from "./Thread";

const MODELS = [
  ["sonnet", "Sonnet"],
  ["opus", "Opus"],
  ["haiku", "Haiku"],
];

function modelLabel(model?: string): string {
  const found = MODELS.find(([id]) => model?.includes(id));
  return found ? found[0] : "";
}

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

function Sidebar({ store }: { store: Store }) {
  const { waiting, running, recent } = store.groups();
  const projects = new Map<string, Session[]>();
  for (const session of recent) {
    const { project } = describeCwd(session.cwd);
    projects.set(project, [...(projects.get(project) ?? []), session]);
  }
  return (
    <aside className="side">
      <div className="wordmark">cchub</div>
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
            {[...projects].map(([project, sessions]) => (
              <div key={project}>
                <div className="row project">{project || "未指定目录"}</div>
                {sessions.map((s) => <SessionRow key={s.id} store={store} session={s} />)}
              </div>
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
          <span className={connClass}><i />{connText}</span>
          {session ? <span className={offline ? "bad" : ""}><i />{offline ? "设备离线" : "设备在线"}</span> : null}
        </div>
        <button className="icon" aria-label="切换深浅色" onClick={toggleTheme}><Icon name="moon" /></button>
        <button className="icon" aria-label="设置" onClick={() => store.toggleSettings()}><Icon name="gear" /></button>
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
  if (ask) text = ask.kind === "plan" ? "等待你确认方案" : ask.kind === "question" ? "等待你回答" : "等待你批准";
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
        <select className="model" aria-label="模型" value={modelLabel(thread.model)} onChange={(event) => store.setModel(session, event.target.value)}>
          {modelLabel(thread.model) ? null : <option value="">{thread.model ?? "默认模型"}</option>}
          {MODELS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
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
  const cwds = [...new Set([...store.sessions.values()].flatMap((s) => (s.cwd ? [s.cwd] : [])))];
  const [text, setText] = useState("");
  const [cwd, setCwd] = useState(() => localStorage.getItem("cchub.cwd") ?? cwds[0] ?? "");
  const [model, setModel] = useState("");
  const valid = text.trim() && cwd.startsWith("/");
  const send = () => {
    if (!valid) return;
    localStorage.setItem("cchub.cwd", cwd);
    store.newSession(text, cwd, model);
  };
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
          <input className="path" list="cwds" aria-label="项目目录" placeholder="服务器上的项目目录，如 /mnt/pc-home/d/frame/x" value={cwd} onChange={(event) => setCwd(event.target.value)} />
          <datalist id="cwds">{cwds.map((c) => <option key={c} value={c} />)}</datalist>
          <select className="model" aria-label="模型" value={model} onChange={(event) => setModel(event.target.value)}>
            <option value="">默认模型</option>
            {MODELS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          <button className="send" aria-label="发送" disabled={!valid}><Icon name="up" /></button>
        </div>
      </form>
    </section>
  );
}

function Settings({ store }: { store: Store }) {
  const [url, setUrl] = useState(store.url || "ws://");
  const valid = /^wss?:\/\/.+/.test(url);
  return (
    <section className="welcome">
      <h1>连接到你的服务器</h1>
      <form className="composer" onSubmit={(event) => { event.preventDefault(); if (valid) void store.connect(url); }}>
        <textarea autoFocus aria-label="服务器地址" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="ws://服务器的 Tailscale 地址:端口/ws" />
        <div className="tools">
          <span className="hint">地址保存在这台设备上</span>
          <button className="send" aria-label="连接" disabled={!valid}><Icon name="up" /></button>
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
        {store.showSettings ? (
          <Settings store={store} />
        ) : session ? (
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
    </div>
  );
}
