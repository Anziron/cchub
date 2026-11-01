import { memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AskCard } from "./AskCard";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import type { Item, ToolItem } from "./model";
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
    case "AskUserQuestion":
      return { verb: "提问", target: "", icon: "think" };
    case "ExitPlanMode":
      return { verb: "提交方案", target: "", icon: "think" };
    default:
      return { verb: tool.name, target: "", icon: "file" };
  }
}

function Diff({ oldText, newText }: { oldText: string; newText: string }) {
  const removed = oldText ? oldText.split("\n") : [];
  const added = newText ? newText.split("\n") : [];
  return (
    <div className="diff">
      {removed.map((line, i) => <div className="d" key={`d${i}`}>- {line}</div>)}
      {added.map((line, i) => <div className="a" key={`a${i}`}>+ {line}</div>)}
    </div>
  );
}

function Step({ icon, label, children }: { icon: string; label: ReactNode; children?: ReactNode }) {
  // 展开时才渲染内容，大结果不占 DOM。
  const [open, setOpen] = useState(false);
  return (
    <details className="step" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <Icon name={icon} />
        <span className="label">{label}</span>
        {children ? <Icon name="chev" size={14} className="chev" /> : null}
      </summary>
      {open ? children : null}
    </details>
  );
}

const Tool = memo(function Tool({ tool, cwd }: { tool: ToolItem; cwd?: string }) {
  const { verb, target, icon } = describeTool(tool, cwd);
  // 被拒绝或中断的调用也是 is_error，不能显示成失败。
  const notRun = /^(The user doesn't want|用户)/.test(tool.result ?? "");
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
      {tool.blocked ? " · 被拦截" : notRun ? " · 未执行" : tool.isError ? " · 失败" : ""}
    </>
  );
  const body = isEdit ? (
    <Diff oldText={String(tool.input.old_string ?? "")} newText={String(tool.input.new_string ?? "")} />
  ) : tool.result ? (
    <div className="body">
      <pre className="output">{tool.result}</pre>
      {tool.truncated ? <em>内容过长，只显示开头</em> : null}
    </div>
  ) : undefined;
  return (
    <>
      <Step icon={icon} label={label}>{body}</Step>
      {tool.blocked ? (
        <div className="blocked"><b>工具调用被命令行工具拦下</b><code>{tool.result}</code></div>
      ) : null}
    </>
  );
});

function ItemView({ item, store, session }: { item: Item; store: Store; session: Session }) {
  switch (item.kind) {
    case "user":
      return (
        <>
          <div className="user"><div>{item.text}</div></div>
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
      return <Markdown text={item.text} />;
    case "thinking":
      return item.text ? (
        <Step icon="think" label="思考过程"><div className="body">{item.text}</div></Step>
      ) : (
        <Step icon="think" label="思考过" />
      );
    case "tool":
      return <Tool tool={item} cwd={session.cwd} />;
    case "ask": {
      const ask = session.thread.asks.get(item.requestId);
      return ask ? <AskCard ask={ask} session={session} store={store} /> : null;
    }
    case "interrupted":
      return <div className="stopped">已中断</div>;
    case "error":
      return <div className="blocked"><b>这一轮出错了</b><code>{item.text}</code></div>;
  }
}

export function ThreadView({ store, session }: { store: Store; session: Session }) {
  const ref = useRef<HTMLElement>(null);
  const pinned = useRef(true);
  // 用户往上翻时不打扰，在底部时跟随新内容。
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  });
  return (
    <section
      className="stream"
      aria-label="消息流"
      ref={ref}
      onScroll={(event) => {
        const el = event.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      <div className="column">
        {session.thread.items.map((item) => (
          <ItemView key={item.id} item={item} store={store} session={session} />
        ))}
      </div>
    </section>
  );
}
