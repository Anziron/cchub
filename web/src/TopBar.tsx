import { Dropdown, MenuItem, rowState, sessionStatus, SessionMenu, StateIcon } from "./Common";
import { Icon } from "./Icon";
import { backgroundTasks, collectChanges, latestPlan, runningTasks } from "./model";
import { describeCwd, type PaneId, type Session, type Store } from "./store";

export const PANE_TITLES: Record<PaneId, string> = { changes: "改动", tasks: "后台任务", todos: "待办", plan: "方案", info: "会话信息" };

/** 窗格菜单：每一项右侧给一个摘要，不打开也能看到大概。 */
function PaneMenu({ store, session }: { store: Store; session: Session }) {
  const thread = session.thread;
  const changes = collectChanges(thread.items);
  const added = changes.reduce((n, c) => n + c.added, 0);
  const removed = changes.reduce((n, c) => n + c.removed, 0);
  const tasks = backgroundTasks(thread).length;
  const running = runningTasks(thread).length;
  const done = thread.todos.filter((t) => t.status === "completed").length;
  const hints: Record<PaneId, string | undefined> = {
    changes: changes.length ? `+${added} −${removed}` : undefined,
    tasks: tasks ? (running ? `${running} 个运行中` : `${tasks}`) : undefined,
    todos: thread.todos.length ? `${done} / ${thread.todos.length}` : undefined,
    plan: latestPlan(thread) ? "有" : undefined,
    info: undefined,
  };
  const icons: Record<PaneId, string> = { changes: "diff", tasks: "tasks", todos: "check", plan: "plan", info: "info" };
  return (
    <Dropdown
      className="pane-menu"
      label="窗格"
      button={<><Icon name="panel" size={15} />{running ? <span className="badge">{running}</span> : null}<Icon name="down" size={11} /></>}
    >
      {(close) => (Object.keys(PANE_TITLES) as PaneId[]).map((id) => (
        <MenuItem key={id} icon={icons[id]} label={PANE_TITLES[id]} hint={hints[id]} checked={store.pane === id ? true : undefined} onClick={() => { close(); store.togglePane(id); }} />
      ))}
    </Dropdown>
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
        {session ? <PaneMenu store={store} session={session} /> : null}
      </div>
    </header>
  );
}
