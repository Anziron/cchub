import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatDuration, formatTokens, Meter } from "./Common";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { backgroundTasks, collectChanges, findModel, groupChanges, isTranscript, latestPlan, parseTranscript, taskOutputPath, type ChangeGroup, type FileChange, type Task } from "./model";
import { pageVisible } from "./platform";
import { describeCwd, GLOBAL_PANES, type Session, type Store } from "./store";
import { Diff, TranscriptView } from "./Thread";
import { PANE_TITLES } from "./TopBar";
import { UsagePane } from "./UsagePane";

function ChangeFile({ file, name }: { file: FileChange; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="change" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary title={file.path}>
        <Icon name="chev" size={11} className="chev" />
        <span className="path"><b>{name}</b></span>
        <span className="added">+{file.added}</span>
        <span className="removed">−{file.removed}</span>
      </summary>
      {open ? file.edits.map((edit, i) => <Diff key={`${edit.toolId}-${i}`} oldText={edit.oldText} newText={edit.newText} />) : null}
    </details>
  );
}

/** 一个目录一组，可折叠；项目外的目录很长，省略开头、保留结尾。 */
function ChangeGroupView({ group, single }: { group: ChangeGroup; single: boolean }) {
  const files = group.files.map((file) => <ChangeFile key={file.path} file={file} name={file.name} />);
  if (single && !group.outside) return <div className="change-group flat">{files}</div>;
  return (
    <details className="change-group" open>
      <summary title={group.dir || "项目根目录"}>
        <Icon name="chev" size={11} className="chev" />
        <Icon name="folder" size={13} />
        <span className={`group-dir${group.outside ? " far" : ""}`}><bdi>{group.dir || "项目根目录"}</bdi></span>
        <span className="count">{group.files.length}</span>
      </summary>
      <div className="group-files">{files}</div>
    </details>
  );
}

function ChangesPane({ session }: { session: Session }) {
  const changes = collectChanges(session.thread.items);
  const groups = groupChanges(changes, session.cwd);
  const added = changes.reduce((n, c) => n + c.added, 0);
  const removed = changes.reduce((n, c) => n + c.removed, 0);
  if (!changes.length) return <p className="empty">这次运行还没有改动文件。</p>;
  const firstOutside = groups.findIndex((g) => g.outside);
  return (
    <>
      <p className="pane-sum">{changes.length} 个文件 <span className="added">+{added}</span> <span className="removed">−{removed}</span></p>
      {groups.map((group, i) => (
        <div key={`${group.outside}${group.dir}`}>
          {i === firstOutside ? <h4 className="change-section">项目外</h4> : null}
          <ChangeGroupView group={group} single={groups.length === 1} />
        </div>
      ))}
    </>
  );
}

const TASK_TYPES: Record<string, string> = { local_bash: "命令", local_agent: "子任务", remote_agent: "远程子任务" };
const TASK_STATUS: Record<Task["status"], string> = { running: "运行中", completed: "已完成", failed: "失败", stopped: "已停止" };

/** 任务用时。运行中的自己每秒刷新，不带着整个窗格（和里面的长输出）一起重画。 */
function TaskDuration({ task }: { task: Task }) {
  const [, setTick] = useState(0);
  const running = task.status === "running" && !task.endedAt;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => { if (pageVisible()) setTick(Date.now()); }, 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (!task.startedAt) return null;
  const ms = (task.endedAt ?? Date.now()) - task.startedAt;
  return ms < 0 ? null : <> · {formatDuration(ms)}</>;
}

/** 子任务记录先只显示最后这么多条，长记录一次全画出来会卡住。 */
const TRANSCRIPT_VISIBLE = 30;
/** 子任务记录每次读到的是最后 256KB，任务跑着时刷新慢一点。 */
const TRANSCRIPT_REFRESH = 5000;
const OUTPUT_REFRESH = 3000;

/** 输出内容按文本比较，文本没变就不重画；子任务记录只解析一次。 */
const TaskOutput = memo(function TaskOutput({ text, cwd }: { text: string | null; cwd?: string }) {
  const box = useRef<HTMLDivElement & HTMLPreElement>(null);
  // 在底部附近才跟随新输出；往上翻着看时不被拉回底部。
  const stick = useRef(true);
  const onScroll = () => {
    const el = box.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  const [showAll, setShowAll] = useState(false);
  const transcript = useMemo(() => (text && isTranscript(text) ? parseTranscript(text) : null), [text]);
  useEffect(() => {
    if (box.current && stick.current) box.current.scrollTop = box.current.scrollHeight;
  }, [text]);
  if (!transcript) return <pre className="output" ref={box} onScroll={onScroll}>{text == null ? "正在读取…" : text || "还没有输出"}</pre>;
  const hidden = showAll ? 0 : Math.max(0, transcript.length - TRANSCRIPT_VISIBLE);
  return (
    <div className="output transcript" ref={box} onScroll={onScroll}>
      {hidden ? <button type="button" className="row more" onClick={() => setShowAll(true)}>显示更早的 {hidden} 条</button> : null}
      <TranscriptView items={hidden ? transcript.slice(hidden) : transcript} cwd={cwd} />
    </div>
  );
});

/** 后台任务：能看到做什么、跑了多久、状态、输出的最后一段，也能单独停掉。 */
function TasksPane({ store, session }: { store: Store; session: Session }) {
  const tasks = backgroundTasks(session.thread);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = tasks.find((task) => task.id === openId);
  const path = open ? taskOutputPath(session.thread, open) : null;
  const running = open?.status === "running";
  const output = store.taskOutput?.path === path ? store.taskOutput : null;
  const slow = output?.text != null && isTranscript(output.text);
  // 打开时读一次，任务运行时定时刷新。窗口看不见时不刷新（失去焦点照常刷新）。
  useEffect(() => {
    if (path) store.readTaskOutput(path);
  }, [store, path]);
  useEffect(() => {
    if (!path || !running) return;
    const timer = setInterval(() => { if (pageVisible()) store.readTaskOutput(path); }, slow ? TRANSCRIPT_REFRESH : OUTPUT_REFRESH);
    return () => clearInterval(timer);
  }, [store, path, running, slow]);
  if (!tasks.length) return <p className="empty">没有后台任务。</p>;
  return (
    <div className="tasks">
      {tasks.map((task) => (
        <div key={task.id} className={`task task-${task.status}`}>
          <div className="task-head">
            <button type="button" className="task-main" aria-expanded={task.id === openId} onClick={() => setOpenId(task.id === openId ? null : task.id)}>
              <span className="task-title" title={task.description}>{task.description ?? task.id}</span>
              <small>{TASK_TYPES[task.type ?? ""] ?? task.type ?? "任务"} · {TASK_STATUS[task.status]}<TaskDuration task={task} /></small>
            </button>
            {task.status === "running" ? <button type="button" className="btn quiet" onClick={() => store.stopTask(session, task.id)}>停止</button> : null}
          </div>
          {task.id === openId ? (
            <div className="task-body">
              {task.summary ? <p className="help first">{task.summary}</p> : null}
              {!path ? <p className="empty">这个任务没有可查看的输出文件</p> : null}
              {output?.error ? <p className="empty bad">{output.error}</p> : null}
              {path && !output?.error ? <TaskOutput key={path} text={output?.text ?? null} cwd={session.cwd} /> : null}
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
      <h4 title="只统计当前进程，进程被回收后重新计数">这次运行</h4>
      <Row label="轮数">{stats.turns}</Row>
      <Row label="用时">{formatDuration(stats.durationMs)}</Row>
      <Row label="输出">{formatTokens(stats.outputTokens)} tokens</Row>
      {thread.lastTurn?.durationMs != null ? <Row label="上一轮">{formatDuration(thread.lastTurn.durationMs)}{thread.lastTurn.outputTokens ? ` · ${formatTokens(thread.lastTurn.outputTokens)} tokens` : ""}</Row> : null}
      <h4>模型</h4>
      <Row label="模型">{model?.displayName ?? thread.model ?? "默认"}</Row>
      <Row label="会话 ID"><code>{thread.claudeSessionId ?? "—"}</code></Row>
    </>
  );
}

export function PaneView({ store, session }: { store: Store; session?: Session }) {
  const pane = store.pane;
  // 新会话页只显示不依赖会话的窗格。
  if (!pane || (!session && !GLOBAL_PANES.includes(pane))) return null;
  return (
    <aside className="pane" aria-label={PANE_TITLES[pane]}>
      <header>
        <h3>{PANE_TITLES[pane]}</h3>
        <button type="button" className="icon" aria-label="关闭窗格" title="关闭窗格" onClick={() => store.closePane()}><Icon name="close" size={14} /></button>
      </header>
      <div className={`pane-body pane-${pane}`}>
        {session && pane === "changes" ? <ChangesPane session={session} /> : null}
        {session && pane === "tasks" ? <TasksPane store={store} session={session} /> : null}
        {session && pane === "todos" ? <TodosPane session={session} /> : null}
        {session && pane === "plan" ? <PlanPane session={session} /> : null}
        {session && pane === "info" ? <InfoPane store={store} session={session} /> : null}
        {pane === "usage" ? <UsagePane store={store} /> : null}
      </div>
    </aside>
  );
}
