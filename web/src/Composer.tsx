import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { CommandMenu, ModelMenu } from "./Dialogs";
import { Dropdown, Elapsed, formatDuration, formatTokens, Meter, Quota, quotaPercent, sessionStatus } from "./Common";
import { Icon } from "./Icon";
import { firstAsk, matchCommands, runningTasks, turnTokens, type SlashCommand } from "./model";
import { dropRef, mentionText, type DropRef } from "./paths";
import { isTouch, onFileDrop, pageVisible } from "./platform";
import { describeCwd, isResumeCommand, NEW_DRAFT, type Session, type Store } from "./store";

const INTERRUPT_TIMEOUT_MS = 5000;

/** 输入框上方的一行状态：正在做什么、用时、后台任务入口。 */
function Activity({ store, session }: { store: Store; session: Session }) {
  const thread = session.thread;
  const ask = firstAsk(thread);
  const busy = !ask && thread.phase !== "idle";
  const background = runningTasks(thread).length;
  // 用时由 Elapsed 自己刷新；这里只在中断等待时每秒检查是否超时。
  const waitingStop = busy && thread.interruptAt != null;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!waitingStop) return;
    const timer = setInterval(() => pageVisible() && setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waitingStop]);

  let text = busy || ask ? sessionStatus(session) : "";
  if (!text && background) text = `这一轮已结束，后台还有 ${background} 个任务在运行`;
  else if (!text && !session.running) text = "进程已结束，发消息时自动恢复";

  const interruptAt = busy ? thread.interruptAt : undefined;
  const unresponsive = interruptAt != null && now - interruptAt >= INTERRUPT_TIMEOUT_MS;
  if (interruptAt != null) text = unresponsive ? "进程没有响应，可以结束会话" : "正在中断…";

  const live = busy || background > 0;
  const hasTasks = [...thread.tasks.values()].some((task) => task.backgrounded);
  if (!text && !hasTasks) return <div className="activity empty" />;
  return (
    <div className="activity">
      {ask || live ? <span className="pulse" style={ask ? { animation: "none" } : undefined} /> : null}
      <span className="activity-text">{text}</span>
      {busy && thread.turnStartedAt ? <time>· <Elapsed since={thread.turnStartedAt} /></time> : null}
      {busy && turnTokens(thread) ? <span className="activity-tokens" title="这一轮的输出 token（含思考和子任务），生成中的部分是估算">· ↓ {formatTokens(turnTokens(thread))} tokens</span> : null}
      <span className="activity-right">
        {hasTasks ? <button onClick={() => store.togglePane("tasks")}><Icon name="tasks" size={13} />后台任务{background ? ` ${background}` : ""}</button> : null}
        {unresponsive ? <button onClick={() => store.askStop(session)}>结束会话</button> : null}
        {busy && interruptAt == null && isTouch ? <span className="esc" role="button" onClick={() => store.interrupt(session)}>中断</span> : null}
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

const MODES: Record<string, string> = {
  default: "每次询问",
  acceptEdits: "自动接受编辑",
  plan: "方案模式",
  auto: "自动",
  bypassPermissions: "跳过权限",
  dontAsk: "不询问",
};

/** 权限模式：只显示，沿用服务器上 claude 的设置。 */
function ModeLabel({ mode }: { mode?: string }) {
  const label = mode ? MODES[mode] ?? mode : "自动";
  return (
    <span className={`mode${mode === "bypassPermissions" ? " warn" : ""}`} title="权限模式沿用服务器上 claude 的设置，需要你决定的操作会在这里弹出卡片">
      <Icon name="shield" size={13} />{label}
    </span>
  );
}

/** 用量环：显示 5 小时额度，点开看本周额度、上下文和服务器内存。 */
function UsageRing({ store, session }: { store: Store; session?: Session }) {
  const five = quotaPercent(store.limits.fiveHour);
  const context = session?.thread.context;
  const contextValue = context?.max ? context.used / context.max : null;
  const value = five ?? contextValue;
  const r = 6.5;
  const length = 2 * Math.PI * r;
  const high = value != null && value >= 0.8;
  return (
    <Dropdown
      className="usage"
      label="用量"
      button={
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="9" cy="9" r={r} className="ring-bg" />
          <circle cx="9" cy="9" r={r} className={`ring-fg${high ? " high" : ""}`} strokeDasharray={`${length * (value ?? 0)} ${length}`} transform="rotate(-90 9 9)" />
        </svg>
      }
      menuClass="usage-card"
    >
      {() => (
        <>
          <div className="menu-title">额度</div>
          <Quota label="5 小时" window={store.limits.fiveHour} />
          <Quota label="本周" window={store.limits.sevenDay} />
          {session ? (
            <>
              <div className="menu-title">这个会话</div>
              <div className="stat-row" title="接近上限时可以发 /compact 压缩">
                <span>上下文</span>
                <Meter value={contextValue} />
                <span className="num">{context ? `${formatTokens(context.used)}${context.max ? ` / ${formatTokens(context.max)}` : ""}` : "—"}</span>
              </div>
              {session.thread.stats.turns ? (
                <div className="stat-row plain"><span>这次运行</span><span className="num">{session.thread.stats.turns} 轮 · {formatDuration(session.thread.stats.durationMs)} · {formatTokens(session.thread.stats.outputTokens)} tokens</span></div>
              ) : null}
            </>
          ) : null}
          <div className="menu-title">服务器</div>
          <div className="stat-row plain"><span>可用内存</span><span className="num">{store.memAvailableMb == null ? "—" : `${store.memAvailableMb} MB`}</span></div>
        </>
      )}
    </Dropdown>
  );
}

function Box({ children, menu, onSubmit }: { children: ReactNode; menu: ReactNode; onSubmit: () => void }) {
  return (
    <form className="composer" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      {menu}
      {children}
    </form>
  );
}

/** 输入框的文字、拖进来的文件和拖放高亮。`key` 是草稿键（会话 ID 或新会话）。 */
function useInput(store: Store, key: string, cwd: string | undefined) {
  const [text, setTextState] = useState(() => store.draft(key));
  const [hover, setHover] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const setText = (next: string) => {
    setTextState(next);
    store.setDraft(key, next);
  };
  // 排队的消息被放回输入框时重读草稿。
  useEffect(() => setTextState(store.draft(key)), [store.draftRev, key, store]);
  useEffect(() => onFileDrop({
    hover: setHover,
    drop: (paths) => {
      store.addFiles(key, paths.map((path) => dropRef(path, cwd)));
      ref.current?.focus();
    },
  }), [store, key, cwd]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "";
    // 矮窗口里不能把消息挤没：最多占窗口高度的 35%。
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT, Math.max(68, innerHeight * 0.35))}px`;
  }, [text]);
  const files = store.files(key);
  /** 取走文字和文件，拼成要发的消息。 */
  const take = (message: string) => {
    const paths = store.takeFiles(key).map((f) => f.path);
    setText("");
    return mentionText(paths, message);
  };
  return { text, setText, ref, hover, files, take, hasContent: !!text.trim() || files.length > 0 };
}

const MAX_INPUT_HEIGHT = 220;

/** 拖进来的文件，显示成小标签；项目外的标黄，服务器读不到。 */
function FileChips({ store, draftKey, files }: { store: Store; draftKey: string; files: DropRef[] }) {
  if (!files.length) return null;
  return (
    <div className="file-chips">
      {files.map((file) => (
        <span key={file.path} className={`file-chip${file.reachable ? "" : " far"}`} title={file.reachable ? file.path : `${file.path}\n不在项目目录里，服务器读不到这个文件`}>
          <Icon name={file.reachable ? "file" : "alert"} size={12} />
          <span>{lastSegment(file.path)}</span>
          <button type="button" aria-label="移除" onClick={() => store.removeFile(draftKey, file.path)}><Icon name="close" size={11} /></button>
        </span>
      ))}
    </div>
  );
}

const lastSegment = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** 一轮进行中发的消息：插入的等 CLI 收下，等结束的可以改或删。 */
function QueueList({ store, session, onEdit }: { store: Store; session: Session; onEdit: (text: string) => void }) {
  if (!session.queue.length) return null;
  return (
    <ul className="queue">
      {session.queue.map((q) => (
        <li key={q.id} className={q.mode}>
          <span className="queue-tag">{q.mode === "insert" ? "待插入" : "等结束"}</span>
          <span className="queue-text" title={q.text}>{q.text}</span>
          {q.mode === "wait" ? (
            <span className="queue-actions">
              <button type="button" title="放回输入框修改" aria-label="修改" onClick={() => onEdit(store.unqueue(session, q.id))}><Icon name="edit" size={13} /></button>
              <button type="button" title="删除" aria-label="删除" onClick={() => store.unqueue(session, q.id)}><Icon name="close" size={13} /></button>
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function Composer({ store, session }: { store: Store; session: Session }) {
  const input = useInput(store, session.id, session.cwd);
  const { text, setText, ref } = input;
  const thread = session.thread;
  const busy = thread.phase !== "idle" && !firstAsk(thread);
  /** 空闲时直接发；一轮进行中按 `mode` 排队（回车等结束，Ctrl+Enter 插入）。 */
  const submit = (message: string, mode: "wait" | "insert" = "wait") => {
    if (!message.trim() && !input.files.length) return;
    const full = input.take(message);
    if (busy) store.enqueue(session, full, mode);
    else store.sendText(session, full);
  };
  const send = (mode?: "wait" | "insert") => submit(text, mode);
  const commands = useCommandMenu(store.commandsFor(session), text, setText, (message) => submit(message));
  // 修改排队的消息：放回输入框，接在已有文字后面。
  const edit = (queued: string) => {
    setText(text.trim() ? `${text.trimEnd()}\n\n${queued}` : queued);
    ref.current?.focus();
  };
  // 有卡片等决定时不抢焦点，回车和 Esc 留给卡片。
  useEffect(() => {
    // 触屏上聚焦会弹出键盘，挡住内容。
    if (!isTouch && !firstAsk(session.thread)) ref.current?.focus();
  }, [session, ref]);
  useEffect(() => {
    if (!busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") store.interrupt(session);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [busy, store, session]);
  return (
    <footer className="dock">
      <Activity store={store} session={session} />
      <Box menu={commands.menu} onSubmit={() => send()}>
        <QueueList store={store} session={session} onEdit={edit} />
        <div className={`box${input.hover ? " drop" : ""}`}>
          <FileChips store={store} draftKey={session.id} files={input.files} />
          <textarea
            ref={ref}
            rows={1}
            aria-label="输入消息"
            placeholder={busy ? (isTouch ? "补充内容，这一轮结束后发送" : "补充内容：Enter 等这一轮结束后发送，Ctrl+Enter 插入这一轮") : "继续补充，输入 / 查看命令，可以拖入文件"}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (commands.onKeyDown(event)) return;
              if (!isTouch && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send(event.ctrlKey || event.metaKey ? "insert" : "wait");
              }
            }}
          />
          <div className="tools">
            <ModeLabel mode={thread.permissionMode} />
            <span className="grow" />
            <ModelMenu models={store.models} model={thread.model} effort={thread.effort} onChange={(value) => store.setModel(session, value)} onEffort={(value) => store.setEffort(session, value)} />
            <UsageRing store={store} session={session} />
            {busy && !input.hasContent ? (
              <button type="button" className="send stop" aria-label="中断" title="中断（Esc）" onClick={() => store.interrupt(session)}><Icon name="stop" size={14} /></button>
            ) : busy ? (
              <>
                <button type="button" className="send insert" aria-label="插入这一轮" title="插入这一轮：在下一个工具调用之后交给它（Ctrl+Enter）" onClick={() => send("insert")}>插入</button>
                <button className="send ready" aria-label="排队" title="等这一轮结束后发送（Enter）"><Icon name="enter" size={15} /></button>
              </>
            ) : (
              <button className={`send${input.hasContent ? " ready" : ""}`} aria-label="发送" title="发送（Enter）"><Icon name="enter" size={15} /></button>
            )}
          </div>
        </div>
      </Box>
    </footer>
  );
}

/** 新会话页的问候语，按当地时间变化。 */
function greeting(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  if (hour >= 18 && hour < 23) return "Good evening";
  return "Burning the midnight oil?";
}

export function Welcome({ store }: { store: Store }) {
  const input = useInput(store, NEW_DRAFT, store.cwd);
  const { text, setText } = input;
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<string>();
  const submit = (message: string) => {
    if (!message.trim() && !input.files.length) return;
    if (isResumeCommand(message)) {
      setText("");
      store.openResume();
      return;
    }
    // 还没选工作区时先选，文字留在输入框里。
    if (!store.cwd) {
      setText(message);
      store.openWorkspace();
      return;
    }
    store.newSession(input.take(message), store.cwd, model, effort);
  };
  const send = () => submit(text);
  const commands = useCommandMenu(store.commandsFor(), text, setText, submit);
  const { project, device } = describeCwd(store.cwd);
  return (
    <section className="welcome">
      <h1 className="greeting">{greeting(new Date().getHours())}</h1>
      <div className="chips">
        <button type="button" className="chip-btn" title={store.cwd || undefined} onClick={() => store.openWorkspace()}>
          <Icon name="folder" size={13} />
          <span>{project || "选择工作区"}</span>
          {device ? <small>{device}</small> : null}
        </button>
      </div>
      <Box menu={commands.menu} onSubmit={send}>
        <div className={`box tall${input.hover ? " drop" : ""}`}>
          <FileChips store={store} draftKey={NEW_DRAFT} files={input.files} />
          <textarea
            ref={input.ref}
            autoFocus={!isTouch}
            aria-label="输入任务"
            placeholder="描述任务，它会在后台持续运行，需要你时再叫你；可以拖入文件"
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
            <ModeLabel />
            <span className="grow" />
            <ModelMenu models={store.models} model={model || "default"} effort={effort} onChange={setModel} onEffort={setEffort} />
            <UsageRing store={store} />
            <button className={`send${input.hasContent ? " ready" : ""}`} aria-label="发送" title="发送（Enter）" disabled={!input.hasContent}><Icon name="enter" size={15} /></button>
          </div>
        </div>
      </Box>
    </section>
  );
}
