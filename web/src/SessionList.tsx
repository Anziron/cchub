import { Fragment, memo, useEffect, useState } from "react";
import { pageVisible } from "./platform.ts";
import { askHint, Dropdown, MenuItem, Meter, quotaPercent, rowState, sessionStatus, SessionMenu, STATE_ORDER, StateIcon } from "./Common.tsx";
import { Icon } from "./Icon.tsx";
import { firstAsk, isWaiting } from "./model.ts";
import { deviceColorMap, deviceColorVars } from "./deviceColors.ts";
import { DEVICE_STATE, deviceList, deviceOf, groupByDate, groupDevices, SERVER_GROUP, type DeviceEntry } from "./sidebar.ts";
import { describeCwd } from "./paths.ts";
import type { HostLoad } from "./generated/HostLoad.ts";
import { formatLoad, level, memoryPercent, percent } from "./hostload.ts";
import type { Session, Store } from "./store.ts";

type StatusFilter = "all" | "wait" | "running";
type GroupBy = "project" | "date";

const VISIBLE_SESSIONS = 5;
const COLLAPSED_KEY = "cchub.collapsedProjects";
const FILTER_KEY = "cchub.sideFilter";
const GROUP_KEY = "cchub.sideGroup";
const DEVICE_KEY = "cchub.deviceFilter";

function useStored<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const raw = localStorage.getItem(key) as T | null;
    return raw && allowed.includes(raw) ? raw : fallback;
  });
  return [value, (next: T) => { setValue(next); localStorage.setItem(key, next); }];
}

/**
 * 这一行显示的全部内容。`Session` 是原地修改的对象，不能按引用比较，
 * 用它判断要不要重画：任何事件都会让侧栏重渲染，没变的行跳过。
 */
function rowDigest(store: Store, session: Session): string {
  const waiting = isWaiting(session.thread);
  return [session.title, rowState(session), sessionStatus(session), waiting ? askHint(firstAsk(session.thread)) : "", store.selected === session.id, session.running].join("\n");
}

function SessionRow(props: { store: Store; session: Session; project?: string }) {
  return <SessionRowView {...props} digest={rowDigest(props.store, props.session)} />;
}

/** 会话行只有一行：状态和标题。等你决定的会话多一行提示，这是不能漏看的。 */
const SessionRowView = memo(function SessionRowView({ store, session, project }: { store: Store; session: Session; project?: string; digest: string }) {
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
      <Dropdown className="row-more" fixed label={`${session.title} 的操作`} button={<Icon name="more" size={14} />}>
        {(close) => <SessionMenu store={store} session={session} close={close} />}
      </Dropdown>
    </div>
  );
}, (a, b) => a.digest === b.digest && a.project === b.project && a.session === b.session && a.store === b.store);

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

/** 没有数据时也占一行、显示 “—”，几行额度始终对齐（Fable 额度要等 Fable 回复后才有）。 */
function QuotaLine({ label, window }: { label: string; window: QuotaWindow }) {
  const value = quotaPercent(window);
  return (
    <div className="quota-line">
      <span>{label}</span>
      <Meter value={value} />
      <b>{value != null ? `${Math.round(value * 100)}%` : "—"}</b>
    </div>
  );
}

const DEVICES_REFRESH_MS = 60_000;

/** 侧栏底部：额度进度（点开窗格看重置时间）。设备状态在顶部的设备切换器里。 */
function Status({ store }: { store: Store }) {
  const { fiveHour, sevenDay } = store.limits;
  const openUsage = () => store.togglePane("usage");
  // 页面看得见时每分钟刷新一次在线状态；切回窗口时补一次。
  useEffect(() => {
    const tick = () => { if (pageVisible()) store.requestDevices(); };
    const timer = setInterval(tick, DEVICES_REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [store]);
  return (
    <>
      {fiveHour || sevenDay ? (
        <div className="side-quota" role="button" tabIndex={0} title="查看使用情况和重置时间" onClick={openUsage} onKeyDown={(event) => { if (event.key === "Enter") openUsage(); }}>
          <QuotaLine label="5 小时" window={fiveHour} />
          <QuotaLine label="本周" window={sevenDay} />
          <QuotaLine label="Fable" window={store.limits.fable} />
        </div>
      ) : null}
    </>
  );
}

/**
 * “全部设备”时设备之间的分隔线：设备名在中间、左右两条线，名字和线都用这台设备的颜色（外观里可自选）；离线时名字后带红色“离线”。
 * 只是分隔，不是一层可折叠的标题（三层结构用户试过觉得别扭）。
 */
function DeviceRule({ name, color, state }: { name: string; color: number; state?: string }) {
  return (
    <div className="dev-rule" style={deviceColorVars(color)} role="separator" aria-label={name}>
      <span>{name}{state === "offline" ? <small>离线</small> : state === "warn" ? <small className="warn">目录读不到</small> : null}</span>
    </div>
  );
}

/**
 * 会话栏顶部的设备切换器（参考 SaaS 的工作区切换器）：选“全部设备”或某一台，列表只显示它的项目。
 * 菜单里是每台设备的在线状态和项目数，替代原来底部的设备列表。浏览、挂载设备目录在新建会话的“选择工作区”里。
 */
function DeviceSwitcher({ devices, current, onChange }: {
  devices: DeviceEntry[];
  current: string | null;
  onChange: (device: string | null) => void;
}) {
  const active = current ? devices.find((d) => d.name === current) : undefined;
  const bad = devices.some((d) => d.state === "offline" || d.state === "warn");
  const label = current ?? "全部设备";
  const dotClass = active ? active.state : current === SERVER_GROUP ? "online" : bad ? "warn" : "online";
  return (
    <Dropdown
      className="dev-switch"
      label="切换设备"
      align="left"
      button={<><i className={`dot ${dotClass}`} /><span>{label}</span><Icon name="down" size={11} /></>}
    >
      {(close) => (
        <>
          <MenuItem label="全部设备" checked={current === null} onClick={() => { onChange(null); close(); }} />
          <div className="menu-sep" />
          {devices.map((d) => (
            <MenuItem
              key={d.name}
              label={<span className={`dev-opt ${d.state}`}><i />{d.name}</span>}
              hint={d.state === "online" ? (d.projects.length ? `${d.projects.length} 个项目` : "在线") : DEVICE_STATE[d.state]}
              checked={current === d.name}
              onClick={() => { onChange(d.name); close(); }}
            />
          ))}
          <MenuItem label={<span className="dev-opt online"><i />{SERVER_GROUP}</span>} checked={current === SERVER_GROUP} onClick={() => { onChange(SERVER_GROUP); close(); }} />
        </>
      )}
    </Dropdown>
  );
}

/** 会话栏底部：额度、设备和连接状态，不随图标栏的视图切换。外观和连接设置在图标栏的齿轮菜单里。 */
export function SideFooter({ store }: { store: Store }) {
  const conn = store.connection;
  const connClass = !store.url ? "bad" : conn === "connected" ? "ok" : conn === "disconnected" ? "bad" : "pending";
  const connText = !store.url ? "未连接服务器" : conn === "connected" ? "已连接" : conn === "disconnected" ? "已断开" : "重连中";
  // 负载和会话列表一起刷新（连上、回到窗口时，见 `store.refresh`），平时不轮询；「服务器」窗格打开时每 5 秒一次。
  const load = conn === "connected" ? store.hostLoad.load : null;
  return (
    <div className="side-bottom">
      <Status store={store} />
      <div className="side-foot">
        <button className={`conn ${connClass}`} title="连接服务器" onClick={() => store.toggleSettings()}>
          <i />
          <span>{connText}</span>
          {/* 旧 hubd 不支持负载统计、或第一次统计还没回来时，照旧显示可用内存。 */}
          {conn === "connected" && !load && store.memAvailableMb != null ? <small title="服务器可用内存">可用 {store.memAvailableMb} MB</small> : null}
        </button>
        {load ? <HostLoadButton store={store} load={load} /> : null}
      </div>
    </div>
  );
}

/** 「已连接」右边的服务器 CPU 和内存，点开「服务器」窗格看各会话的占用。 */
function HostLoadButton({ store, load }: { store: Store; load: HostLoad }) {
  const cpu = percent(load.cpu_permille);
  const mem = memoryPercent(load);
  const title = `服务器 ${load.cpus} 核 · CPU ${cpu}% · 负载 ${formatLoad(load.load_x100[0] ?? 0)}\n内存已用 ${load.mem_total_mb - load.mem_available_mb} / ${load.mem_total_mb} MB，可用 ${load.mem_available_mb} MB\n点开看各会话占多少`;
  return (
    <button type="button" className={`host-load${store.pane === "server" ? " on" : ""}`} title={title} onClick={() => store.togglePane("server")}>
      <span className={level(cpu)}>CPU {cpu}%</span>
      <span className="sep">·</span>
      <span className={level(mem)}>内存 {Math.round(mem)}%</span>
    </button>
  );
}

/** 首页视图的会话栏内容：新建会话、过滤分组、会话列表。 */
export function SessionsPane({ store }: { store: Store }) {
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
  const [device, setDeviceState] = useState<string | null>(() => localStorage.getItem(DEVICE_KEY));
  const setDevice = (next: string | null) => {
    setDeviceState(next);
    if (next) localStorage.setItem(DEVICE_KEY, next);
    else localStorage.removeItem(DEVICE_KEY);
  };
  const all = [...store.sessions.values()].filter((s) => !s.archived);
  const devices = deviceList(store.devices, all);
  const sessions = all.filter((s) => (filter === "all" || (filter === "wait" ? isWaiting(s.thread) : s.running)) && (!device || deviceOf(s.cwd) === device));
  // 只有两层：项目 → 会话。“全部设备”时同一设备的项目排在一起，设备之间一条带设备名的彩色分隔线；选了某台设备就不画。
  const sections = groupBy === "project" ? groupDevices(sessions) : [];
  const tagged = !device && sections.length > 1;
  const states = new Map<string, string>(devices.map((d) => [d.name, d.state]));
  const colors = deviceColorMap(store);
  const groups = groupBy === "project"
    ? sections.flatMap((d) => d.projects.map((g) => ({ id: g.key, label: g.project, sub: g.device || undefined, device: tagged ? d.device : undefined, sessions: g.sessions })))
    : groupByDate(sessions, Math.floor(Date.now() / 1000)).map((g) => ({ id: g.key, label: g.label, sub: undefined, device: undefined, sessions: g.sessions }));
  const filterLabel = filter === "wait" ? "等你决定" : filter === "running" ? "运行中" : "";
  return (
    <>
      <button className="row new" onClick={() => store.select(null)}>
        <Icon name="plus" size={14} /><span className="name">新建会话</span>
      </button>
      <div className="side-head">
        <DeviceSwitcher devices={devices} current={device} onChange={setDevice} />
        {filterLabel ? <button type="button" className="side-filter-tag" title="显示全部会话" onClick={() => setFilter("all")}>{filterLabel}<Icon name="close" size={10} /></button> : null}
        <Dropdown className="side-filter" label="过滤和分组" align="left" button={<Icon name="gear" size={14} />}>
          {(close) => (
            <>
              <div className="menu-title">显示</div>
              <MenuItem label="全部会话" checked={filter === "all"} onClick={() => { setFilter("all"); close(); }} />
              <MenuItem label="等你决定" hint={String(all.filter((s) => isWaiting(s.thread)).length)} checked={filter === "wait"} onClick={() => { setFilter("wait"); close(); }} />
              <MenuItem label="运行中" hint={String(all.filter((s) => s.running).length)} checked={filter === "running"} onClick={() => { setFilter("running"); close(); }} />
              <div className="menu-sep" />
              <div className="menu-title">分组</div>
              <MenuItem label="按设备和项目" checked={groupBy === "project"} onClick={() => { setGroupBy("project"); close(); }} />
              <MenuItem label="按时间" checked={groupBy === "date"} onClick={() => { setGroupBy("date"); close(); }} />
            </>
          )}
        </Dropdown>
      </div>
      <div className="side-scroll">
        {groups.map((g, i) => (
          <Fragment key={g.id}>
            {g.device && g.device !== groups[i - 1]?.device ? <DeviceRule name={g.device} color={colors.get(g.device) ?? 0} state={states.get(g.device)} /> : null}
            <Group
              store={store}
              id={g.id}
              label={g.label}
              sub={g.sub}
              sessions={g.sessions}
              collapsed={collapsed.includes(g.id)}
              toggle={() => toggle(g.id)}
              withProject={groupBy === "date"}
            />
          </Fragment>
        ))}
        {!groups.length && all.length ? (
          <p className="side-empty">
            {device ? `${device} 上` : ""}没有{filter === "wait" ? "等你决定的" : filter === "running" ? "运行中的" : ""}会话。
            <button className="link-btn" onClick={() => { setFilter("all"); setDevice(null); }}>显示全部</button>
          </p>
        ) : null}
        {!all.length ? <p className="side-empty">还没有会话</p> : null}
      </div>
    </>
  );
}
