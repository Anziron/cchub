export function App() {
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
          <p className="empty">尚未连接服务器</p>
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
