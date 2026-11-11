import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatDuration, formatTokens, Meter, resumeCommand } from "./Common";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { backgroundTasks, collectChanges, findModel, isTranscript, latestPlan, parseTranscript, taskOutputPath, type FileChange, type Task } from "./model";
import { pageVisible } from "./platform";
import { describeCwd, type Session, type Store } from "./store";
import { Diff, TranscriptView } from "./Thread";
import { PANE_TITLES } from "./TopBar";

function splitPath(path: string, cwd?: string): { dir: string; name: string } {
  const rel = cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
  const cut = rel.lastIndexOf("/") + 1;
  return { dir: rel.slice(0, cut), name: rel.slice(cut) };
}

function ChangeFile({ file, cwd }: { file: FileChange; cwd?: string }) {
  const [open, setOpen] = useState(false);
  const { dir, name } = splitPath(file.path, cwd);
  return (
    <details className="change" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary title={file.path}>
        <Icon name="chev" size={11} className="chev" />
        <span className="path"><span className="dir">{dir}</span><b>{name}</b></span>
        <span className="added">+{file.added}</span>
        <span className="removed">−{file.removed}</span>
      </summary>
      {open ? file.edits.map((edit, i) => <Diff key={`${edit.toolId}-${i}`} oldText={edit.oldText} newText={edit.newText} />) : null}
    </details>
  );
}

function ChangesPane({ session }: { session: Session }) {
  const changes = collectChanges(session.thread.items);
  const added = changes.reduce((n, c) => n + c.added, 0);
  const removed = changes.reduce((n, c) => n + c.removed, 0);
  if (!changes.length) return <p className="empty">这次运行还没有改动文件。</p>;
  return (
    <>
      <p className="pane-sum">{changes.length} 个文件 <span className="added">+{added}</span> <span className="removed">−{removed}</span></p>
      {changes.map((file) => <ChangeFile key={file.path} file={file} cwd={session.cwd} />)}
      <p className="help">只统计 Edit、MultiEdit、Write 工具的改动，命令行产生的改动不在这里。</p>
    </>
  );
}

const TASK_TYPES: Record<string, string> = { local_bash: "命令", local_agent: "子任务", remote_agent: "远程子任务" };
const TASK_STATUS: Record<Task["status"], string> = { running: "运行中", completed: "已完成", failed: "失败", stopped: "已停止" };

function taskDuration(task: Task): string {
  if (!task.startedAt) return "";
  const ms = (task.endedAt ?? Date.now()) - task.startedAt;
  return ms < 0 ? "" : formatDuration(ms);
}

/** 后台任务：能看到做什么、跑了多久、状态、输出的最后一段，也能单独停掉。 */
function TasksPane({ store, session }: { store: Store; session: Session }) {
  const tasks = backgroundTasks(session.thread);
  const [openId, setOpenId] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const open = tasks.find((task) => task.id === openId);
  const path = open ? taskOutputPath(session.thread, open) : null;
  const running = open?.status === "running";
  const output = store.taskOutput?.path === path ? store.taskOutput : null;
  const pre = useRef<HTMLDivElement & HTMLPreElement>(null);
  const transcript = useMemo(
    () => (output?.text && isTranscript(output.text) ? parseTranscript(output.text) : null),
    [output?.text],
  );
  // 打开时刷新：用时每秒，输出在任务运行时每 3 秒。窗口看不见时不刷新（失去焦点照常刷新）。
  useEffect(() => {
    const timer = setInterval(() => { if (pageVisible()) setTick(Date.now()); }, 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!path) return;
    store.readTaskOutput(path);
    if (!running) return;
    const timer = setInterval(() => { if (pageVisible()) store.readTaskOutput(path); }, 3000);
    return () => clearInterval(timer);
  }, [store, path, running]);
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [output?.text]);
  if (!tasks.length) return <p className="empty">没有后台任务。</p>;
  return (
    <div className="tasks">
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
              {path && !output?.error && transcript ? (
                <div className="output transcript" ref={pre}><TranscriptView items={transcript} cwd={session.cwd} /></div>
              ) : path && !output?.error ? (
                <pre className="output" ref={pre}>{output?.text == null ? "正在读取…" : output.text || "还没有输出"}</pre>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function TodosPane({ session }: { session: Session }) {
  const todos = session.thread.todos;
  if (!todos.length) return <p className="empty">这个会话没有待办清单。</p>;
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <>
      <div className="stat-row"><span>进度</span><Meter value={done / todos.length} /><span className="num">{done} / {todos.length}</span></div>
      <ul className="todo-list">
        {todos.map((t) => (
          <li key={t.content} className={t.status === "completed" ? "done" : t.status === "in_progress" ? "doing" : ""}>
            <span className="box-mark" aria-hidden="true">{t.status === "completed" ? <Icon name="check" size={11} /> : null}</span>
            <span>{t.status === "in_progress" ? t.activeForm ?? t.content : t.content}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function PlanPane({ session }: { session: Session }) {
  const plan = latestPlan(session.thread);
  if (!plan) return <p className="empty">这次运行还没有提交过方案。</p>;
  return <div className="pane-plan"><Markdown text={plan} /></div>;
}

function Row({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return <div className="kv" title={title}><span>{label}</span><span>{children}</span></div>;
}

function InfoPane({ store, session }: { store: Store; session: Session }) {
  const thread = session.thread;
  const { project, device } = describeCwd(session.cwd);
  const context = thread.context;
  const model = findModel(store.models, thread.model);
  const command = resumeCommand(session);
  const stats = thread.stats;
  return (
    <>
      <h4>环境</h4>
      <Row label="项目">{project || "—"}</Row>
      <Row label="设备"><span className={session.deviceOnline ? "ok-dot" : "bad-dot"} />{device || "服务器"} · {session.deviceOnline ? "在线" : "离线"}</Row>
      <Row label="路径" title={session.cwd}><code>{session.cwd ?? "—"}</code></Row>
      <Row label="进程">{session.running ? "运行中" : "已结束（发消息时自动恢复）"}</Row>
      <h4>上下文</h4>
      <div className="stat-row" title="接近上限时可以发 /compact 压缩">
        <span>已用</span>
        <Meter value={context?.max ? context.used / context.max : null} />
        <span className="num">{context ? `${formatTokens(context.used)}${context.max ? ` / ${formatTokens(context.max)}` : ""}` : "—"}</span>
      </div>
      <h4>这次运行</h4>
      <Row label="轮数">{stats.turns}</Row>
      <Row label="用时">{formatDuration(stats.durationMs)}</Row>
      <Row label="输出">{formatTokens(stats.outputTokens)} tokens</Row>
      {thread.lastTurn?.durationMs != null ? <Row label="上一轮">{formatDuration(thread.lastTurn.durationMs)}{thread.lastTurn.outputTokens ? ` · ${formatTokens(thread.lastTurn.outputTokens)} tokens` : ""}</Row> : null}
      <h4>模型</h4>
      <Row label="模型">{model?.displayName ?? thread.model ?? "默认"}</Row>
      <Row label="会话 ID"><code>{thread.claudeSessionId ?? "—"}</code></Row>
      {command ? (
        <button type="button" className="btn ghost copy-cmd" onClick={() => void navigator.clipboard?.writeText(command)}><Icon name="copy" size={13} />复制终端恢复命令</button>
      ) : null}
      <p className="help">“这次运行”只统计当前进程；进程被回收后重新开始计数。</p>
    </>
  );
}

export function PaneView({ store, session }: { store: Store; session: Session }) {
  const pane = store.pane;
  if (!pane) return null;
  return (
    <aside className="pane" aria-label={PANE_TITLES[pane]}>
      <header>
        <h3>{PANE_TITLES[pane]}</h3>
        <button type="button" className="icon" aria-label="关闭窗格" title="关闭窗格" onClick={() => store.closePane()}><Icon name="close" size={14} /></button>
      </header>
      <div className={`pane-body pane-${pane}`}>
        {pane === "changes" ? <ChangesPane session={session} /> : null}
        {pane === "tasks" ? <TasksPane store={store} session={session} /> : null}
        {pane === "todos" ? <TodosPane session={session} /> : null}
        {pane === "plan" ? <PlanPane session={session} /> : null}
        {pane === "info" ? <InfoPane store={store} session={session} /> : null}
      </div>
    </aside>
  );
}
