import { useEffect, useRef, useState, type ComponentType, type RefObject } from "react";
import { AppearancePanel } from "./Dialogs";
import { MenuItem } from "./Common";
import { Icon } from "./Icon";
import type { Appearance } from "./appearance";
import type { Store } from "./store";

/**
 * 图标栏上的一个视图。`side` 是会话栏上半部分的内容，`main` 是主区域的内容（没有就用默认的会话页）。
 * `activate`：点图标时做的事，不给就是切到这个视图（再点一次收起会话栏）。
 * 以后加插件、定时任务：在 App.tsx 的 `VIEWS` 里各加一项即可。
 */
export interface ViewDef {
  id: string;
  label: string;
  icon: string;
  side: ComponentType<{ store: Store }>;
  main?: ComponentType<{ store: Store }>;
  activate?: (store: Store) => void;
}

/** 点哪里都收起：按下就算（捕获阶段，不怕别处拦截冒泡，也赶在标题栏拖动之前）。 */
function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    addEventListener("pointerdown", onDown, true);
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("pointerdown", onDown, true);
      removeEventListener("keydown", onKey);
    };
  }, [open, ref, close]);
}

/** 窗口底色上的窄图标栏：上面是视图图标，底部是齿轮（外观、连接服务器）。 */
export function Rail({ store, views, floating, look, onLook }: {
  store: Store;
  views: ViewDef[];
  floating: boolean;
  look: Appearance;
  onLook: (patch: Partial<Appearance>) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [lookOpen, setLookOpen] = useState(false);
  const gearRef = useRef<HTMLDivElement>(null);
  useDismiss(menuOpen, gearRef, () => setMenuOpen(false));
  return (
    // 不设 data-tauri-drag-region：拖动区一按下就进系统的移动窗口模式，点图标旁的空白时指针会闪、点击被吞（只有标题栏能拖）
    <nav className="rail" aria-label="视图">
      <div className="rail-top">
        {views.map((v) => (
          <button
            key={v.id}
            type="button"
            className={`rail-btn${store.view === v.id ? " on" : ""}`}
            aria-label={v.label}
            title={v.label}
            onClick={() => (v.activate ? v.activate(store) : store.clickView(v.id, floating))}
          >
            <Icon name={v.icon} size={18} />
          </button>
        ))}
      </div>
      <div className="rail-bottom rail-gear" ref={gearRef}>
        <button type="button" className={`rail-btn${menuOpen ? " open" : ""}`} aria-label="设置" title="设置" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
          <Icon name="cog" size={18} />
        </button>
        {/* 向右弹出，贴着面板左边缘、和面板底边对齐（和外观面板同一位置） */}
        {menuOpen ? (
          <div className="menu rail-pop" role="menu">
            <MenuItem icon="palette" label="外观" onClick={() => { setMenuOpen(false); setLookOpen(true); }} />
            <MenuItem icon="server" label="连接服务器" onClick={() => { setMenuOpen(false); store.toggleSettings(); }} />
          </div>
        ) : null}
      </div>
      {lookOpen ? (
        <div className="rail-look">
          <AppearancePanel look={look} onChange={onLook} onClose={() => setLookOpen(false)} />
        </div>
      ) : null}
    </nav>
  );
}
