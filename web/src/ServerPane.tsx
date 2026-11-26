import { useEffect, useState, type MouseEvent } from "react";
import { agoText, chartPoints, chartX, formatLoad, HOST_LOAD_REFRESH_MS, level, loadWarning, memoryPercent, memoryWarning, nearestPoint, percent, shareLevel, type LoadPoint } from "./hostload.ts";
import { describeCwd } from "./paths.ts";
import { pageVisible } from "./platform.ts";
import type { Store } from "./store.ts";

/** 「服务器」窗格：整台机器的 CPU、内存，最近 10 分钟的走势，各会话和其他进程的占用。 */
export function ServerPane({ store }: { store: Store }) {
  // 只有窗格开着才轮询（平时不轮询）：打开时问一次，之后页面看得见时每 5 秒一次，切回窗口时补一次。
  useEffect(() => {
    const tick = () => { if (pageVisible()) store.requestHostLoad(); };
    tick();
    const timer = setInterval(tick, HOST_LOAD_REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [store, store.connection]);
  const { load, error, unsupported, history } = store.hostLoad;
  if (unsupported) return <p className="empty">服务器的 hubd 版本较旧，不支持查看负载，升级服务器后再用。</p>;
  if (!load) return error ? <p className="usage-error">{error}</p> : <p className="empty">正在读取服务器负载…</p>;
  const cpu = percent(load.cpu_permille);
  const mem = memoryPercent(load);
  const cpuNote = loadWarning(load);
  const memNote = memoryWarning(load);
  return (
    <>
      {error ? <p className="usage-error">{error}</p> : null}
      <h4>现在</h4>
      <div className="quota-card">
        <div className={`quota-row ${level(cpu)}`} title="1 / 5 / 15 分钟平均负载：超过核数说明有任务在排队等 CPU">
          <span className="quota-label">CPU</span>
          <span className="quota-bar"><i style={{ width: `${cpu}%` }} /></span>
          <b>{cpu}%</b>
          <span className="quota-reset">{load.cpus} 核 · 负载 {load.load_x100.map(formatLoad).join(" / ")}{cpuNote ? <em> · {cpuNote}</em> : null}</span>
        </div>
        <div className={`quota-row ${level(mem)}`}>
          <span className="quota-label">内存</span>
          <span className="quota-bar"><i style={{ width: `${mem.toFixed(1)}%` }} /></span>
          <b>{Math.round(mem)}%</b>
          <span className="quota-reset">已用 {load.mem_total_mb - load.mem_available_mb} / {load.mem_total_mb} MB · 可用 {load.mem_available_mb} MB{memNote ? <em> · {memNote}</em> : null}</span>
        </div>
      </div>
      <h4>最近 10 分钟</h4>
      <LoadChart history={history} />
      <h4>cchub 会话{load.sessions.length ? <span className="h4-note">点一行打开会话</span> : null}</h4>
      {load.sessions.length ? (
        <>
          <div className="proc-head"><span>会话</span><span>CPU</span><span>内存</span></div>
          {load.sessions.map((item) => {
            const session = store.sessions.get(item.session);
            const { project, device } = describeCwd(session?.cwd);
            return (
              <button key={item.session} type="button" className="proc-row" title={session?.cwd} onClick={() => store.select(item.session)}>
                <span className="proc-name"><b>{session?.title || item.session}</b>{project ? <small>{device} · {project}</small> : null}</span>
                <span className={`n ${shareLevel(item.cpu_permille)}`}>{percent(item.cpu_permille)}%</span>
                <span className="n">{item.mem_mb} MB</span>
              </button>
            );
          })}
        </>
      ) : <p className="empty">没有正在运行的会话。</p>}
      <h4>其他进程<span className="h4-note">不属于会话的，占用最多的几个</span></h4>
      <div className="proc-head"><span>进程</span><span>CPU</span><span>内存</span></div>
      {load.others.map((item) => (
        <div key={item.pid} className="proc-row" title={`PID ${item.pid}${item.cwd ? `\n${item.cwd}` : ""}`}>
          <span className="proc-name"><b>{item.name}</b>{item.cwd ? <small>{item.cwd}</small> : null}</span>
          <span className={`n ${shareLevel(item.cpu_permille)}`}>{percent(item.cpu_permille)}%</span>
          <span className="n">{item.mem_mb} MB</span>
        </div>
      ))}
      <p className="host-note">CPU 是占整台机器的百分比（{load.cpus} 核合计 100%）。窗格开着时每 5 秒刷新，窗口在后台时暂停；会话空闲一段时间后进程被回收，不在列表里，发消息时自动恢复。</p>
    </>
  );
}

/** 最近 10 分钟的 CPU、内存折线，横轴按时间（窗口在后台时没有记录，线会断开一段）。鼠标移上去看某一刻的数值。 */
function LoadChart({ history }: { history: LoadPoint[] }) {
  const [hover, setHover] = useState(-1);
  const now = history.length ? history[history.length - 1].at : 0;
  const point = history[hover];
  const onMove = (event: MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setHover(nearestPoint(history, (event.clientX - box.left) / box.width, now));
  };
  const x = point ? chartX(point.at, now) * 100 : 0;
  return (
    <div className="chart">
      <div className="host-chart">
        <span className="ylab" style={{ top: 0 }}>100%</span>
        <span className="ylab" style={{ top: "50%" }}>50%</span>
        <div className="host-plot" onMouseMove={onMove} onMouseLeave={() => setHover(-1)}>
          <svg viewBox="0 0 300 100" preserveAspectRatio="none" aria-hidden="true">
            <line className="grid" x1="0" y1="0" x2="300" y2="0" />
            <line className="grid" x1="0" y1="50" x2="300" y2="50" />
            <polyline className="ln mem" points={chartPoints(history, "mem", now)} />
            <polyline className="ln cpu" points={chartPoints(history, "cpu", now)} />
          </svg>
          {history.length < 2 ? <span className="host-wait">刚开始记录，每 5 秒一个点</span> : null}
          {point ? <i className="cursor" style={{ left: `${x}%` }} /> : null}
          {point ? (
            <div className="chart-tip" role="tooltip" style={x > 55 ? { left: "auto", right: `${100 - x}%`, marginRight: 8 } : { left: `${x}%`, marginLeft: 8 }}>
              <div className="tip-title">{agoText(now - point.at)}</div>
              <div className="tip-row"><i className="cpu" /><span>CPU</span><b>{Math.round(point.cpu)}%</b></div>
              <div className="tip-row"><i className="mem" /><span>内存</span><b>{Math.round(point.mem)}%</b></div>
            </div>
          ) : null}
        </div>
      </div>
      <div className="bars-axis"><span>10 分钟前</span><span>现在</span></div>
      <div className="legend"><span><i className="cpu" />CPU</span><span><i className="mem" />内存</span></div>
    </div>
  );
}
