import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Icon } from "./Icon";
import { FONTS, SIZES, THEMES, type Appearance } from "./appearance";
import { effortsFor, findModel, hubHost, hubUrl, runningTasks, type ModelOption, type SlashCommand } from "./model";
import { backgroundStatus, isAndroid, requestBatteryUnrestricted, type BackgroundStatus } from "./platform";
import { DEVICE_STATE, deviceList, formatAgo } from "./sidebar";
import { describeCwd, type Session, type Store } from "./store";

/** 弹窗。Esc 只关弹窗，不能冒泡到窗口上变成中断任务。 */
/** `local`：只盖住对话区并在其中居中（和输入框对齐），要放在 `.main` 里渲染。 */
function Modal({ title, onClose, children, className, local }: { title: string; onClose: () => void; children: ReactNode; className?: string; local?: boolean }) {
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
    <div className={local ? "overlay local" : "overlay"} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={ref}
        className={className ? `modal ${className}` : "modal"}
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

/** 通知依赖后台连接，权限没开时要让用户看得到。 */
function BackgroundPanel() {
  const [status, setStatus] = useState<BackgroundStatus | null>(null);
  useEffect(() => {
    const load = () => { void backgroundStatus().then(setStatus); };
    load();
    addEventListener("focus", load);
    document.addEventListener("visibilitychange", load);
    return () => { removeEventListener("focus", load); document.removeEventListener("visibilitychange", load); };
  }, []);
  if (!status) return null;
  return (
    <div className="background">
      {!status.notificationsAllowed ? <p className="help bad">通知权限已关闭，需要你决定时不会提醒。请到系统设置里打开。</p> : null}
      {status.batteryUnrestricted
        ? <p className="help">后台运行不受电池优化限制。</p>
        : <p className="help">系统可能在息屏后断开连接。<button type="button" className="link-btn" onClick={() => void requestBatteryUnrestricted()}>允许后台运行</button></p>}
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
          <input autoFocus inputMode="url" autoCapitalize="none"spellCheck={false} placeholder="100.x.x.x" value={host} onChange={(event) => { setHost(event.target.value); setTried(false); }} />
        </label>
        <p className="help">填服务器的 Tailscale 地址（在服务器上运行 <code>tailscale ip -4</code> 查看）。{isAndroid ? "手机上要先打开 Tailscale 并登录同一账号。" : <>本机 <code>ipconfig</code> 显示的是这台电脑自己的地址，不是服务器的。</>}</p>
        {status ? <p className={`help${store.connection === "disconnected" ? " bad" : ""}`} role="status">{status}</p> : null}
        {isAndroid ? <BackgroundPanel /> : null}
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
      {/* 第一版手机端不浏览和挂载新项目。 */}
      {isAndroid ? (!recent.length ? <p className="empty">还没有用过的工作区，可以手动输入路径。</p> : null) : (
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
      )}
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

/**
 * 弹出菜单放在按钮上方还是下方，最高多高。新会话页的输入框在窗口中间，
 * 上方空间不够时菜单会被 `.main` 的 `overflow: hidden` 裁掉，滚也滚不到被裁的部分。
 */
/**
 * 菜单能显示的上下范围：最近一个会裁剪内容的祖先（`overflow` 不是 visible，如侧栏的会话列表、`.main`），
 * 再和窗口取交集。只按窗口算时，侧栏第二行的菜单会以为上方够放，结果被列表裁掉。
 */
function clipBounds(el: HTMLElement): { top: number; bottom: number } {
  let top = 0;
  let bottom = innerHeight;
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowY === "visible" && style.overflowX === "visible") continue;
    const rect = node.getBoundingClientRect();
    top = Math.max(top, rect.top);
    bottom = Math.min(bottom, rect.bottom);
    break;
  }
  return { top, bottom };
}

/**
 * `fixed`：菜单按窗口定位（`position: fixed`），不受滚动列表裁剪，用于侧栏的会话行；
 * 此时按窗口判断上下，`align` 决定和按钮的哪一边对齐。
 */
export function useMenuFit(anchor: RefObject<HTMLElement | null>, open: boolean, deps: unknown[], fixed = false, align: "left" | "right" = "right", menuRef?: RefObject<HTMLElement | null>): CSSProperties {
  const [fit, setFit] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const measure = () => {
      const box = anchor.current!.getBoundingClientRect();
      const bounds = fixed ? { top: 0, bottom: innerHeight } : clipBounds(anchor.current!);
      const gap = 6 + 8;
      const above = box.top - bounds.top - gap;
      const below = bounds.bottom - box.bottom - gap;
      // 放到 body 下的菜单不在按钮里面，由调用方传进来。
      const menu = menuRef?.current ?? anchor.current!.querySelector<HTMLElement>(".menu");
      const need = menu ? menu.scrollHeight : 0;
      // 按窗口定位时优先往下（侧栏行菜单的自然方向）；其余优先往上（输入框上的菜单）。
      const down = fixed ? below >= need || below > above : above < need && below > above;
      if (fixed) {
        const side = align === "left" ? { left: box.left, right: "auto" } : { right: innerWidth - box.right, left: "auto" };
        setFit(down
          ? { position: "fixed", top: box.bottom + 6, bottom: "auto", maxHeight: below, ...side }
          : { position: "fixed", bottom: innerHeight - box.top + 6, top: "auto", maxHeight: above, ...side });
        return;
      }
      setFit(down ? { top: "calc(100% + 6px)", bottom: "auto", maxHeight: below } : { maxHeight: above });
    };
    measure();
    addEventListener("resize", measure);
    return () => removeEventListener("resize", measure);
  }, [open, ...deps]);
  return fit;
}

/**
 * 模型和推理强度：上面一行是当前模型，点开换成模型列表；下面是强度滑块和档位名。
 * 拖滑块、点档位都不关菜单；设过强度时标题行右边可以恢复默认。
 */
export function ModelMenu({ models, model, effort, onChange, onEffort }: {
  models: ModelOption[];
  model?: string;
  effort?: string;
  onChange: (value: string) => void;
  onEffort: (effort?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = findModel(models, model);
  const modelName = current?.displayName ?? model ?? "默认模型";
  const efforts = effortsFor(current);
  const index = efforts.findIndex((e) => e.value === effort);
  const effortLabel = index >= 0 ? efforts[index].label : undefined;
  // 没设过强度时滑块停在“中”附近，只是示意，标题显示“默认”。
  const position = index >= 0 ? index : Math.max(0, efforts.findIndex((e) => e.value === "medium"));
  const close = () => { setOpen(false); setPicking(false); };
  const fit = useMenuFit(ref, open, [picking, models.length]);
  // 最高档有“升级”的波动动效（CSS），切到别的档位就停。
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
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
          if (picking) setPicking(false);
          else close();
        }
      }}
    >
      <button type="button" className="model" aria-haspopup="menu" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        <span>{modelName}</span>
        {effortLabel ? <em>{effortLabel}</em> : null}
        <Icon name="down" size={12} />
      </button>
      {open && picking ? (
        <div className="menu" role="menu" style={fit}>
          <button type="button" className="menu-back" onClick={() => setPicking(false)}><Icon name="back" size={13} />模型</button>
          {models.map((option) => (
            <button
              type="button"
              key={option.value}
              role="menuitemradio"
              aria-checked={option === current}
              onClick={() => { onChange(option.value); setPicking(false); }}
            >
              <span><b>{option.displayName}</b>{option.description ? <small>{option.description}</small> : null}</span>
              {option === current ? <Icon name="check" size={14} /> : null}
            </button>
          ))}
        </div>
      ) : open ? (
        <div className="menu effort-card" style={fit}>
          <div className="menu-title">模型</div>
          <button type="button" className="effort-model" onClick={() => setPicking(true)}>
            <span><b>{modelName}</b></span>
            <Icon name="chev" size={12} />
          </button>
          <div className="menu-sep" />
          <div className="effort-head">
            <span className="menu-title">推理强度</span>
            {!efforts.length ? <small>这个模型不支持</small> : effortLabel ? (
              <button type="button" className="effort-reset" title="恢复成模型的默认强度" onClick={() => onEffort(undefined)}><Icon name="reset" size={12} />恢复默认</button>
            ) : <small>默认</small>}
          </div>
          {efforts.length ? (
            <div className="effort-body">
              <div className={`effort-slider${effortLabel ? "" : " unset"}${effort === "max" ? " max" : ""}`} style={{ "--pos": efforts.length > 1 ? position / (efforts.length - 1) : 0 } as CSSProperties}>
                <div className="effort-dots" aria-hidden>{efforts.map((e) => <i key={e.value} />)}</div>
                <input
                  type="range"
                  min={0}
                  max={efforts.length - 1}
                  step={1}
                  value={position}
                  aria-label="推理强度"
                  aria-valuetext={effortLabel ?? "默认"}
                  onChange={(event) => onEffort(efforts[Number(event.target.value)].value)}
                  // 点在当前位置上也算选中，没设过强度时第一次点“中”要能生效。
                  onPointerUp={(event) => { if (index < 0) onEffort(efforts[Number(event.currentTarget.value)].value); }}
                />
              </div>
              <div className="effort-ticks">
                {efforts.map((e, i) => (
                  <button type="button" key={e.value} className={i === index ? `on${e.value === "max" ? " max" : ""}` : undefined} onClick={() => onEffort(e.value)}>{e.label}</button>
                ))}
              </div>
              <p className="effort-hint">{index >= 0 ? efforts[index].description : "跟随模型的默认设置"}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function CommandMenu({ commands, selected, onChoose }: { commands: SlashCommand[]; selected: number; onChoose: (command: SlashCommand) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return (
    <div className="commands" role="listbox" aria-label="命令" ref={ref}>
      {commands.map((command, i) => (
        <button
          type="button"
          key={command.name}
          role="option"
          aria-selected={i === selected}
          className={i === selected ? "on" : ""}
          // 用 mousedown，不让输入框失去焦点。
          onMouseDown={(event) => { event.preventDefault(); onChoose(command); }}
        >
          <b>/{command.name}{command.argumentHint ? <em> {command.argumentHint}</em> : null}</b>
          {command.description ? <small>{command.description}</small> : null}
        </button>
      ))}
    </div>
  );
}

export function ConfirmDialog({ store, session }: { store: Store; session: Session }) {
  const tasks = runningTasks(session.thread).length;
  return (
    <Modal title={store.archiveAfterStop ? "关闭这个会话？" : "结束这个会话？"} onClose={() => store.cancelStop()}>
      <p className="help first">
        「{session.title}」还在工作{tasks ? `，后台有 ${tasks} 个任务` : ""}。结束后正在执行的操作会被终止，可能留下没做完的改动。
        之后在这个会话里发消息可以接着聊。
      </p>
      <div className="actions end">
        <button className="btn quiet" autoFocus onClick={() => store.cancelStop()}>继续运行</button>
        {store.archiveAfterStop
          ? <button className="btn solid" onClick={() => store.archive(session)}>关闭会话</button>
          : <button className="btn solid" onClick={() => store.stopSession(session)}>结束会话</button>}
      </div>
    </Modal>
  );
}

const OS_LABEL: Record<string, string> = { windows: "Windows", macos: "macOS", mac: "macOS", darwin: "macOS", linux: "Linux" };

/** 设备弹窗：在线状态、这台设备上用过的项目（可直接开新会话）、浏览目录挂载新项目。 */
export function DeviceDialog({ store, name }: { store: Store; name: string }) {
  const device = deviceList(store.devices, [...store.sessions.values()].filter((s) => !s.archived)).find((d) => d.name === name);
  const close = () => store.closeDevice();
  const state = device?.state ?? "unknown";
  const os = device?.os ? OS_LABEL[device.os.toLowerCase()] ?? device.os : null;
  const hint =
    state === "offline" ? "设备不在线：确认它已开机并连上 Tailscale。这台设备上的会话读写文件会失败，发出的消息会排队。"
    : state === "warn" ? "设备在线，但有项目目录读不到（挂载可能断了）。新会话启动前会自动重新挂载。"
    : state === "unknown" ? "还没有拿到这台设备的状态。"
    : null;
  return (
    <Modal title={name} onClose={close} className="device-modal">
      <div className={`device-status dev ${state}`}>
        <i />
        <span>{DEVICE_STATE[state]}</span>
        {os ? <small>· {os}</small> : null}
        <button type="button" className="link-btn" disabled={store.devicesLoading} onClick={() => store.requestDevices()}>
          {store.devicesLoading ? "正在检测…" : "重新检测"}
        </button>
      </div>
      {hint ? <p className={`help${state === "offline" ? " bad" : ""}`}>{hint}</p> : null}
      {store.devicesError ? <p className="help bad" role="alert">{store.devicesError}</p> : null}
      <section className="picker">
        <h3>项目</h3>
        <div className="list short">
          {device?.projects.length ? device.projects.map((p) => (
            <button type="button" key={p.cwd} className="pick" title={`${p.cwd}\n在这个项目里开新会话`} onClick={() => store.newSessionIn(p.cwd)}>
              <Icon name="folder" />
              <span>{p.project}</span>
              <small>{p.running ? `${p.running} 个运行中 · ` : ""}{p.sessions} 个会话</small>
              <Icon name="plus" size={13} />
            </button>
          )) : <p className="empty">还没有在这台设备上开过会话。</p>}
        </div>
      </section>
      <div className="actions end">
        <button type="button" className="btn quiet" onClick={close}>关闭</button>
        <button type="button" className="btn solid" disabled={state === "offline"} onClick={() => store.browseDevice(name)}>浏览目录…</button>
      </div>
    </Modal>
  );
}

/** `/resume`：已关闭的会话，按标题或项目名搜索，选中后回到侧边栏并打开。 */
export function ResumeDialog({ store }: { store: Store }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const q = query.trim().toLowerCase();
  const sessions = store.archivedSessions().filter((s) => !q || `${s.title} ${describeCwd(s.cwd).project}`.toLowerCase().includes(q));
  const now = Math.floor(Date.now() / 1000);
  const pick = (session?: Session) => { if (session) store.unarchive(session); };
  return (
    <Modal title="找回已关闭的会话" onClose={() => store.closeResume()}>
      <input
        className="resume-search"
        autoFocus
        placeholder="搜索标题或项目"
        value={query}
        onChange={(event) => { setQuery(event.target.value); setSelected(0); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setSelected((i) => Math.min(i + 1, sessions.length - 1)); }
          else if (event.key === "ArrowUp") { event.preventDefault(); setSelected((i) => Math.max(i - 1, 0)); }
          else if (event.key === "Enter") { event.preventDefault(); pick(sessions[selected]); }
        }}
      />
      <div className="resume-list" role="listbox">
        {!sessions.length ? <p className="empty">{q ? "没有匹配的会话" : "没有已关闭的会话"}</p> : null}
        {sessions.map((session, index) => (
          <button
            key={session.id}
            role="option"
            aria-selected={index === selected}
            className={`resume-item${index === selected ? " current" : ""}`}
            onMouseEnter={() => setSelected(index)}
            onClick={() => pick(session)}
          >
            <span className="title">{session.title}</span>
            <em>{describeCwd(session.cwd).project || "服务器"}</em>
            <span className="ago">{session.updated ? formatAgo(session.updated, now) : ""}</span>
          </button>
        ))}
      </div>
      <p className="help">关闭超过 7 天没有更新的会话会被自动清理。</p>
    </Modal>
  );
}

// 外观面板：配色、正文字体、字号，选中立即生效
export function AppearanceMenu({ look, onChange }: { look: Appearance; onChange: (patch: Partial<Appearance>) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
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
      className="look-wrap"
      ref={ref}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button type="button" className="icon" aria-label="外观" title="外观" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="palette" />
      </button>
      {open ? (
        <div className="look" role="dialog" aria-label="外观">
          <h4>配色</h4>
          <div className="opts" role="radiogroup" aria-label="配色">
            {THEMES.map((o) => (
              <button type="button" key={o.id} role="radio" aria-checked={look.theme === o.id} onClick={() => onChange({ theme: o.id })}>
                <i
                  className="sw"
                  style={{ background: `linear-gradient(135deg, ${o.swatch[0]} 55%, ${o.swatch[2]} 55%)` }}
                />
                {o.label}
              </button>
            ))}
          </div>
          <h4>正文字体</h4>
          <div className="opts" role="radiogroup" aria-label="正文字体">
            {FONTS.map((o) => (
              <button type="button" key={o.id} role="radio" aria-checked={look.font === o.id} onClick={() => onChange({ font: o.id })}>
                <span className={`aa aa-${o.id}`}>Aa</span>{o.label}
              </button>
            ))}
          </div>
          <h4>字号</h4>
          <div className="opts" role="radiogroup" aria-label="字号">
            {SIZES.map((o) => (
              <button type="button" key={o.id} role="radio" aria-checked={look.size === o.id} onClick={() => onChange({ size: o.id })}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
