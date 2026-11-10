import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { FONTS, SIZES, THEMES, type Appearance } from "./appearance";
import { backgroundTasks, findModel, hubHost, hubUrl, runningTasks, taskOutputPath, type ModelOption, type SlashCommand, type Task } from "./model";
import { backgroundStatus, isAndroid, requestBatteryUnrestricted, type BackgroundStatus } from "./platform";
import { formatAgo } from "./sidebar";
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

/** 通知依赖后台连接，权限没开时要让用户看得到。 */
function BackgroundPanel() {
  const [status, setStatus] = useState<BackgroundStatus | null>(null);
  useEffect(() => {
    const load = () => { void backgroundStatus().then(setStatus); };
    load();
    addEventListener("focus", load);
    document.addEventListener("visibilitychange", load);
    return () => { removeEventListener("focus", load); document.removeEventListener("visibilitychange", load); };
  }, []);
  if (!status) return null;
  return (
    <div className="background">
      {!status.notificationsAllowed ? <p className="help bad">通知权限已关闭，需要你决定时不会提醒。请到系统设置里打开。</p> : null}
      {status.batteryUnrestricted
        ? <p className="help">后台运行不受电池优化限制。</p>
        : <p className="help">系统可能在息屏后断开连接。<button type="button" className="link-btn" onClick={() => void requestBatteryUnrestricted()}>允许后台运行</button></p>}
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
          <input autoFocus inputMode="url" autoCapitalize="none"spellCheck={false} placeholder="100.x.x.x" value={host} onChange={(event) => { setHost(event.target.value); setTried(false); }} />
        </label>
        <p className="help">填服务器的 Tailscale 地址（在服务器上运行 <code>tailscale ip -4</code> 查看）。{isAndroid ? "手机上要先打开 Tailscale 并登录同一账号。" : <>本机 <code>ipconfig</code> 显示的是这台电脑自己的地址，不是服务器的。</>}</p>
        {status ? <p className={`help${store.connection === "disconnected" ? " bad" : ""}`} role="status">{status}</p> : null}
        {isAndroid ? <BackgroundPanel /> : null}
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
      {/* 第一版手机端不浏览和挂载新项目。 */}
      {isAndroid ? (!recent.length ? <p className="empty">还没有用过的工作区，可以手动输入路径。</p> : null) : (
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
      )}
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
    <Modal title={store.archiveAfterStop ? "关闭这个会话？" : "结束这个会话？"} onClose={() => store.cancelStop()}>
      <p className="help first">
        「{session.title}」还在工作{tasks ? `，后台有 ${tasks} 个任务` : ""}。结束后正在执行的操作会被终止，可能留下没做完的改动。
        之后在这个会话里发消息可以接着聊。
      </p>
      <div className="actions end">
        <button className="btn quiet" autoFocus onClick={() => store.cancelStop()}>继续运行</button>
        {store.archiveAfterStop
          ? <button className="btn solid" onClick={() => store.archive(session)}>关闭会话</button>
          : <button className="btn solid" onClick={() => store.stopSession(session)}>结束会话</button>}
      </div>
    </Modal>
  );
}

/** `/resume`：已关闭的会话，按标题或项目名搜索，选中后回到侧边栏并打开。 */
export function ResumeDialog({ store }: { store: Store }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const q = query.trim().toLowerCase();
  const sessions = store.archivedSessions().filter((s) => !q || `${s.title} ${describeCwd(s.cwd).project}`.toLowerCase().includes(q));
  const now = Math.floor(Date.now() / 1000);
  const pick = (session?: Session) => { if (session) store.unarchive(session); };
  return (
    <Modal title="找回已关闭的会话" onClose={() => store.closeResume()}>
      <input
        className="resume-search"
        autoFocus
        placeholder="搜索标题或项目"
        value={query}
        onChange={(event) => { setQuery(event.target.value); setSelected(0); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setSelected((i) => Math.min(i + 1, sessions.length - 1)); }
          else if (event.key === "ArrowUp") { event.preventDefault(); setSelected((i) => Math.max(i - 1, 0)); }
          else if (event.key === "Enter") { event.preventDefault(); pick(sessions[selected]); }
        }}
      />
      <div className="resume-list" role="listbox">
        {!sessions.length ? <p className="empty">{q ? "没有匹配的会话" : "没有已关闭的会话"}</p> : null}
        {sessions.map((session, index) => (
          <button
            key={session.id}
            role="option"
            aria-selected={index === selected}
            className={`resume-item${index === selected ? " current" : ""}`}
            onMouseEnter={() => setSelected(index)}
            onClick={() => pick(session)}
          >
            <span className="title">{session.title}</span>
            <em>{describeCwd(session.cwd).project || "服务器"}</em>
            <span className="ago">{session.updated ? formatAgo(session.updated, now) : ""}</span>
          </button>
        ))}
      </div>
      <p className="help">关闭超过 7 天没有更新的会话会被自动清理。</p>
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

// 外观面板：配色、正文字体、字号，选中立即生效
export function AppearanceMenu({ look, onChange }: { look: Appearance; onChange: (patch: Partial<Appearance>) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
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
      className="look-wrap"
      ref={ref}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button type="button" className="icon" aria-label="外观" title="外观" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="palette" />
      </button>
      {open ? (
        <div className="look" role="dialog" aria-label="外观">
          <h4>配色</h4>
          <div className="opts" role="radiogroup" aria-label="配色">
            {THEMES.map((o) => (
              <button type="button" key={o.id} role="radio" aria-checked={look.theme === o.id} onClick={() => onChange({ theme: o.id })}>
                <i
                  className="sw"
                  style={{ background: o.id === "system" ? `linear-gradient(135deg, ${o.swatch[0]} 50%, ${o.swatch[1]} 50%)` : `linear-gradient(135deg, ${o.swatch[0]} 55%, ${o.swatch[2]} 55%)` }}
                />
                {o.label}
              </button>
            ))}
          </div>
          <h4>正文字体</h4>
          <div className="opts" role="radiogroup" aria-label="正文字体">
            {FONTS.map((o) => (
              <button type="button" key={o.id} role="radio" aria-checked={look.font === o.id} onClick={() => onChange({ font: o.id })}>
                <span className={`aa aa-${o.id}`}>Aa</span>{o.label}
              </button>
            ))}
          </div>
          <h4>字号</h4>
          <div className="opts" role="radiogroup" aria-label="字号">
            {SIZES.map((o) => (
              <button type="button" key={o.id} role="radio" aria-checked={look.size === o.id} onClick={() => onChange({ size: o.id })}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
