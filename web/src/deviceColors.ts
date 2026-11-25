import type { CSSProperties } from "react";
import { assignDeviceColors, DEVICE_COLORS, deviceList, deviceOf, SERVER_GROUP } from "./sidebar.ts";
import type { Store } from "./store.ts";

/** 颜色编号转成 CSS 变量（色相、饱和度），明度由样式按主题定（light-dark）。 */
export function deviceColorVars(index: number): CSSProperties {
  const [h, s] = DEVICE_COLORS[index] ?? DEVICE_COLORS[0]!;
  return { "--chip-h": h, "--chip-s": `${s}%` } as CSSProperties;
}

/** 所有设备名（登记的 + 服务器 + 有会话的）及各自的颜色编号。设备集合不随筛选变化，颜色就不会跟着筛选跳。 */
export function deviceColorMap(store: Store): Map<string, number> {
  const all = [...store.sessions.values()].filter((s) => !s.archived);
  return assignDeviceColors([...deviceList(store.devices, all).map((d) => d.name), SERVER_GROUP, ...all.map((s) => deviceOf(s.cwd))]);
}
