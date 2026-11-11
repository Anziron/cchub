import { useEffect, useState, useSyncExternalStore } from "react";
import { Composer, Welcome } from "./Composer";
import { ConfirmDialog, ConnectDialog, ResumeDialog, WorkspaceDialog } from "./Dialogs";
import { loadAppearance, resolveTheme, saveAppearance, type Appearance } from "./appearance";
import { Icon } from "./Icon";
import type { Todo } from "./model";
import { PaneView } from "./Panes";
import { isAndroid, pageVisible, takeOpenedSession } from "./platform";
import { Sidebar } from "./SessionList";
import type { Store } from "./store";
import { ThreadView } from "./Thread";
import { TopBar } from "./TopBar";

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

export function App({ store }: { store: Store }) {
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

  const conn = store.connection;
  return (
    <div className={`app${store.showDrawer ? " drawer" : ""}`}>
      <Sidebar store={store} look={look} onLook={setLook} />
      <main className="main">
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
          <Welcome store={store} />
        )}
      </main>
      {store.showSettings ? <ConnectDialog store={store} /> : null}
      {store.showWorkspace ? <WorkspaceDialog store={store} /> : null}
      {store.stopping ? <ConfirmDialog store={store} session={store.stopping} /> : null}
      {store.showResume ? <ResumeDialog store={store} /> : null}
    </div>
  );
}
