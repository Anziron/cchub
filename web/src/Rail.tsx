import { useState, type ComponentType } from "react";
import { AppearancePanel } from "./Dialogs";
import { Dropdown, MenuItem } from "./Common";
import { Icon } from "./Icon";
import type { Appearance } from "./appearance";
import type { Store } from "./store";

/**
 * 图标栏上的一个视图。`side` 是会话栏上半部分的内容，`main` 是主区域的内容（没有就用默认的会话页）。
 * 以后加插件、定时任务：在 App.tsx 的 `VIEWS` 里各加一项即可。
 */
export interface ViewDef {
  id: string;
  label: string;
  icon: string;
  side: ComponentType<{ store: Store }>;
  main?: ComponentType<{ store: Store }>;
}

/** 窗口底色上的窄图标栏：上面是视图图标，底部是齿轮（外观、连接服务器）。 */
export function Rail({ store, views, floating, look, onLook }: {
  store: Store;
  views: ViewDef[];
  floating: boolean;
  look: Appearance;
  onLook: (patch: Partial<Appearance>) => void;
}) {
  const [lookOpen, setLookOpen] = useState(false);
  return (
    <nav className="rail" aria-label="视图" data-tauri-drag-region>
      <div className="rail-top">
        {views.map((v) => {
          const on = store.view === v.id;
          const shown = floating ? store.sideFloatOpen : !store.sideCollapsed;
          return (
            <button
              key={v.id}
              type="button"
              className={`rail-btn${on ? " on" : ""}`}
              aria-label={v.label}
              aria-pressed={on && shown}
              title={on ? `${v.label}（${shown ? "收起" : "展开"}会话栏，Ctrl+B）` : v.label}
              onClick={() => store.clickView(v.id, floating)}
            >
              <Icon name={v.icon} size={18} />
            </button>
          );
        })}
      </div>
      <div className="rail-bottom">
        <Dropdown className="rail-gear" label="设置" align="left" fixed button={<Icon name="cog" size={18} />}>
          {(close) => (
            <>
              <MenuItem icon="palette" label="外观" onClick={() => { close(); setLookOpen(true); }} />
              <MenuItem icon="server" label="连接服务器" onClick={() => { close(); store.toggleSettings(); }} />
            </>
          )}
        </Dropdown>
      </div>
      {lookOpen ? (
        <div className="rail-look">
          <AppearancePanel look={look} onChange={onLook} onClose={() => setLookOpen(false)} />
        </div>
      ) : null}
    </nav>
  );
}
