import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { findModel, hubHost, hubUrl, type ModelOption } from "./model";
import { describeCwd, type Store } from "./store";

/** 弹窗。Esc 只关弹窗，不能冒泡到窗口上变成中断任务。 */
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
  }, []);
  // 点击列表后焦点可能落到 body，所以在窗口的捕获阶段拦截，别处的 Esc 监听收不到。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header>
          <h2>{title}</h2>
          <button type="button" className="icon" aria-label="关闭" onClick={onClose}><Icon name="close" /></button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function ConnectDialog({ store }: { store: Store }) {
  const [host, setHost] = useState(() => hubHost(store.url));
  const [tried, setTried] = useState(false);
  const url = hubUrl(host);
  const current = tried && url === store.url;
  const status = !current
    ? null
    : store.connection === "connected"
      ? "已连接"
      : store.connection === "disconnected"
        ? "连接不上。请确认地址正确、服务器上的 hubd 在运行，并且这台设备已连上 Tailscale。"
        : "正在连接…";
  return (
    <Modal title="连接服务器" onClose={() => store.toggleSettings()}>
      <form onSubmit={(event) => { event.preventDefault(); if (url) { setTried(true); void store.connect(url); } }}>
        <label className="field">
          <span>服务器 IP</span>
          <input autoFocus spellCheck={false} placeholder="100.x.x.x" value={host} onChange={(event) => { setHost(event.target.value); setTried(false); }} />
        </label>
        <p className="help">填服务器的 Tailscale 地址（在服务器上运行 <code>tailscale ip -4</code> 查看）。本机 <code>ipconfig</code> 显示的是这台电脑自己的地址，不是服务器的。</p>
        {status ? <p className={`help${store.connection === "disconnected" ? " bad" : ""}`} role="status">{status}</p> : null}
        <div className="actions end">
          <button type="button" className="btn quiet" onClick={() => store.toggleSettings()}>取消</button>
          <button className="btn solid" disabled={!url}>连接</button>
        </div>
      </form>
    </Modal>
  );
}

const lastSegment = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

export function WorkspaceDialog({ store }: { store: Store }) {
  const { device, path, parent, entries, error, loading } = store.browse;
  const [manual, setManual] = useState("");
  const recent = store.recentWorkspaces();
  const close = () => store.closeWorkspace();
  const up = () => {
    if (parent) store.browseTo(device, parent);
    else if (path) store.browseTo(device, null);
    else store.browseTo(null, null);
  };
  return (
    <Modal title="选择工作区" onClose={close}>
      {!device && recent.length ? (
        <section className="picker">
          <h3>最近</h3>
          <div className="list short">
            {recent.map((cwd) => {
              const { project, device: where } = describeCwd(cwd);
              return (
                <button type="button" key={cwd} className="pick" title={cwd} onClick={() => store.chooseWorkspace(cwd)}>
                  <Icon name="folder" /><span>{project}</span><small>{where}</small>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}
      <section className="picker">
        {device ? (
          <div className="crumbs">
            <button type="button" className="icon" aria-label="上一级" onClick={up}><Icon name="back" /></button>
            <span title={path ?? device}>{device}{path ? ` · ${path}` : ""}</span>
          </div>
        ) : (
          <h3>设备</h3>
        )}
        <div className="list">
          {loading ? <p className="empty">正在读取…</p> : null}
          {!loading && error ? <p className="empty bad">{error}</p> : null}
          {!loading && !error && !entries.length ? <p className="empty">{device ? "没有子文件夹" : "没有登记的设备"}</p> : null}
          {!loading && !error
            ? entries.map((entry) => (
                <button
                  type="button"
                  key={entry}
                  className="pick"
                  title={entry}
                  onClick={() => (device ? store.browseTo(device, entry) : store.browseTo(entry, null))}
                >
                  <Icon name="folder" /><span>{device ? lastSegment(entry) : entry}</span><Icon name="chev" size={13} />
                </button>
              ))
            : null}
        </div>
      </section>
      {store.mountError ? <p className="help bad" role="alert">{store.mountError}</p> : null}
      <div className="actions end">
        {!device ? (
          <form className="manual" onSubmit={(event) => { event.preventDefault(); if (manual.startsWith("/")) store.chooseWorkspace(manual); }}>
            <input spellCheck={false} aria-label="服务器上的路径" placeholder="或输入服务器上的路径" value={manual} onChange={(event) => setManual(event.target.value)} />
            <button className="btn ghost" disabled={!manual.startsWith("/")}>使用</button>
          </form>
        ) : null}
        <button type="button" className="btn quiet" onClick={close}>取消</button>
        {device ? (
          <button type="button" className="btn solid" disabled={!path || loading || store.mounting} onClick={() => path && store.mount(device, path)}>
            {store.mounting ? "正在挂载…" : "选择这个文件夹"}
          </button>
        ) : null}
      </div>
    </Modal>
  );
}

export function ModelMenu({ models, model, onChange }: { models: ModelOption[]; model?: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = findModel(models, model);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    addEventListener("mousedown", onDown);
    return () => removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div
      className="model-wrap"
      ref={ref}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button type="button" className="model" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{current?.displayName ?? model ?? "默认模型"}</span><Icon name="down" size={12} />
      </button>
      {open ? (
        <div className="menu" role="menu">
          {models.map((option) => (
            <button
              type="button"
              key={option.value}
              role="menuitemradio"
              aria-checked={option === current}
              onClick={() => { onChange(option.value); setOpen(false); }}
            >
              <span><b>{option.displayName}</b>{option.description ? <small>{option.description}</small> : null}</span>
              {option === current ? <Icon name="check" size={14} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
