import { useRef, type KeyboardEvent, type PointerEvent } from "react";

/** 可拖的宽度：CSS 变量名、存储键、默认值和范围。 */
export interface Sizing {
  cssVar: string;
  storageKey: string;
  def: number;
  min: number;
  /** 最大值按当前窗口算，传入被拖元素。 */
  max: (el: HTMLElement) => number;
}

export const SIDE_SIZING: Sizing = { cssVar: "--side-w", storageKey: "cchub.sideWidth", def: 264, min: 200, max: () => 420 };
/** 窗格：300px 到 min(720px, 60%)。 */
export const PANE_SIZING: Sizing = {
  cssVar: "--pane-w",
  storageKey: "cchub.paneWidth",
  def: 380,
  min: 300,
  max: (el) => Math.max(300, Math.min(720, (el.parentElement?.clientWidth ?? 1200) * 0.6)),
};

/** 窗口宽度变了或拖完一次，让依赖宽度的逻辑（自动收起）重新算。 */
export const LAYOUT_EVENT = "cchub-layout";

const root = () => document.documentElement;

/** 读本地保存的宽度写到 `:root` 的变量上；启动时调一次。拖动期间也只改这个变量，不经过 React。 */
export function initLayoutVars(): void {
  for (const s of [SIDE_SIZING, PANE_SIZING]) {
    const saved = Number(localStorage.getItem(s.storageKey));
    if (saved > 0) root().style.setProperty(s.cssVar, `${saved}px`);
  }
}

/** 当前设定的宽度（变量值，不是实际渲染宽度；窗格实际宽度还会被 60% 限制）。 */
export function currentWidth(s: Sizing): number {
  const value = parseFloat(root().style.getPropertyValue(s.cssVar));
  return value > 0 ? value : s.def;
}

/**
 * 竖直拖拽条。`target`：被调整宽度的元素，`prev` 是前一个兄弟（会话栏，向右拖变宽），
 * `parent` 是父元素（窗格，向左拖变宽）。拖动时只改 CSS 变量，松手才写 localStorage；
 * 双击恢复默认，聚焦后左右键每次 16px。
 */
export function Resizer({ sizing, target, label }: { sizing: Sizing; target: "prev" | "parent"; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const sign = target === "prev" ? 1 : -1;
  const element = () => (target === "prev" ? ref.current?.previousElementSibling : ref.current?.parentElement) as HTMLElement | null;
  const apply = (width: number, save: boolean) => {
    const el = element();
    if (!el) return;
    const value = Math.round(Math.min(Math.max(width, sizing.min), sizing.max(el)));
    root().style.setProperty(sizing.cssVar, `${value}px`);
    if (save) localStorage.setItem(sizing.storageKey, String(value));
  };
  const done = () => dispatchEvent(new Event(LAYOUT_EVENT));
  const onDown = (event: PointerEvent<HTMLDivElement>) => {
    const el = element();
    if (!el || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width: el.getBoundingClientRect().width };
    document.body.classList.add("resizing");
  };
  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) apply(d.width + sign * (event.clientX - d.x), false);
  };
  const onUp = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.body.classList.remove("resizing");
    apply(d.width + sign * (event.clientX - d.x), true);
    done();
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const el = element();
    if (!el) return;
    const step = (event.key === "ArrowRight" ? 1 : -1) * sign * 16;
    apply(el.getBoundingClientRect().width + step, true);
    done();
  };
  return (
    <div
      ref={ref}
      className={`resizer ${target === "prev" ? "side-resizer" : "pane-resizer"}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={`${label}（双击恢复默认）`}
      tabIndex={0}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => { drag.current = null; document.body.classList.remove("resizing"); }}
      onLostPointerCapture={() => document.body.classList.remove("resizing")}
      onDoubleClick={() => {
        localStorage.removeItem(sizing.storageKey);
        root().style.setProperty(sizing.cssVar, `${sizing.def}px`);
        done();
      }}
      onKeyDown={onKey}
    />
  );
}
