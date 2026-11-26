import { useState } from "react";
import { Dropdown, MenuItem } from "./Common.tsx";
import { Modal } from "./Dialogs.tsx";
import { Icon } from "./Icon.tsx";
import type { Store } from "./store.ts";

const MB = 1024 * 1024;
const GB = 1024 * MB;
/** 上限的可选值；本机记着别的值（以后改了选项）时也列出来。 */
const LIMITS = [500 * MB, GB, 2 * GB, 5 * GB, 10 * GB, 20 * GB];

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
  return `${value < 10 && value % 1 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** 设置里的「本机缓存」：位置（桌面端可改）、占用、上限、清空。从齿轮菜单打开。 */
export function CachePanel({ store }: { store: Store }) {
  const { info, busy, error } = store.cache;
  const [confirming, setConfirming] = useState(false);
  if (confirming && info) {
    return (
      <Modal title="清空本机缓存？" className="cache-panel" onClose={() => setConfirming(false)}>
        <p className="help first">会删掉 {formatBytes(info.bytes)}，之后打开会话要重新下载。</p>
        <div className="actions end">
          <button type="button" className="btn quiet" onClick={() => setConfirming(false)}>取消</button>
          <button type="button" className="btn solid danger" onClick={() => { setConfirming(false); store.clearCache(); }}>清空</button>
        </div>
      </Modal>
    );
  }
  const limits = info && !LIMITS.includes(info.limit) ? [...LIMITS, info.limit].sort((a, b) => a - b) : LIMITS;
  return (
    <Modal title="本机缓存" className="cache-panel" onClose={() => store.closeCache()}>
      <p className="help first">打开过的会话存在本机，再打开时不用重新下载。</p>
      <dl className="cache-facts">
        <dt>位置</dt>
        <dd><code>{info?.path ?? "…"}</code></dd>
        {info?.movable ? <button type="button" className="btn ghost" disabled={busy !== null} onClick={() => store.moveCache()}>{busy === "move" ? "请稍候…" : "更改…"}</button> : <span />}
        <dt>占用</dt>
        <dd>{busy === "clear" ? "正在清空…" : info ? formatBytes(info.bytes) : "…"}</dd>
        <span />
        <dt>上限</dt>
        <dd className="cache-limit">
          {info ? (
            <Dropdown label="缓存上限" align="left" button={<><span>{formatBytes(info.limit)}</span><Icon name="down" size={11} /></>}>
              {(close) => limits.map((limit) => (
                <MenuItem key={limit} label={formatBytes(limit)} checked={limit === info.limit} disabled={busy !== null} onClick={() => { close(); if (limit !== info.limit) store.setCacheLimit(limit); }} />
              ))}
            </Dropdown>
          ) : "…"}
        </dd>
        <span />
      </dl>
      {error ? <p className="help bad" role="alert">{error}</p> : null}
      <div className="actions">
        <button type="button" className="btn quiet" disabled={busy !== null || !info?.bytes} onClick={() => setConfirming(true)}>清空缓存</button>
        <button type="button" className="btn solid push" onClick={() => store.closeCache()}>完成</button>
      </div>
    </Modal>
  );
}
