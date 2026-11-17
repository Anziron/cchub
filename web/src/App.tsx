import { useEffect, useState, useSyncExternalStore } from "react";
import { Composer, Welcome } from "./Composer";
import { ConfirmDialog, ConnectDialog, DeviceDialog, ResumeDialog, WorkspaceDialog } from "./Dialogs";
import { loadAppearance, resolveTheme, saveAppearance, type Appearance } from "./appearance";
import { Icon } from "./Icon";
import type { Todo } from "./model";
import { PaneView } from "./Panes";
import { customFrame, isAndroid, isNarrow, pageVisible, takeOpenedSession } from "./platform";
import { Rail, type ViewDef } from "./Rail";
import { currentWidth, initLayoutVars, LAYOUT_EVENT, PANE_SIZING, Resizer, SIDE_SIZING } from "./Resizer";
import { SessionsPane, SideFooter } from "./SessionList";
import { GLOBAL_PANES, type Session, type Store } from "./store";
import { ThreadView } from "./Thread";
import { TopBar } from "./TopBar";
import { TitleBar } from "./WindowControls";

function useAppearance() {
  const [look, setLook] = useState<Appearance>(() => loadAppearance(localStorage, matchMedia("(prefers-color-scheme: dark)").matches));
  useEffect(() => {
    const { theme, tone } = resolveTheme(look.theme);
    const d = document.documentElement.dataset;
    d.theme = theme;
    d.tone = tone;
    d.font = look.font;
    d.size = look.size;
    saveAppearance(localStorage, look);
  }, [look]);
  return [look, (patch: Partial<Appearance>) => {
    const root = document.documentElement;
    root.classList.add("switching");
    setLook((a) => ({ ...a, ...patch }));
    setTimeout(() => root.classList.remove("switching"), 280);
  }] as const;
}

/** 待办进度条：窄屏和没开待办窗格时显示在对话上方。 */
function TodoBar({ todos, onOpen }: { todos: Todo[]; onOpen: () => void }) {
  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  const doing = todos.find((t) => t.status === "in_progress");
  return (
    <button type="button" className="todo" onClick={onOpen} title="查看待办">
      <span className="bar"><i style={{ width: `${(done / todos.length) * 100}%` }} /></span>
      <span className="now">{doing?.activeForm ?? doing?.content ?? (done === todos.length ? "全部完成" : todos[done]?.content)}</span>
      <span className="count">{done} / {todos.length}</span>
    </button>
  );
}

/** 首页视图的主区域：顶栏、提示、会话（或新会话页）和右侧窗格。 */
function HomeMain({ store }: { store: Store }) {
  const session = store.selected ? store.sessions.get(store.selected) : undefined;
  const conn = store.connection;
  return (
    <>
      <TopBar store={store} session={session} />
      {conn === "disconnected" || (conn === "connecting" && store.url) ? (
        <div className="notice on"><Icon name="alert" /><span>与服务器的连接已断开，任务仍在服务器上运行。正在重连…</span></div>
      ) : null}
      {session && !session.deviceOnline ? (
        <div className="notice on"><Icon name="alert" /><span>设备离线。新消息已排队，这段时间的文件错误可能由离线造成，写入也可能不完整。</span></div>
      ) : null}
      {store.error ? (
        <div className="notice on"><Icon name="alert" /><span>{store.error}</span><button onClick={() => store.dismissError()}>知道了</button></div>
      ) : null}
      {session ? (
        <div className="body">
          <div className="chat">
            {store.pane !== "todos" ? <TodoBar todos={session.thread.todos} onOpen={() => store.openPane("todos")} /> : null}
            <ThreadView key={session.id} store={store} session={session} />
            <Composer key={`composer:${session.id}`} store={store} session={session} />
          </div>
          <PaneView store={store} session={session} />
        </div>
      ) : (
        <div className="body">
          <div className="chat"><Welcome store={store} /></div>
          <PaneView store={store} />
        </div>
      )}
    </>
  );
}

/** 图标栏的视图。以后加插件、定时任务：各加一项（会话栏内容 + 主区域内容）。 */
const VIEWS: ViewDef[] = [
  { id: "home", label: "首页", icon: "home", side: SessionsPane, main: HomeMain },
];

const RAIL_WIDTH = 48;
const PANEL_GAP = 8;
const MIN_MAIN = 480;
/** 窗格盖在对话区上的最大窗口宽度（见 styles.css），此时窗格不占对话区的宽度。 */
const PANE_OVERLAY_MAX = 1080;

/**
 * 消息区宽度（会话栏和停靠的窗格占去之后）低于 480px 时，会话栏改成浮层。
 * 手动收起时也按“展开后”算，这样点图标展开时知道该走浮层。窄屏抽屉不走这条。
 */
function useFloating(store: Store, session?: Session): boolean {
  const pane = store.pane && (session || GLOBAL_PANES.includes(store.pane)) ? store.pane : null;
  const compute = () => {
    if (isNarrow()) return false;
    const docked = pane && innerWidth > PANE_OVERLAY_MAX ? currentWidth(PANE_SIZING) : 0;
    return innerWidth - RAIL_WIDTH - PANEL_GAP - currentWidth(SIDE_SIZING) - docked < MIN_MAIN;
  };
  // 调整窗口大小时 resize 事件很密：只在结果变化时才更新状态，避免整棵树（含长会话）跟着重画。
  const [floating, setFloating] = useState(compute);
  useEffect(() => {
    const on = () => setFloating(compute());
    on();
    addEventListener("resize", on);
    addEventListener(LAYOUT_EVENT, on);
    return () => { removeEventListener("resize", on); removeEventListener(LAYOUT_EVENT, on); };
  }, [pane]);
  return floating;
}

export function App({ store }: { store: Store }) {
  // 渲染前读一次本地保存的宽度（demo 的 ?sidew= 也要先写进去）。
  useState(initLayoutVars);
  useSyncExternalStore(store.subscribe, store.getVersion);
  const [look, setLook] = useAppearance();
  const session = store.selected ? store.sessions.get(store.selected) : undefined;

  // 窗口回到前台时刷新一次会话列表和内存，平时不轮询。
  useEffect(() => {
    const onFocus = () => { if (store.connection === "connected") store.refresh(); };
    addEventListener("focus", onFocus);
    return () => removeEventListener("focus", onFocus);
  }, [store]);

  // 窗口看不见时暂停动画；只是失去焦点（放在旁边看着）不暂停。
  useEffect(() => {
    const sync = () => document.body.classList.toggle("paused", !pageVisible());
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  // Android 上由系统回调：返回键，以及从通知跳到对应会话。
  useEffect(() => {
    if (!isAndroid) return;
    const hooks = window as unknown as Record<string, unknown>;
    hooks.__cchubBack = () => store.back();
    hooks.__cchubOpen = (id: string) => { store.select(id); return true; };
    void takeOpenedSession().then((id) => { if (id) store.select(id); });
    const onVisible = () => { if (!document.hidden && store.connection === "connected") store.refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [store]);

  // Ctrl+O：普通档（工具合并）和详细档（逐条显示）切换，和官方一致。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        store.toggleVerbose();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [store]);

  const floating = useFloating(store, session);

  // Ctrl+B 收起 / 展开会话栏，和再点一次当前视图图标一样；浮层展开时 Esc 收回。窄屏抽屉不受影响。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        store.toggleSide(floating);
      } else if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        // Alt+← / Alt+→ 后退 / 前进，和浏览器一样
        event.preventDefault();
        store.go(event.key === "ArrowLeft" ? -1 : 1);
      } else if (event.key === "Escape" && floating && store.sideFloatOpen) {
        store.closeSideFloat();
      }
    };
    // 鼠标侧键（第 4、5 键）后退 / 前进
    const onMouse = (event: MouseEvent) => {
      if (event.button === 3 || event.button === 4) {
        event.preventDefault();
        store.go(event.button === 3 ? -1 : 1);
      }
    };
    addEventListener("keydown", onKey);
    addEventListener("mouseup", onMouse);
    return () => { removeEventListener("keydown", onKey); removeEventListener("mouseup", onMouse); };
  }, [store, floating]);

  const view = VIEWS.find((v) => v.id === store.view) ?? VIEWS[0];
  const Side = view.side;
  const Main = view.main ?? HomeMain;
  const classes = ["app"];
  if (store.showDrawer) classes.push("drawer");
  if (customFrame()) classes.push("frame-custom");
  if (floating) classes.push("float", ...(store.sideFloatOpen ? ["float-open"] : []));
  else if (store.sideCollapsed) classes.push("collapsed");
  return (
    <div className={classes.join(" ")} data-tauri-drag-region>
      {customFrame() ? <TitleBar store={store} floating={floating} /> : null}
      <Rail store={store} views={VIEWS} floating={floating} look={look} onLook={setLook} />
      <div className="panel">
        <aside className="side">
          <div className="side-body"><Side store={store} /></div>
          <SideFooter store={store} />
        </aside>
        <Resizer sizing={SIDE_SIZING} target="prev" label="调整会话栏宽度" />
        {floating && store.sideFloatOpen ? <div className="side-scrim" onMouseDown={() => store.closeSideFloat()} /> : null}
        <main className="main">
          <Main store={store} />
        </main>
      </div>
      {store.showSettings ? <ConnectDialog store={store} /> : null}
      {store.showWorkspace ? <WorkspaceDialog store={store} /> : null}
      {store.stopping ? <ConfirmDialog store={store} session={store.stopping} /> : null}
      {store.showResume ? <ResumeDialog store={store} /> : null}
      {store.deviceDialog ? <DeviceDialog store={store} name={store.deviceDialog} /> : null}
    </div>
  );
}
