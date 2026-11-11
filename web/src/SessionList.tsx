import { useState } from "react";
import { AppearanceMenu } from "./Dialogs";
import type { Appearance } from "./appearance";
import { askHint, Dropdown, MenuItem, Meter, quotaPercent, resetText, resetWhen, rowState, sessionStatus, SessionMenu, STATE_ORDER, StateIcon } from "./Common";
import { Icon } from "./Icon";
import { firstAsk, isWaiting } from "./model";
import { deviceStatus, groupByDate, groupProjects, SERVER_GROUP, type DeviceState } from "./sidebar";
import { describeCwd, type Session, type Store } from "./store";

type StatusFilter = "all" | "wait" | "running";
type GroupBy = "project" | "date";

const VISIBLE_SESSIONS = 5;
const COLLAPSED_KEY = "cchub.collapsedProjects";
const FILTER_KEY = "cchub.sideFilter";
const GROUP_KEY = "cchub.sideGroup";

function useStored<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const raw = localStorage.getItem(key) as T | null;
    return raw && allowed.includes(raw) ? raw : fallback;
  });
  return [value, (next: T) => { setValue(next); localStorage.setItem(key, next); }];
}

/** 会话行只有一行：状态和标题。等你决定的会话多一行提示，这是不能漏看的。 */
function SessionRow({ store, session, project }: { store: Store; session: Session; project?: string }) {
  const waiting = isWaiting(session.thread);
  const current = store.selected === session.id;
  const status = sessionStatus(session);
  return (
    <div className={`row-wrap${current ? " current" : ""}`}>
      <button className={`row session${current ? " current" : ""}`} title={status ? `${session.title}\n${status}` : session.title} onClick={() => store.select(session.id)}>
        <StateIcon state={rowState(session)} />
        <span className="name">
          <span className="title">{session.title}{project ? <em>{project}</em> : null}</span>
          {waiting ? <small>{askHint(firstAsk(session.thread))}</small> : null}
        </span>
      </button>
      <Dropdown className="row-more" label={`${session.title} 的操作`} button={<Icon name="more" size={14} />}>
        {(close) => <SessionMenu store={store} session={session} close={close} />}
      </Dropdown>
    </div>
  );
}

function Group({ store, id, label, sub, sessions, collapsed, toggle, withProject }: {
  store: Store;
  id: string;
  label: string;
  sub?: string;
  sessions: Session[];
  collapsed: boolean;
  toggle: () => void;
  withProject?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  // 收起时整组藏起来，组标题右侧显示组里最要紧的状态，等你决定的不会被漏掉。
  const shown = collapsed ? [] : sessions.filter((s, i) => showAll || i < VISIBLE_SESSIONS || s.id === store.selected || isWaiting(s.thread));
  const hidden = collapsed ? 0 : sessions.length - shown.length;
  const state = collapsed ? STATE_ORDER.find((value) => value && sessions.some((s) => rowState(s) === value)) : undefined;
  return (
    <div className={`group${collapsed ? " closed" : ""}`}>
      <button className="group-head" title={id || undefined} aria-expanded={!collapsed} onClick={toggle}>
        <span className="name">{label}{sub ? <em>{sub}</em> : null}</span>
        {state ? <StateIcon state={state} /> : null}
        <Icon name="chev" size={10} className="fold" />
      </button>
      {shown.map((s) => <SessionRow key={s.id} store={store} session={s} project={withProject ? describeCwd(s.cwd).project || SERVER_GROUP : undefined} />)}
      {hidden > 0 ? <button className="row more" onClick={() => setShowAll(true)}>显示更多（{hidden}）</button> : null}
      {showAll && !collapsed && sessions.length > VISIBLE_SESSIONS ? <button className="row more" onClick={() => setShowAll(false)}>收起</button> : null}
    </div>
  );
}

type QuotaWindow = Store["limits"]["fiveHour"];

function QuotaLine({ label, window }: { label: string; window: QuotaWindow }) {
  if (!window) return null;
  const value = quotaPercent(window);
  return (
    <div className="quota-line" title={resetText(window)}>
      <span>{label}</span>
      <Meter value={value} />
      <b>{value != null ? `${Math.round(value * 100)}%` : "—"}</b>
      <small>{resetWhen(window)}</small>
    </div>
  );
}

const DEVICE_TITLE: Record<DeviceState, string> = {
  online: "在线",
  offline: "离线：这台设备上的会话读写文件会失败",
  unknown: "没有运行中的会话，未检测",
};

/** 侧栏底部：额度（含重置时间）和各设备在线情况。 */
function Status({ store }: { store: Store }) {
  const { fiveHour, sevenDay } = store.limits;
  const devices = deviceStatus([...store.sessions.values()].filter((s) => !s.archived));
  if (!fiveHour && !sevenDay && !devices.length) return null;
  return (
    <div className="side-status">
      <QuotaLine label="5 小时" window={fiveHour} />
      <QuotaLine label="本周" window={sevenDay} />
      {devices.length ? (
        <div className="devices">
          {devices.map((d) => <span key={d.device} className={`dev ${d.state}`} title={`${d.device}：${DEVICE_TITLE[d.state]}`}><i />{d.device}</span>)}
        </div>
      ) : null}
    </div>
  );
}

function Footer({ store, look, onLook }: { store: Store; look: Appearance; onLook: (patch: Partial<Appearance>) => void }) {
  const conn = store.connection;
  const connClass = !store.url ? "bad" : conn === "connected" ? "ok" : conn === "disconnected" ? "bad" : "pending";
  const connText = !store.url ? "未连接服务器" : conn === "connected" ? "已连接" : conn === "disconnected" ? "已断开" : "重连中";
  return (
    <>
    <Status store={store} />
    <div className="side-foot">
      <button className={`conn ${connClass}`} title="连接服务器" onClick={() => store.toggleSettings()}>
        <i />
        <span>{connText}</span>
        {conn === "connected" && store.memAvailableMb != null ? <small title="服务器可用内存">可用 {store.memAvailableMb} MB</small> : null}
      </button>
      <AppearanceMenu look={look} onChange={onLook} />
      <button className="icon" aria-label="连接服务器" title="连接服务器" onClick={() => store.toggleSettings()}><Icon name="server" /></button>
    </div>
    </>
  );
}

export function Sidebar({ store, look, onLook }: { store: Store; look: Appearance; onLook: (patch: Partial<Appearance>) => void }) {
  const [filter, setFilter] = useStored<StatusFilter>(FILTER_KEY, "all", ["all", "wait", "running"]);
  const [groupBy, setGroupBy] = useStored<GroupBy>(GROUP_KEY, "project", ["project", "date"]);
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    } catch {
      return [];
    }
  });
  const toggle = (key: string) => {
    const next = collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key];
    setCollapsed(next);
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
  };
  const all = [...store.sessions.values()].filter((s) => !s.archived);
  const sessions = all.filter((s) => filter === "all" || (filter === "wait" ? isWaiting(s.thread) : s.running));
  const groups = groupBy === "project"
    ? groupProjects(sessions).map((g) => ({ id: g.key, label: g.project, sub: g.device || undefined, sessions: g.sessions }))
    : groupByDate(sessions, Math.floor(Date.now() / 1000)).map((g) => ({ id: g.key, label: g.label, sub: undefined, sessions: g.sessions }));
  const filterLabel = filter === "wait" ? "等你决定" : filter === "running" ? "运行中" : groupBy === "project" ? "项目" : "按时间";
  return (
    <aside className="side">
      <button className="row new" onClick={() => store.select(null)}>
        <Icon name="plus" size={14} /><span className="name">新建会话</span>
      </button>
      <div className="side-head">
        <span>{filterLabel}</span>
        <Dropdown className="side-filter" label="过滤和分组" align="left" button={<Icon name="gear" size={14} />}>
          {(close) => (
            <>
              <div className="menu-title">显示</div>
              <MenuItem label="全部会话" checked={filter === "all"} onClick={() => { setFilter("all"); close(); }} />
              <MenuItem label="等你决定" hint={String(all.filter((s) => isWaiting(s.thread)).length)} checked={filter === "wait"} onClick={() => { setFilter("wait"); close(); }} />
              <MenuItem label="运行中" hint={String(all.filter((s) => s.running).length)} checked={filter === "running"} onClick={() => { setFilter("running"); close(); }} />
              <div className="menu-sep" />
              <div className="menu-title">分组</div>
              <MenuItem label="按项目" checked={groupBy === "project"} onClick={() => { setGroupBy("project"); close(); }} />
              <MenuItem label="按时间" checked={groupBy === "date"} onClick={() => { setGroupBy("date"); close(); }} />
            </>
          )}
        </Dropdown>
      </div>
      <div className="side-scroll">
        {groups.map((g) => (
          <Group
            key={g.id}
            store={store}
            id={g.id}
            label={g.label}
            sub={g.sub}
            sessions={g.sessions}
            collapsed={collapsed.includes(g.id)}
            toggle={() => toggle(g.id)}
            withProject={groupBy === "date"}
          />
        ))}
        {!groups.length && all.length ? (
          <p className="side-empty">没有{filter === "wait" ? "等你决定的" : "运行中的"}会话。<button className="link-btn" onClick={() => setFilter("all")}>显示全部</button></p>
        ) : null}
        {!all.length ? <p className="side-empty">还没有会话</p> : null}
      </div>
      <Footer store={store} look={look} onLook={onLook} />
    </aside>
  );
}
