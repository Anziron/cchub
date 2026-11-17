import { useEffect, useState } from "react";
import { AppMark } from "./Composer";
import { watchMaximized, windowOps } from "./platform";

/**
 * 无边框窗口的标题栏：横跨整个窗口的单独一行，左边应用图标和名称，右边窗口按钮。
 * 整行可拖动、双击最大化；图标和名称不接收鼠标，点到它们也算点到标题栏本身（拖动区只认带属性的元素）。
 */
export function TitleBar() {
  return (
    <header className="titlebar" data-tauri-drag-region>
      <AppMark />
      <span className="titlebar-name">CcHub</span>
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
