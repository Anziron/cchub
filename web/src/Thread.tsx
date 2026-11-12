import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AskCard } from "./AskCard";
import { Icon } from "./Icon";
import { linkify, Markdown, WebLink } from "./Markdown";
import { groupTools, searchLinks, type Item, type RenderBlock, type ToolItem } from "./model";
import { formatDuration, formatTokens } from "./Common";
import { isTouch } from "./platform";
import type { Session, Store } from "./store";

function relative(path: unknown, cwd?: string): string {
  const text = String(path ?? "");
  return cwd && text.startsWith(`${cwd}/`) ? text.slice(cwd.length + 1) : text;
}

function lineCount(text: unknown): number {
  return typeof text === "string" && text ? text.split("\n").length : 0;
}

export function describeTool(tool: Pick<ToolItem, "name" | "input">, cwd?: string): { verb: string; target: string; icon: string } {
  const input = tool.input;
  const line = (value: unknown) => String(value ?? "").split("\n")[0];
  switch (tool.name) {
    case "Bash":
      return { verb: "运行", target: line(input.command), icon: "term" };
    case "Read":
      return { verb: "读取", target: relative(input.file_path, cwd), icon: "file" };
    case "Edit":
    case "MultiEdit":
      return { verb: "编辑", target: relative(input.file_path, cwd), icon: "file" };
    case "Write":
      return { verb: "写入", target: relative(input.file_path, cwd), icon: "file" };
    case "Grep":
      return { verb: "搜索", target: line(input.pattern), icon: "file" };
    case "Glob":
      return { verb: "查找", target: line(input.pattern), icon: "file" };
    case "WebFetch":
      return { verb: "打开", target: line(input.url), icon: "file" };
    case "WebSearch":
      return { verb: "搜索网页", target: line(input.query), icon: "file" };
    case "Task":
    case "Agent":
      return { verb: "子任务：", target: line(input.description), icon: "agents" };
    case "Skill":
      return { verb: "使用技能", target: line(input.skill), icon: "file" };
    case "AskUserQuestion":
      return { verb: "提问", target: "", icon: "think" };
    case "ExitPlanMode":
      return { verb: "提交方案", target: "", icon: "think" };
    default:
      return { verb: tool.name, target: "", icon: "file" };
  }
}

export function Diff({ oldText, newText }: { oldText: string; newText: string }) {
  const removed = oldText ? oldText.split("\n") : [];
  const added = newText ? newText.split("\n") : [];
  return (
    <div className="diff">
      {removed.map((line, i) => <div className="d" key={`d${i}`}>- {line}</div>)}
      {added.map((line, i) => <div className="a" key={`a${i}`}>+ {line}</div>)}
    </div>
  );
}

function Step({ icon, label, children, className }: { icon: string; label: ReactNode; children?: ReactNode; className?: string }) {
  // 展开时才渲染内容，大结果不占 DOM。
  const [open, setOpen] = useState(false);
  return (
    <details className={className ? `step ${className}` : "step"} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <Icon name={icon} size={14} />
        <span className="label">{label}</span>
        {children ? <Icon name="chev" size={12} className="chev" /> : null}
      </summary>
      {open ? children : null}
    </details>
  );
}

/** 错误默认只显示第一行，长内容点开再看。 */
function ErrorBox({ title, text }: { title: string; text: string }) {
  const first = text.split("\n")[0];
  if (first === text && text.length <= 120) {
    return <div className="blocked"><b>{title}</b><code>{text}</code></div>;
  }
  return (
    <details className="blocked error-fold">
      <summary>
        <b>{title}</b>
        <code>{first}</code>
        <Icon name="chev" size={14} className="chev" />
      </summary>
      <pre className="output">{text}</pre>
    </details>
  );
}

/** 网页搜索结果：链接列表（标题 + 域名，点了用系统浏览器打开），后面是模型拿到的摘要。 */
function SearchResult({ result }: { result: string }) {
  const parsed = searchLinks(result);
  if (!parsed) return null;
  const host = (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  };
  return (
    <div className="body">
      <ul className="search-links">
        {parsed.links.map((link, i) => (
          <li key={`${i}-${link.url}`}><WebLink url={link.url}>{link.title}</WebLink><small>{host(link.url)}</small></li>
        ))}
      </ul>
      {parsed.rest ? <pre className="output">{linkify(parsed.rest)}</pre> : null}
    </div>
  );
}

/** 被拒绝或中断的调用也是 is_error，不能显示成失败。 */
const notRun = (tool: ToolItem) => /^(The user doesn't want|用户)/.test(tool.result ?? "");
const failed = (tool: ToolItem) => tool.blocked || (tool.isError && !notRun(tool));

const Tool = memo(function Tool({ tool, cwd }: { tool: ToolItem; cwd?: string }) {
  const { verb, target, icon } = describeTool(tool, cwd);
  const skipped = notRun(tool);
  const isEdit = tool.name === "Edit" && typeof tool.input.new_string === "string";
  const label = (
    <>
      {verb} {target ? <span className="chip">{target}</span> : null}
      {isEdit ? (
        <>
          {" "}<span className="added">+{lineCount(tool.input.new_string)}</span>{" "}
          <span className="removed">−{lineCount(tool.input.old_string)}</span>
        </>
      ) : null}
      {tool.children ? ` · ${tool.children} 次工具调用` : ""}
      {tool.blocked ? " · 被拦截" : skipped ? " · 未执行" : tool.isError ? " · 失败" : ""}
    </>
  );
  const body = tool.blocked ? (
    <div className="body"><pre className="output bad">{tool.result}</pre></div>
  ) : tool.detail ? (
    <div className="body"><Markdown text={tool.detail} /></div>
  ) : isEdit ? (
    <Diff oldText={String(tool.input.old_string ?? "")} newText={String(tool.input.new_string ?? "")} />
  ) : tool.result && tool.name === "WebSearch" && searchLinks(tool.result) ? (
    <SearchResult result={tool.result} />
  ) : tool.result ? (
    <div className="body">
      <pre className="output">{linkify(tool.result)}</pre>
      {tool.truncated ? <em>内容过长，只显示开头</em> : null}
    </div>
  ) : undefined;
  return <Step icon={icon} label={label} className={failed(tool) ? "failed" : undefined}>{body}</Step>;
});

/** 连续的工具调用合并成一行“用了 N 个工具”，展开后逐条显示。 */
const ToolGroup = memo(function ToolGroup({ tools, cwd, active }: { tools: ToolItem[]; cwd?: string; active?: ToolItem }) {
  const fails = tools.filter(failed).length;
  const verbs = new Map<string, number>();
  for (const tool of tools) {
    const { verb } = describeTool(tool, cwd);
    const key = verb.replace(/：$/, "");
    verbs.set(key, (verbs.get(key) ?? 0) + 1);
  }
  const now = active ? describeTool(active, cwd) : null;
  const label = (
    <>
      {now ? <>正在{now.verb} {now.target ? <span className="chip">{now.target}</span> : null}</> : `用了 ${tools.length} 个工具`}
      <span className="verbs">{[...verbs].map(([verb, n]) => (n > 1 ? `${verb} ${n}` : verb)).join(" · ")}</span>
      {fails ? <span className="fails"> · {fails} 个失败</span> : null}
    </>
  );
  return (
    <Step icon={now ? "term" : "tasks"} label={label} className={`group-step${fails ? " failed" : ""}${now ? " running" : ""}`}>
      <div className="group-body">{tools.map((tool) => <Tool key={tool.id} tool={tool} cwd={cwd} />)}</div>
    </Step>
  );
}, (a, b) => a.cwd === b.cwd && a.active === b.active && a.tools.length === b.tools.length && a.tools.every((t, i) => t === b.tools[i]));

/**
 * 条目按引用比较（model 里是替换而不是原地改）。session 和 store 是原地修改的稳定对象，
 * 不能直接当依据：审批卡的 `sent` 是原地改的，所以单独作为 prop 传入；cwd 同理。
 */
const ItemView = memo(function ItemView({ item, store, session, askSent }: { item: Item; store: Store; session: Session; askSent?: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        <>
          <div className="user" data-turn={item.id}><div>{item.text}</div></div>
          {item.state === "sending" ? <div className="sent">发送中…</div> : null}
          {item.state === "failed" ? (
            <div className="sent failed">
              没有发送成功
              <button onClick={() => store.retry(session, item.id, item.text)}>重试</button>
            </div>
          ) : null}
        </>
      );
    case "text":
      return <Markdown text={item.text} live={item.live} />;
    case "thinking":
      return <Step icon="think" label="思考过程"><div className="body">{item.text}</div></Step>;
    case "tool":
      return <Tool tool={item} cwd={session.cwd} />;
    case "ask": {
      const ask = session.thread.asks.get(item.requestId);
      // askSent 只用来让 memo 在 `sent` 变化时重画。
      return ask ? <AskCard key={String(askSent)} ask={ask} session={session} store={store} /> : null;
    }
    case "interrupted":
      return <div className="stopped">已中断</div>;
    case "notice":
      return <div className="stopped local-note">{item.text}</div>;
    case "error":
      return <ErrorBox title="这一轮出错了" text={item.text} />;
    case "turn":
      return <TurnLine item={item} />;
  }
});

function TurnLine({ item }: { item: Extract<Item, { kind: "turn" }> }) {
  const parts = [item.durationMs != null ? formatDuration(item.durationMs) : "", item.outputTokens ? `${formatTokens(item.outputTokens)} tokens` : ""].filter(Boolean);
  return <div className="turn"><i aria-hidden="true" />{parts.join(" · ")}</div>;
}

/** 只读的对话（后台子代理的记录）：没有审批、重试这些操作。 */
export function TranscriptView({ items, cwd }: { items: Item[]; cwd?: string }) {
  return (
    <>
      {items.map((item) => {
        switch (item.kind) {
          case "user":
            return <div key={item.id} className="user"><div>{item.text}</div></div>;
          case "text":
            return <Markdown key={item.id} text={item.text} />;
          case "thinking":
            return <Step key={item.id} icon="think" label="思考过程"><div className="body">{item.text}</div></Step>;
          case "tool":
            return <Tool key={item.id} tool={item} cwd={cwd} />;
          case "interrupted":
            return <div key={item.id} className="stopped">已中断</div>;
          case "notice":
            return <div key={item.id} className="stopped local-note">{item.text}</div>;
          case "error":
            return <ErrorBox key={item.id} title="出错了" text={item.text} />;
          default:
            return null;
        }
      })}
    </>
  );
}

/** 左边缘按轮次导航：每条用户消息一道短横线，当前轮加粗，点击跳过去。 */
function TurnNav({ turns, current, onJump }: { turns: { id: string; text: string }[]; current: number; onJump: (id: string) => void }) {
  const ref = useRef<HTMLElement>(null);
  // 轮次多时导航自己会滚动，让当前轮保持可见。不用 scrollIntoView，它会连带滚动外层容器。
  useEffect(() => {
    const nav = ref.current;
    const el = nav?.children[current] as HTMLElement | undefined;
    if (!nav || !el) return;
    if (el.offsetTop < nav.scrollTop) nav.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > nav.scrollTop + nav.clientHeight) nav.scrollTop = el.offsetTop + el.offsetHeight - nav.clientHeight;
  }, [current, turns.length]);
  if (turns.length < 2 || isTouch) return null;
  return (
    <nav className="turn-nav" aria-label="按轮次跳转" ref={ref}>
      {turns.map((turn, i) => {
        const first = turn.text.split("\n")[0];
        return (
          <button
            key={turn.id}
            type="button"
            className={i === current ? "on" : undefined}
            title={first.length > 80 ? `${first.slice(0, 80)}…` : first}
            aria-current={i === current ? "true" : undefined}
            onClick={() => onJump(turn.id)}
          />
        );
      })}
    </nav>
  );
}

/** 打开会话时画最后这么多轮，往上翻到顶每次再补这么多。 */
const VISIBLE_TURNS = 20;

export function ThreadView({ store, session }: { store: Store; session: Session }) {
  const ref = useRef<HTMLElement>(null);
  const column = useRef<HTMLDivElement>(null);
  // 每个会话一个实例（App 里按会话 ID 设 key），回到会话时从底部开始。
  const pinned = useRef(true);
  const lastTop = useRef(0);
  // 最近一次用户滚动操作的时间，和是否正按住滚动条。只有用户在滚时，往上才算离开底部。
  const intent = useRef(0);
  const dragging = useRef(false);
  const markIntent = () => { intent.current = performance.now(); };
  const frame = useRef(0);
  // 渲染和尺寸变化都只登记一次 rAF，在帧内统一先读后写，避免布局抖动。
  const toBottom = useRef(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const element = ref.current;
      if (element && pinned.current) element.scrollTop = element.scrollHeight;
    });
  }).current;
  const syncAnchor = () => {
    if (ref.current) ref.current.style.overflowAnchor = pinned.current ? "none" : "";
  };
  // 自己刚发出的消息（新出现的“发送中”）总是回到底部，不管之前翻到了哪里。
  const sent = useRef<string | undefined>(undefined);
  let lastSending: string | undefined;
  for (const item of session.thread.items) if (item.kind === "user" && item.state === "sending") lastSending = item.id;
  // 用户往上翻时不打扰，在底部时跟随新内容。
  // 贴底时关掉滚动锚定：满 20 轮后每来一轮会裁掉最上面一轮，锚定会把 scrollTop 减掉那一轮的高度，
  // 下一帧 onScroll 先于 rAF 运行，看到 scrollTop 变小就误判成往上翻、取消贴底。离开底部后再打开，
  // 阅读时补内容、裁内容不跳。要在布局效果里设，赶在输入框读 scrollHeight 强制排版之前。
  useLayoutEffect(() => {
    if (lastSending && lastSending !== sent.current) pinned.current = true;
    sent.current = lastSending ?? sent.current;
    syncAnchor();
    toBottom();
  });
  // 长消息用了 content-visibility，渲染后高度才准，高度变了要再贴一次底；
  // 输入框变高、排队消息出现时消息区变矮，也要再贴一次。
  useEffect(() => {
    if (!column.current || !ref.current) return;
    const observer = new ResizeObserver(toBottom);
    observer.observe(column.current);
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, [toBottom]);
  const thread = session.thread;
  const turns = thread.items.flatMap((item) => (item.kind === "user" ? [{ id: item.id, text: item.text }] : []));
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const [current, setCurrent] = useState(-1);
  const navFrame = useRef(0);
  // 当前轮：顶部 30% 以内最后一条用户消息；贴底时是最后一轮。
  const syncCurrent = () => {
    if (navFrame.current) return;
    navFrame.current = requestAnimationFrame(() => {
      navFrame.current = 0;
      const el = ref.current;
      if (!el || !column.current) return;
      const marks = column.current.querySelectorAll<HTMLElement>(".user[data-turn]");
      const line = el.getBoundingClientRect().top + el.clientHeight * 0.3;
      let index = pinned.current ? marks.length - 1 : 0;
      if (!pinned.current) marks.forEach((mark, i) => { if (mark.getBoundingClientRect().top <= line) index = i; });
      // 前面可能有没画出来的轮次，按 ID 换算成在全部轮次里的位置。
      const id = marks[index]?.dataset.turn;
      setCurrent(id ? turnsRef.current.findIndex((t) => t.id === id) : -1);
    });
  };
  useEffect(syncCurrent, [turns.length]);
  useEffect(() => () => cancelAnimationFrame(navFrame.current), []);
  // 长会话只画最后几轮，往上翻到顶再补更早的，打开会话时不用一次画完。
  const [shown, setShown] = useState(VISIBLE_TURNS);
  const hidden = Math.max(0, turns.length - shown);
  const cut = hidden ? thread.items.findIndex((item) => item.kind === "user" && item.id === turns[hidden].id) : 0;
  const items = cut > 0 ? thread.items.slice(cut) : thread.items;
  // 补上更早的内容后保持当前看到的位置不跳。
  const anchor = useRef<number | null>(null);
  const showMore = () => {
    if (!hidden || anchor.current != null) return;
    anchor.current = ref.current ? ref.current.scrollHeight - ref.current.scrollTop : null;
    setShown((n) => n + VISIBLE_TURNS);
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (anchor.current == null || !el) return;
    el.scrollTop = el.scrollHeight - anchor.current;
    lastTop.current = el.scrollTop;
    anchor.current = null;
  }, [shown]);
  const jump = (id: string) => {
    const mark = column.current?.querySelector<HTMLElement>(`.user[data-turn="${CSS.escape(id)}"]`);
    const el = ref.current;
    if (!mark && el && turns.some((t) => t.id === id)) {
      // 跳到还没画出来的轮次：先全部画出来，下一帧再跳。
      setShown(turns.length);
      requestAnimationFrame(() => requestAnimationFrame(() => jump(id)));
      return;
    }
    if (!mark || !el) return;
    pinned.current = false;
    el.scrollTo({ top: el.scrollTop + mark.getBoundingClientRect().top - el.getBoundingClientRect().top - 16, behavior: "smooth" });
  };
  // 详细档：工具逐条显示，不合并。
  const blocks: RenderBlock[] = store.verbose ? items.map((item) => ({ kind: "item", item })) : groupTools(items);
  const activeIn = (tools: ToolItem[]) => (thread.phase === "tool" && thread.activeTool ? tools.find((t) => t.id === thread.activeTool) : undefined);
  return (
    <div className="stream-wrap">
      <TurnNav turns={turns} current={current < 0 ? turns.length - 1 : current} onJump={jump} />
      <section
        className="stream"
        aria-label="消息流"
        ref={ref}
        onWheel={markIntent}
        onTouchStart={markIntent}
        onTouchMove={markIntent}
        onKeyDown={markIntent}
        onPointerDown={(event) => {
          markIntent();
          // 拖滚动条时不再有指针事件传进来，按住期间都算用户在滚。
          if (event.target !== event.currentTarget) return;
          dragging.current = true;
          addEventListener("pointerup", () => { dragging.current = false; }, { once: true });
        }}
        onScroll={(event) => {
          const el = event.currentTarget;
          // 只有真的往上滚才算离开底部。内容变高也会让“离底距离”变大，不能据此判断。
          // 排版也会让 scrollTop 变小（滚动锚定、裁掉最上面一轮、新消息先按 40px 占位时区域临时变矮被压回），
          // 所以还要求刚有用户操作。
          const byUser = dragging.current || performance.now() - intent.current < 300;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) pinned.current = true;
          else if (byUser && el.scrollTop < lastTop.current - 1) pinned.current = false;
          lastTop.current = el.scrollTop;
          syncAnchor();
          if (el.scrollTop < 300 && !pinned.current) showMore();
          syncCurrent();
        }}
      >
        <div className="column" ref={column}>
          {hidden ? <button type="button" className="show-earlier" onClick={showMore}>显示更早的 {hidden} 轮</button> : null}
          {blocks.map((block) => block.kind === "tools" ? (
            <ToolGroup key={block.id} tools={block.tools} cwd={session.cwd} active={activeIn(block.tools)} />
          ) : (
            <ItemView
              key={block.item.id}
              item={block.item}
              store={store}
              session={session}
              askSent={block.item.kind === "ask" ? session.thread.asks.get(block.item.requestId)?.sent : undefined}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
