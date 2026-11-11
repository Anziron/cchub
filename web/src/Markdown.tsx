import { marked, type Token, type Tokens } from "marked";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { isWebUrl, openUrl } from "./platform";

// 渲染成 React 元素而不是 HTML 字符串，模型输出里的标签只会显示成文字。

/** 网页链接：点击用系统浏览器打开，不在应用窗口里跳转。 */
export function WebLink({ url, children }: { url: string; children?: ReactNode }) {
  return (
    <a className="link" href={url} title={url} onClick={(event) => { event.preventDefault(); openUrl(url); }}>
      {children ?? url}
    </a>
  );
}

const URL_RE = /https?:\/\/[^\s<>"'`，。；）】]+/g;

/** 纯文本里的网址变成可点的链接（工具输出等）。末尾的标点不算网址。 */
export function linkify(text: string): ReactNode {
  if (!text.includes("http")) return text;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(/[.,;:!?)\]}]+$/, "");
    const at = match.index ?? 0;
    parts.push(text.slice(last, at), <WebLink key={at} url={url} />);
    last = at + url.length;
  }
  parts.push(text.slice(last));
  return parts;
}

function inline(tokens: Token[] | undefined): ReactNode {
  return tokens?.map((token, i) => {
    switch (token.type) {
      case "strong":
        return <strong key={i}>{inline((token as Tokens.Strong).tokens)}</strong>;
      case "em":
        return <em key={i}>{inline((token as Tokens.Em).tokens)}</em>;
      case "del":
        return <del key={i}>{inline((token as Tokens.Del).tokens)}</del>;
      case "codespan":
        return <code key={i}>{(token as Tokens.Codespan).text}</code>;
      case "br":
        return <br key={i} />;
      case "link": {
        const { href, tokens: children } = token as Tokens.Link;
        return isWebUrl(href)
          ? <WebLink key={i} url={href}>{inline(children)}</WebLink>
          : <span key={i} className="link" title={href}>{inline(children)}</span>;
      }
      case "text":
        return "tokens" in token && token.tokens ? inline(token.tokens) : decode(token.text);
      case "escape":
        return decode((token as Tokens.Escape).text);
      default:
        return token.raw;
    }
  });
}

/** marked 的文本是转义过的，这里交给 React 转义，要还原。 */
function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) =>
    ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[name] ?? name,
  );
}

function CodeBlock({ token }: { token: Tokens.Code }) {
  const [copied, setCopied] = useState<"" | "已复制" | "复制失败">("");
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (text: string) => {
    const show = (state: "已复制" | "复制失败") => {
      setCopied(state);
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(""), 1500);
    };
    navigator.clipboard.writeText(text).then(() => show("已复制"), () => show("复制失败"));
  };
  return (
    <div className="codeblock">
      <header>
        <span>{token.lang || "text"}</span>
        <span role="button" className={copied ? "copied" : undefined} aria-live="polite" onClick={() => copy(token.text)}>{copied || "复制"}</span>
      </header>
      <pre>{token.text}</pre>
    </div>
  );
}

function block(token: Token, key: number): ReactNode {
  switch (token.type) {
    case "paragraph":
      return <p key={key}>{inline((token as Tokens.Paragraph).tokens)}</p>;
    case "heading": {
      const heading = token as Tokens.Heading;
      const Tag = `h${Math.min(heading.depth + 2, 6)}` as "h3";
      return <Tag key={key}>{inline(heading.tokens)}</Tag>;
    }
    case "code":
      return <CodeBlock key={key} token={token as Tokens.Code} />;
    case "list": {
      const list = token as Tokens.List;
      const Tag = list.ordered ? "ol" : "ul";
      return (
        <Tag key={key}>
          {list.items.map((item, i) => (
            <li key={i}>{item.tokens.map((t, j) => (t.type === "text" ? <span key={j}>{inline((t as Tokens.Text).tokens) ?? t.raw}</span> : block(t, j)))}</li>
          ))}
        </Tag>
      );
    }
    case "blockquote":
      return <blockquote key={key}>{(token as Tokens.Blockquote).tokens.map(block)}</blockquote>;
    case "table": {
      const table = token as Tokens.Table;
      return (
        <table key={key}>
          <thead><tr>{table.header.map((cell, i) => <th key={i}>{inline(cell.tokens)}</th>)}</tr></thead>
          <tbody>{table.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{inline(cell.tokens)}</td>)}</tr>)}</tbody>
        </table>
      );
    }
    case "hr":
      return <hr key={key} />;
    case "space":
      return null;
    case "html":
      return <p key={key}>{token.raw}</p>;
    case "text":
      return <p key={key}>{"tokens" in token ? inline(token.tokens) : token.raw}</p>;
    default:
      return <p key={key}>{token.raw}</p>;
  }
}

const LIVE_PARSE_MS = 80;

/** 正在输出时限频：值最多每 `ms` 毫秒更新一次；关闭后立即返回最新值。 */
function useThrottled(value: string, ms: number, enabled: boolean): string {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => {
      last.current = Date.now();
      setShown(value);
    }, Math.max(0, last.current + ms - Date.now()));
    return () => clearTimeout(timer);
  }, [value, ms, enabled]);
  return enabled ? shown : value;
}

export const Markdown = memo(function Markdown({ text, live = false }: { text: string; live?: boolean }) {
  // 流式消息每个片段都重新解析整段很费 CPU，限到 80ms 一次；完整文本立即渲染。
  const shown = useThrottled(text, LIVE_PARSE_MS, live);
  return <div className="reply">{marked.lexer(shown).map(block)}</div>;
});
