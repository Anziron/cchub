import { useEffect, useState } from "react";
import { AppMark } from "./Composer.tsx";
import { Icon } from "./Icon.tsx";
import { isNarrow, watchMaximized, windowOps } from "./platform.ts";
import type { Store } from "./store.ts";

/**
 * 无边框窗口的标题栏：横跨整个窗口的单独一行，只放全局的东西——左边应用图标、后退 / 前进、收起侧栏，
 * 右边窗口按钮（当前会话的操作留在面板顶栏）。中间留给以后的搜索框。
 * 整行可拖动、双击最大化；图标不接收鼠标，点到它也算点到标题栏本身（拖动区只认带属性的元素）。
 */
export function TitleBar({ store, floating }: { store: Store; floating: boolean }) {
  const shown = isNarrow() ? store.showDrawer : floating ? store.sideFloatOpen : !store.sideCollapsed;
  return (
    <header className="titlebar" data-tauri-drag-region>
      <AppMark />
      <nav className="titlebar-nav" aria-label="导航">
        <button type="button" aria-label="后退" title="后退（Alt+←）" disabled={!store.canGo(-1)} onClick={() => store.go(-1)}>
          <Icon name="back" size={17} />
        </button>
        <button type="button" aria-label="前进" title="前进（Alt+→）" disabled={!store.canGo(1)} onClick={() => store.go(1)}>
          <Icon name="forward" size={17} />
        </button>
        <button type="button" aria-label={shown ? "收起侧栏" : "展开侧栏"} title={`${shown ? "收起" : "展开"}侧栏（Ctrl+B）`} aria-pressed={shown} onClick={() => store.toggleSide(floating)}>
          <Icon name="sidebar" size={17} />
        </button>
      </nav>
      <WindowControls />
    </header>
  );
}

const svg = { width: 10, height: 10, viewBox: "0 0 10 10", fill: "none", stroke: "currentColor", strokeWidth: 1, "aria-hidden": true } as const;

/** 无边框窗口自带的最小化、最大化（还原）、关闭。关闭和系统的关闭一样：窗口销毁，进程留在托盘。 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => watchMaximized(setMaximized), []);
  return (
    <div className="winctl">
      <button type="button" aria-label="最小化" title="最小化" onClick={() => void windowOps.minimize()}>
        <svg {...svg}><path d="M0 5.500h10" /></svg>
      </button>
      <button type="button" aria-label={maximized ? "还原" : "最大化"} title={maximized ? "还原" : "最大化"} onClick={() => void windowOps.toggleMaximize()}>
        {maximized ? (
          <svg {...svg}><path d="M2.500 2.500V.500h7v7h-2M.500 2.500h7v7h-7z" /></svg>
        ) : (
          <svg {...svg}><path d="M.500 .500h9v9h-9z" /></svg>
        )}
      </button>
      <button type="button" className="close" aria-label="关闭" title="关闭" onClick={() => void windowOps.close()}>
        <svg {...svg}><path d="m.500 .500 9 9M9.500 .500l-9 9" /></svg>
      </button>
    </div>
  );
}
