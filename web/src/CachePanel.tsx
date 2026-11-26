import { useState } from "react";
import { Modal } from "./Dialogs.tsx";
import type { Store } from "./store.ts";

/** 字节数写成好读的大小。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** 设置里的「本机缓存」：位置和占用、清空、改位置（只有桌面端）。从齿轮菜单打开。 */
export function CachePanel({ store }: { store: Store }) {
  const { info, busy, error } = store.cache;
  const [dir, setDir] = useState("");
  const [confirming, setConfirming] = useState(false);
  const move = () => {
    if (dir.trim() && !busy) store.moveCache(dir.trim());
  };
  return (
    <Modal title="本机缓存" className="cache-panel" onClose={() => store.closeCache()}>
      <p className="help first">
        打开过的会话存在这台设备上：重启、刷新或从托盘重开后，先显示本机已有的部分，再从服务器补上新增的。
        服务器清理掉的会话，这里也跟着删；总量超过 2 GB 时先删最久没打开的。内容没有加密。
      </p>
      <dl className="cache-facts">
        <dt>位置</dt>
        <dd><code>{info?.path ?? "…"}</code></dd>
        <dt>占用</dt>
        <dd>{busy === "clear" ? "正在清空…" : info ? formatBytes(info.bytes) : "…"}</dd>
      </dl>
      {info?.movable ? (
        <form className="cache-move" onSubmit={(event) => { event.preventDefault(); move(); }}>
          <label className="field">
            <span>更改位置（空文件夹或还不存在的路径，现有缓存会搬过去）</span>
            <input spellCheck={false} autoCapitalize="none" placeholder="D:\cchub-cache" value={dir} onChange={(event) => setDir(event.target.value)} />
          </label>
          <button className="btn ghost" disabled={!dir.trim() || busy !== null}>{busy === "move" ? "正在搬…" : "搬过去"}</button>
        </form>
      ) : null}
      {error ? <p className="help bad" role="alert">{error}</p> : null}
      <div className="actions end">
        {confirming ? (
          <>
            <span className="help cache-confirm">清空后再打开会话要重新下载，确定？</span>
            <button type="button" className="btn quiet" onClick={() => setConfirming(false)}>取消</button>
            <button type="button" className="btn solid" onClick={() => { setConfirming(false); store.clearCache(); }}>清空</button>
          </>
        ) : (
          <>
            <button type="button" className="btn quiet" disabled={busy !== null || !info?.bytes} onClick={() => setConfirming(true)}>清空缓存</button>
            <button type="button" className="btn solid" onClick={() => store.closeCache()}>完成</button>
          </>
        )}
      </div>
    </Modal>
  );
}
