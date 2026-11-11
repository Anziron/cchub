// 侧栏、标题栏、输入区、窗格共用的小组件和格式化函数。
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMenuFit } from "./Dialogs";
import { Icon } from "./Icon";
import { firstAsk, isSending, isWaiting, runningTasks, type Ask } from "./model";
import { pageVisible } from "./platform";
import { formatAgo } from "./sidebar";
import type { Session, Store } from "./store";
import { describeTool } from "./Thread";

export function askHint(ask?: Ask): string {
  if (ask?.kind === "plan") return "方案等你确认";
  if (ask?.kind === "question") return "有个问题要问你";
  return ask?.toolName === "Bash" ? "要运行一条命令" : "要你批准一个操作";
}

export type RowState = "wait" | "busy" | "open" | "";

/** 等你决定 > 正在运行（转圈）> 没结束但空闲（绿点）> 已结束（空心圈）。 */
export function rowState(session: Session): RowState {
  if (isWaiting(session.thread)) return "wait";
  if (!session.running) return "";
  return session.thread.phase !== "idle" || isSending(session.thread) ? "busy" : "open";
}

export const STATE_ORDER: RowState[] = ["wait", "busy", "open", ""];

export function StateIcon({ state }: { state: RowState }) {
  return <span className={`state${state ? ` ${state}` : " done"}`} aria-hidden="true" />;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** 只含用时文本的小组件：每秒刷新只重渲染它自己，窗口看不见时不刷新（失去焦点照常刷新）。 */
export function Elapsed({ since }: { since: number }) {
  const [, setNow] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => { if (pageVisible()) setNow(Date.now()); }, 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{formatDuration(Date.now() - since)}</>;
}

/** 相对时间文本（“N 分钟”），自己每 30 秒刷新一次。 */
export function Ago({ time }: { time: number }) {
  const [, setNow] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => { if (pageVisible()) setNow(Date.now()); }, 30000);
    return () => clearInterval(timer);
  }, []);
  return <>{formatAgo(time, Math.floor(Date.now() / 1000))}</>;
}

/** 这个会话现在在做什么：状态行、侧栏悬停提示、标题栏共用。 */
export function sessionStatus(session: Session): string {
  const thread = session.thread;
  const ask = firstAsk(thread);
  if (!ask && isSending(thread)) return session.deviceOnline ? (thread.claudeSessionId ? "正在发送" : "正在启动会话") : "设备离线，恢复后发送";
  if (ask) return ask.kind === "plan" ? "等待你确认方案" : ask.kind === "question" ? "等待你回答" : "等待你批准";
  if (thread.phase === "thinking") return "思考中";
  if (thread.phase === "replying") return "正在回复";
  if (thread.phase === "tool") {
    const tool = thread.items.find((item) => item.kind === "tool" && item.id === thread.activeTool);
    if (tool?.kind !== "tool") return "正在执行";
    const { verb, target } = describeTool(tool, session.cwd);
    return `正在${verb} ${target}`;
  }
  const background = runningTasks(thread).length;
  if (background) return `后台还有 ${background} 个任务`;
  return session.running ? "空闲" : "";
}

/** 0～1 的进度条，≥ 80% 变成强调色。 */
export function Meter({ value }: { value: number | null }) {
  const percent = value == null ? 0 : Math.max(0, Math.min(100, Math.round(value * 100)));
  return <span className="meter"><i className={percent >= 80 ? "high" : ""} style={{ width: `${percent}%` }} /></span>;
}

type QuotaWindow = { utilization: number; resetsAt: number };

export function quotaPercent(window?: QuotaWindow): number | null {
  // 窗口已过期的旧数据不显示。
  return window && window.resetsAt * 1000 > Date.now() ? window.utilization : null;
}

/** 简短的重置时间：“2 小时后重置”；窗口已过期时是“已重置”。 */
export function resetWhen(window?: QuotaWindow): string | undefined {
  if (!window) return undefined;
  const minutes = Math.round((window.resetsAt * 1000 - Date.now()) / 60000);
  if (minutes <= 0) return "已重置";
  const when = minutes < 60 ? `${minutes} 分钟后` : minutes < 2880 ? `${Math.round(minutes / 60)} 小时后` : `${Math.round(minutes / 1440)} 天后`;
  return `${when}重置`;
}

export function resetText(window?: QuotaWindow): string {
  if (!window) return "还没有数据，下一轮回复后更新";
  return `${resetWhen(window)}（${new Date(window.resetsAt * 1000).toLocaleString()}）`;
}

export function Quota({ label, window }: { label: string; window?: QuotaWindow }) {
  const value = quotaPercent(window);
  return (
    <div className="stat-row" title={resetText(window)}>
      <span>{label}</span>
      <Meter value={value} />
      <span className="num">{value != null ? `${Math.round(value * 100)}%` : "—"}</span>
    </div>
  );
}

/**
 * 按钮加弹出菜单：点外面或 Esc 关闭，放上方还是下方由 useMenuFit 按剩余空间决定。
 * `children` 拿到 close，选中菜单项后自己关。
 */
export function Dropdown({ button, label, className, menuClass, align = "right", fixed = false, children }: {
  button: ReactNode;
  label: string;
  className?: string;
  menuClass?: string;
  align?: "left" | "right";
  /** 菜单按窗口定位，不被滚动列表裁剪（侧栏会话行用）；列表一滚动就关上，免得菜单和按钮错开。 */
  fixed?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const fit = useMenuFit(ref, open, [], fixed, align, menuRef);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    // 只有包含按钮的列表滚动时才关；消息流自动贴底之类别处的滚动不管。
    const onScroll = (event: Event) => {
      const target = event.target;
      if (ref.current && target instanceof Node && target.contains(ref.current)) setOpen(false);
    };
    addEventListener("mousedown", onDown);
    if (fixed) addEventListener("scroll", onScroll, true);
    return () => {
      removeEventListener("mousedown", onDown);
      removeEventListener("scroll", onScroll, true);
    };
  }, [open, fixed]);
  const close = () => setOpen(false);
  return (
    <div
      className={`dd${className ? ` ${className}` : ""}${open ? " open" : ""}`}
      ref={ref}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <button type="button" className="dd-btn" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={(event) => { event.stopPropagation(); setOpen(!open); }}>
        {button}
      </button>
      {open ? (() => {
        const menu = (
          <div ref={menuRef} className={`menu${align === "left" ? " left" : ""}${menuClass ? ` ${menuClass}` : ""}`} role="menu" style={fit}>
            {children(close)}
          </div>
        );
        // 按窗口定位的菜单放到 body 下：侧栏列表的 mask-image 会连 fixed 的子元素一起裁掉。
        // React 事件照常沿组件树冒泡，Esc 仍由外层处理。
        return fixed ? createPortal(menu, document.body) : menu;
      })() : null}
    </div>
  );
}

export function MenuItem({ icon, label, hint, checked, danger, disabled, onClick }: {
  icon?: string;
  label: ReactNode;
  hint?: ReactNode;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" role={checked == null ? "menuitem" : "menuitemradio"} aria-checked={checked} className={`mi${danger ? " danger" : ""}`} disabled={disabled} onClick={onClick}>
      {icon ? <Icon name={icon} size={14} className="mi-icon" /> : null}
      <span className="mi-label">{label}</span>
      {hint != null ? <small className="mi-hint">{hint}</small> : null}
      {checked ? <Icon name="check" size={14} className="mi-check" /> : null}
    </button>
  );
}

/** 在终端里接着这个会话的命令。 */
export function resumeCommand(session: Session): string | null {
  const id = session.thread.claudeSessionId;
  if (!id) return null;
  return session.cwd ? `cd ${JSON.stringify(session.cwd)} && claude --resume ${id}` : `claude --resume ${id}`;
}

/** 会话的操作：侧栏 ⋮ 菜单和标题栏下拉共用。 */
export function SessionMenu({ store, session, close }: { store: Store; session: Session; close: () => void }) {
  const command = resumeCommand(session);
  return (
    <>
      <MenuItem icon="info" label="会话信息" onClick={() => { close(); store.select(session.id); store.openPane("info"); }} />
      <MenuItem icon="copy" label="复制终端恢复命令" hint={command ? undefined : "还没有会话 ID"} disabled={!command} onClick={() => { close(); if (command) void navigator.clipboard?.writeText(command); }} />
      <div className="menu-sep" />
      {session.running ? <MenuItem icon="stop" label="结束会话" hint="之后发消息可接着聊" onClick={() => { close(); store.askStop(session); }} /> : null}
      <MenuItem icon="close" label="关闭会话" hint="/resume 找回" danger onClick={() => { close(); store.askArchive(session); }} />
    </>
  );
}
