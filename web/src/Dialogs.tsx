import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { backgroundTasks, findModel, hubHost, hubUrl, runningTasks, taskOutputPath, type ModelOption, type SlashCommand, type Task } from "./model";
import { describeCwd, type Session, type Store } from "./store";

/** 弹窗。Esc 只关弹窗，不能冒泡到窗口上变成中断任务。 */
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
  }, []);
  // 点击列表后焦点可能落到 body，所以在窗口的捕获阶段拦截，别处的 Esc 监听收不到。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header>
          <h2>{title}</h2>
          <button type="button" className="icon" aria-label="关闭" onClick={onClose}><Icon name="close" /></button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function ConnectDialog({ store }: { store: Store }) {
  const [host, setHost] = useState(() => hubHost(store.url));
  const [tried, setTried] = useState(false);
  const url = hubUrl(host);
  const current = tried && url === store.url;
  const status = !current
    ? null
    : store.connection === "connected"
      ? "已连接"
      : store.connection === "disconnected"
        ? "连接不上。请确认地址正确、服务器上的 hubd 在运行，并且这台设备已连上 Tailscale。"
        : "正在连接…";
  return (
    <Modal title="连接服务器" onClose={() => store.toggleSettings()}>
      <form onSubmit={(event) => { event.preventDefault(); if (url) { setTried(true); void store.connect(url); } }}>
        <label className="field">
          <span>服务器 IP</span>
          <input autoFocus spellCheck={false} placeholder="100.x.x.x" value={host} onChange={(event) => { setHost(event.target.value); setTried(false); }} />
        </label>
        <p className="help">填服务器的 Tailscale 地址（在服务器上运行 <code>tailscale ip -4</code> 查看）。本机 <code>ipconfig</code> 显示的是这台电脑自己的地址，不是服务器的。</p>
        {status ? <p className={`help${store.connection === "disconnected" ? " bad" : ""}`} role="status">{status}</p> : null}
        <div className="actions end">
          <button type="button" className="btn quiet" onClick={() => store.toggleSettings()}>取消</button>
          <button className="btn solid" disabled={!url}>连接</button>
        </div>
      </form>
    </Modal>
  );
}

const lastSegment = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

export function WorkspaceDialog({ store }: { store: Store }) {
  const { device, path, parent, entries, error, loading } = store.browse;
  const [manual, setManual] = useState("");
  const recent = store.recentWorkspaces();
  const close = () => store.closeWorkspace();
  const up = () => {
    if (parent) store.browseTo(device, parent);
    else if (path) store.browseTo(device, null);
    else store.browseTo(null, null);
  };
  return (
    <Modal title="选择工作区" onClose={close}>
      {!device && recent.length ? (
        <section className="picker">
          <h3>最近</h3>
          <div className="list short">
            {recent.map((cwd) => {
              const { project, device: where } = describeCwd(cwd);
              return (
                <button type="button" key={cwd} className="pick" title={cwd} onClick={() => store.chooseWorkspace(cwd)}>
                  <Icon name="folder" /><span>{project}</span><small>{where}</small>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}
      <section className="picker">
        {device ? (
          <div className="crumbs">
            <button type="button" className="icon" aria-label="上一级" onClick={up}><Icon name="back" /></button>
            <span title={path ?? device}>{device}{path ? ` · ${path}` : ""}</span>
          </div>
        ) : (
          <h3>设备</h3>
        )}
        <div className="list">
          {loading ? <p className="empty">正在读取…</p> : null}
          {!loading && error ? <p className="empty bad">{error}</p> : null}
          {!loading && !error && !entries.length ? <p className="empty">{device ? "没有子文件夹" : "没有登记的设备"}</p> : null}
          {!loading && !error
            ? entries.map((entry) => (
                <button
                  type="button"
                  key={entry}
                  className="pick"
                  title={entry}
                  onClick={() => (device ? store.browseTo(device, entry) : store.browseTo(entry, null))}
                >
                  <Icon name="folder" /><span>{device ? lastSegment(entry) : entry}</span><Icon name="chev" size={13} />
                </button>
              ))
            : null}
        </div>
      </section>
      {store.mountError ? <p className="help bad" role="alert">{store.mountError}</p> : null}
      <div className="actions end">
        {!device ? (
          <form className="manual" onSubmit={(event) => { event.preventDefault(); if (manual.startsWith("/")) store.chooseWorkspace(manual); }}>
            <input spellCheck={false} aria-label="服务器上的路径" placeholder="或输入服务器上的路径" value={manual} onChange={(event) => setManual(event.target.value)} />
            <button className="btn ghost" disabled={!manual.startsWith("/")}>使用</button>
          </form>
        ) : null}
        <button type="button" className="btn quiet" onClick={close}>取消</button>
        {device ? (
          <button type="button" className="btn solid" disabled={!path || loading || store.mounting} onClick={() => path && store.mount(device, path)}>
            {store.mounting ? "正在挂载…" : "选择这个文件夹"}
          </button>
        ) : null}
      </div>
    </Modal>
  );
}

export function ModelMenu({ models, model, onChange }: { models: ModelOption[]; model?: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = findModel(models, model);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    addEventListener("mousedown", onDown);
    return () => removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div
      className="model-wrap"
      ref={ref}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button type="button" className="model" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{current?.displayName ?? model ?? "默认模型"}</span><Icon name="down" size={12} />
      </button>
      {open ? (
        <div className="menu" role="menu">
          {models.map((option) => (
            <button
              type="button"
              key={option.value}
              role="menuitemradio"
              aria-checked={option === current}
              onClick={() => { onChange(option.value); setOpen(false); }}
            >
              <span><b>{option.displayName}</b>{option.description ? <small>{option.description}</small> : null}</span>
              {option === current ? <Icon name="check" size={14} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function CommandMenu({ commands, selected, onChoose }: { commands: SlashCommand[]; selected: number; onChoose: (command: SlashCommand) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return (
    <div className="commands" role="listbox" aria-label="命令" ref={ref}>
      {commands.map((command, i) => (
        <button
          type="button"
          key={command.name}
          role="option"
          aria-selected={i === selected}
          className={i === selected ? "on" : ""}
          // 用 mousedown，不让输入框失去焦点。
          onMouseDown={(event) => { event.preventDefault(); onChoose(command); }}
        >
          <b>/{command.name}{command.argumentHint ? <em> {command.argumentHint}</em> : null}</b>
          {command.description ? <small>{command.description}</small> : null}
        </button>
      ))}
    </div>
  );
}

export function ConfirmDialog({ store, session }: { store: Store; session: Session }) {
  const tasks = runningTasks(session.thread).length;
  return (
    <Modal title="结束这个会话？" onClose={() => store.cancelStop()}>
      <p className="help first">
        「{session.title}」还在工作{tasks ? `，后台有 ${tasks} 个任务` : ""}。结束后正在执行的操作会被终止，可能留下没做完的改动。
        之后在这个会话里发消息可以接着聊。
      </p>
      <div className="actions end">
        <button className="btn quiet" autoFocus onClick={() => store.cancelStop()}>继续运行</button>
        <button className="btn solid" onClick={() => store.stopSession(session)}>结束会话</button>
      </div>
    </Modal>
  );
}

const TASK_TYPES: Record<string, string> = { local_bash: "命令", local_agent: "子任务", remote_agent: "远程子任务" };
const TASK_STATUS: Record<Task["status"], string> = { running: "运行中", completed: "已完成", failed: "失败", stopped: "已停止" };

function taskDuration(task: Task): string {
  if (!task.startedAt) return "";
  const ms = (task.endedAt ?? Date.now()) - task.startedAt;
  if (ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
}

/** 后台任务：能看到做什么、跑了多久、状态、输出的最后一段，也能单独停掉。 */
export function TasksDialog({ store, session }: { store: Store; session: Session }) {
  const tasks = backgroundTasks(session.thread);
  const [openId, setOpenId] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const open = tasks.find((task) => task.id === openId);
  const path = open ? taskOutputPath(session.thread, open) : null;
  const running = open?.status === "running";
  const output = store.taskOutput?.path === path ? store.taskOutput : null;
  const pre = useRef<HTMLPreElement>(null);
  // 打开时刷新：用时每秒，输出在任务运行时每 3 秒。窗口不在前台时不刷新。
  useEffect(() => {
    const timer = setInterval(() => { if (document.hasFocus()) setTick(Date.now()); }, 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!path) return;
    store.readTaskOutput(path);
    if (!running) return;
    const timer = setInterval(() => { if (document.hasFocus()) store.readTaskOutput(path); }, 3000);
    return () => clearInterval(timer);
  }, [store, path, running]);
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [output?.text]);
  return (
    <Modal title="后台任务" onClose={() => store.closeTasks()}>
      <div className="tasks">
        {!tasks.length ? <p className="empty">没有后台任务</p> : null}
        {tasks.map((task) => (
          <div key={task.id} className={`task task-${task.status}`}>
            <div className="task-head">
              <button type="button" className="task-main" aria-expanded={task.id === openId} onClick={() => setOpenId(task.id === openId ? null : task.id)}>
                <span className="task-title" title={task.description}>{task.description ?? task.id}</span>
                <small>{TASK_TYPES[task.type ?? ""] ?? task.type ?? "任务"} · {TASK_STATUS[task.status]}{taskDuration(task) ? ` · ${taskDuration(task)}` : ""}</small>
              </button>
              {task.status === "running" ? <button type="button" className="btn quiet" onClick={() => store.stopTask(session, task.id)}>停止</button> : null}
            </div>
            {task.id === openId ? (
              <div className="task-body">
                {task.summary ? <p className="help first">{task.summary}</p> : null}
                {!path ? <p className="empty">这个任务没有可查看的输出文件</p> : null}
                {output?.error ? <p className="empty bad">{output.error}</p> : null}
                {path && !output?.error ? (
                  <pre className="output" ref={pre}>{output?.text == null ? "正在读取…" : output.text || "还没有输出"}</pre>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </Modal>
  );
}
