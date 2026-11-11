import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { CommandMenu, ModelMenu } from "./Dialogs";
import { Dropdown, Elapsed, formatDuration, formatTokens, Meter, Quota, quotaPercent, sessionStatus } from "./Common";
import { Icon } from "./Icon";
import { firstAsk, matchCommands, runningTasks, type SlashCommand } from "./model";
import { isTouch, pageVisible } from "./platform";
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

export function Composer({ store, session }: { store: Store; session: Session }) {
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
    el.style.height = "24px";
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
    <footer className="dock">
      <Activity store={store} session={session} />
      <Box menu={commands.menu} onSubmit={send}>
        <div className="box">
          <textarea
            ref={ref}
            rows={1}
            aria-label="输入消息"
            placeholder={busy ? "继续补充，这一轮结束后会处理" : "继续补充，输入 / 查看命令"}
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
          {busy && !text ? (
            <button type="button" className="send stop" aria-label="中断" title="中断（Esc）" onClick={() => store.interrupt(session)}><Icon name="stop" size={14} /></button>
          ) : (
            <button className={`send${text.trim() ? " ready" : ""}`} aria-label="发送" title="发送（Enter）"><Icon name="enter" size={15} /></button>
          )}
        </div>
        <div className="tools">
          <ModeLabel mode={thread.permissionMode} />
          <span className="grow" />
          <ModelMenu models={store.models} model={thread.model} effort={thread.effort} onChange={(value) => store.setModel(session, value)} onEffort={(value) => store.setEffort(session, value)} />
          <UsageRing store={store} session={session} />
        </div>
      </Box>
    </footer>
  );
}

export function Welcome({ store }: { store: Store }) {
  const [text, setTextState] = useState(() => store.draft(NEW_DRAFT));
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<string>();
  const setText = (next: string) => {
    setTextState(next);
    store.setDraft(NEW_DRAFT, next);
  };
  const submit = (message: string) => {
    if (!message.trim()) return;
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
    setText("");
    store.newSession(message, store.cwd, model, effort);
  };
  const send = () => submit(text);
  const commands = useCommandMenu(store.commandsFor(), text, setText, submit);
  const { project, device } = describeCwd(store.cwd);
  return (
    <section className="welcome">
      <h1>今天想让它做点什么？</h1>
      <div className="chips">
        <button type="button" className="chip-btn" title={store.cwd || undefined} onClick={() => store.openWorkspace()}>
          <Icon name="folder" size={13} />
          <span>{project || "选择工作区"}</span>
          {device ? <small>{device}</small> : null}
        </button>
      </div>
      <Box menu={commands.menu} onSubmit={send}>
        <div className="box tall">
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
          <button className={`send${text.trim() ? " ready" : ""}`} aria-label="发送" title="发送（Enter）" disabled={!text.trim()}><Icon name="enter" size={15} /></button>
        </div>
        <div className="tools">
          <ModeLabel />
          <span className="grow" />
          <ModelMenu models={store.models} model={model || "default"} effort={effort} onChange={setModel} onEffort={setEffort} />
          <UsageRing store={store} />
        </div>
      </Box>
    </section>
  );
}
