import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { ConnectionState } from "./generated/ConnectionState";
import { hub } from "./hub";

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: "连接中",
  connected: "已连接",
  disconnected: "已断开",
};

export function App() {
  const [connection, setConnection] = useState<ConnectionState | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = hub.onEvent((event) => {
      if (event.type === "connection") setConnection(event.state);
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  return (
    <div className="app">
      <aside className="sidebar">
        <button type="button" disabled>
          新建会话
        </button>
      </aside>
      <main className="main">
        <header className="header">cchub</header>
        <section className="messages">
          <p className="empty">
            {connection ? CONNECTION_LABEL[connection] : "尚未连接服务器"}
          </p>
        </section>
        <footer className="composer">
          <textarea placeholder="输入消息…" rows={2} disabled />
          <button type="button" disabled>
            发送
          </button>
        </footer>
      </main>
    </div>
  );
}
