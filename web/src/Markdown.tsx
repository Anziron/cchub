import { marked, type Token, type Tokens } from "marked";
import { memo, type ReactNode } from "react";

// 渲染成 React 元素而不是 HTML 字符串，模型输出里的标签只会显示成文字。

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
      case "link":
        return <span key={i} className="link" title={(token as Tokens.Link).href}>{inline((token as Tokens.Link).tokens)}</span>;
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
  return (
    <div className="codeblock">
      <header>
        <span>{token.lang || "text"}</span>
        <span role="button" onClick={() => void navigator.clipboard.writeText(token.text)}>复制</span>
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

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="reply">{marked.lexer(text).map(block)}</div>;
});
