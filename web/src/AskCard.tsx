import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import type { Ask, Question } from "./model";
import type { Session, Store } from "./store";
import { describeTool } from "./Thread";

interface Props {
  ask: Ask;
  session: Session;
  store: Store;
}

function Head({ text }: { text: string }) {
  return <div className="ask-head"><span className="dot wait" />{text}</div>;
}

function inTextField(): boolean {
  const tag = document.activeElement?.tagName;
  return tag === "TEXTAREA" || tag === "INPUT";
}

function Approval({ ask, session, store }: Props) {
  const allow = () => store.allow(session, ask);
  const deny = () => store.deny(session, ask, "用户拒绝了这次操作");
  // 只有焦点不在输入框时才响应，打字时按回车不会误批准。
  useEffect(() => {
    if (ask.sent) return;
    const onKey = (event: KeyboardEvent) => {
      if (inTextField()) return;
      if (event.key === "Enter") allow();
      else if (event.key === "Escape") deny();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });
  const { verb, target } = describeTool({ name: ask.toolName, input: ask.input }, session.cwd);
  const command = ask.toolName === "Bash" ? String(ask.input.command ?? "") : target;
  return (
    <article className="ask">
      <Head text="需要你批准" />
      <h3>{ask.toolName === "Bash" ? "运行这条命令？" : `允许${verb}？`}</h3>
      {ask.description ? <p>{ask.description}</p> : null}
      <div className="cmd">{command || JSON.stringify(ask.input, null, 2)}</div>
      <div className="actions">
        <button className="btn solid" disabled={ask.sent} onClick={allow}>允许<kbd>↵</kbd></button>
        {ask.suggestions?.length ? (
          <button className="btn ghost" disabled={ask.sent} onClick={() => store.allow(session, ask, true)}>总是允许</button>
        ) : null}
        <button className="btn quiet" disabled={ask.sent} onClick={deny}>拒绝<kbd>Esc</kbd></button>
      </div>
    </article>
  );
}

function QuestionBlock({ question, value, onChange, disabled }: { question: Question; value: string[]; onChange: (next: string[]) => void; disabled: boolean }) {
  const [other, setOther] = useState("");
  const toggle = (label: string) => {
    if (!question.multiSelect) onChange([label]);
    else onChange(value.includes(label) ? value.filter((v) => v !== label) : [...value, label]);
  };
  return (
    <div className="question">
      <h3>{question.question}</h3>
      {question.options.map((option, i) => (
        <button key={option.label} className={`choice${value.includes(option.label) ? " on" : ""}`} disabled={disabled} onClick={() => toggle(option.label)}>
          <em>{i + 1}</em>
          <span><b>{option.label}</b>{option.description ? <small>{option.description}</small> : null}</span>
        </button>
      ))}
      <input
        className="other"
        placeholder="其他答案"
        disabled={disabled}
        value={other}
        onChange={(event) => {
          setOther(event.target.value);
          onChange(event.target.value ? [event.target.value] : []);
        }}
      />
    </div>
  );
}

function Questions({ ask, session, store }: Props) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const ready = ask.questions.length > 0 && ask.questions.every((q) => answers[q.question]?.length);
  const submit = () => {
    const joined = Object.fromEntries(Object.entries(answers).map(([q, v]) => [q, v.join(", ")]));
    store.answer(session, ask, joined);
  };
  return (
    <article className="ask">
      <Head text="它有个问题" />
      {ask.questions.map((question) => (
        <QuestionBlock
          key={question.question}
          question={question}
          value={answers[question.question] ?? []}
          disabled={ask.sent}
          onChange={(next) => setAnswers((all) => ({ ...all, [question.question]: next }))}
        />
      ))}
      <div className="actions">
        <button className="btn solid" disabled={!ready || ask.sent} onClick={submit}>回答</button>
        <button className="btn quiet" disabled={ask.sent} onClick={() => store.deny(session, ask, "用户没有回答这个问题")}>跳过</button>
      </div>
    </article>
  );
}

function Plan({ ask, session, store }: Props) {
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");
  return (
    <article className="ask">
      <Head text="方案等你确认" />
      {/* 第一次请求可能没有方案内容。 */}
      {ask.plan ? <div className="plan"><Markdown text={ask.plan} /></div> : <h3>它准备开始执行</h3>}
      {revising ? (
        <textarea className="other" rows={3} autoFocus placeholder="哪里要改？" value={feedback} onChange={(event) => setFeedback(event.target.value)} />
      ) : null}
      <div className="actions">
        {revising ? (
          <>
            <button className="btn solid" disabled={!feedback.trim() || ask.sent} onClick={() => store.deny(session, ask, feedback)}>发送修改意见</button>
            <button className="btn quiet" onClick={() => setRevising(false)}>取消</button>
          </>
        ) : (
          <>
            <button className="btn solid" disabled={ask.sent} onClick={() => store.allow(session, ask)}>批准并开始</button>
            <button className="btn ghost" disabled={ask.sent} onClick={() => setRevising(true)}>要求修改</button>
          </>
        )}
      </div>
    </article>
  );
}

export function AskCard(props: Props) {
  const { ask } = props;
  return (
    <>
      {ask.kind === "plan" ? <Plan {...props} /> : ask.kind === "question" ? <Questions {...props} /> : <Approval {...props} />}
      {ask.sent ? <div className="sent"><Icon name="up" size={12} />已发送，等它继续</div> : null}
    </>
  );
}
