import { useEffect, useState } from "react";
import { canPin, setOnTop } from "./platform";
import { Dropdown, MenuItem, rowState, sessionStatus, SessionMenu, StateIcon } from "./Common";
import { Icon } from "./Icon";
import { backgroundTasks, collectChanges, latestPlan, runningTasks } from "./model";
import { describeCwd, GLOBAL_PANES, type PaneId, type Session, type Store } from "./store";

export const PANE_TITLES: Record<PaneId, string> = { changes: "改动", tasks: "后台任务", todos: "待办", plan: "方案", info: "会话信息", usage: "使用情况" };
const PANE_ICONS: Record<PaneId, string> = { changes: "diff", tasks: "tasks", todos: "check", plan: "plan", info: "info", usage: "chart" };

function sessionHints(session: Session): Partial<Record<PaneId, string>> {
  const thread = session.thread;
  const changes = collectChanges(thread.items);
  const added = changes.reduce((n, c) => n + c.added, 0);
  const removed = changes.reduce((n, c) => n + c.removed, 0);
  const tasks = backgroundTasks(thread).length;
  const running = runningTasks(thread).length;
  const done = thread.todos.filter((t) => t.status === "completed").length;
  return {
    changes: changes.length ? `+${added} −${removed}` : undefined,
    tasks: tasks ? (running ? `${running} 个运行中` : `${tasks}`) : undefined,
    todos: thread.todos.length ? `${done} / ${thread.todos.length}` : undefined,
    plan: latestPlan(thread) ? "有" : undefined,
  };
}

/** 窗格菜单：每一项右侧给一个摘要，不打开也能看到大概。会话窗格在上，整体的（使用情况）在下。 */
function PaneMenu({ store, session }: { store: Store; session?: Session }) {
  const running = session ? runningTasks(session.thread).length : 0;
  const all = Object.keys(PANE_TITLES) as PaneId[];
  const own = session ? all.filter((id) => !GLOBAL_PANES.includes(id)) : [];
  const item = (id: PaneId, hints: Partial<Record<PaneId, string>>, close: () => void) => (
    <MenuItem key={id} icon={PANE_ICONS[id]} label={PANE_TITLES[id]} hint={hints[id]} checked={store.pane === id ? true : undefined} onClick={() => { close(); store.togglePane(id); }} />
  );
  return (
    <Dropdown
      className="pane-menu"
      label="窗格"
      button={<><Icon name="panel" size={15} />{running ? <span className="badge">{running}</span> : null}<Icon name="down" size={11} /></>}
    >
      {(close) => {
        // 摘要要遍历全部条目并拆分 Edit/Write 全文，只在菜单展开时算，不随每个事件重算。
        const hints = session ? sessionHints(session) : {};
        return (
          <>
            {own.map((id) => item(id, hints, close))}
            {own.length ? <div className="menu-sep" /> : null}
            {GLOBAL_PANES.map((id) => item(id, hints, close))}
          </>
        );
      }}
    </Dropdown>
  );
}

const ON_TOP_KEY = "cchub.onTop";

/** 窗口置顶开关，只在桌面端显示（开发时也显示，方便看布局）。选择保存下来，窗口重开后自动恢复。 */
function PinButton() {
  const [on, setOn] = useState(() => localStorage.getItem(ON_TOP_KEY) === "1");
  useEffect(() => {
    if (on) void setOnTop(true).catch(() => setOn(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- 只在打开窗口时恢复一次
  if (!canPin() && !import.meta.env.DEV) return null;
  const toggle = () => {
    const next = !on;
    setOn(next);
    localStorage.setItem(ON_TOP_KEY, next ? "1" : "0");
    void setOnTop(next).catch(() => setOn(!next));
  };
  const label = on ? "取消置顶" : "窗口置顶";
  return (
    <button type="button" className={`icon pin${on ? " on" : ""}`} aria-label={label} aria-pressed={on} title={label} onClick={toggle}>
      <Icon name="pin" size={15} />
    </button>
  );
}

export function TopBar({ store, session }: { store: Store; session?: Session }) {
  const { project } = describeCwd(session?.cwd);
  const status = session ? sessionStatus(session) : "";
  return (
    <header className="top">
      <button className="icon drawer-open" aria-label="会话列表" onClick={() => store.openDrawer()}><Icon name="back" /></button>
      {session ? (
        <Dropdown
          className="crumb"
          label="会话操作"
          align="left"
          button={
            <>
              <StateIcon state={rowState(session)} />
              {project ? <><span className="proj">{project}</span><span className="sep">/</span></> : null}
              <b title={status || undefined}>{session.title}</b>
              <Icon name="down" size={11} />
            </>
          }
        >
          {(close) => <SessionMenu store={store} session={session} close={close} />}
        </Dropdown>
      ) : (
        <div className="crumb"><b>新会话</b></div>
      )}
      <div className="top-right">
        <PinButton />
        <PaneMenu store={store} session={session} />
      </div>
    </header>
  );
}
