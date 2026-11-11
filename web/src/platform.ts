import { invoke, isTauri } from "@tauri-apps/api/core";

export const isWebUrl = (url: string) => /^https?:\/\//i.test(url.trim());

/** 用系统浏览器打开网页链接。桌面端走 `open_url` 命令；手机端和开发时的浏览器用 `window.open`。 */
export function openUrl(url: string): void {
  if (!isWebUrl(url)) return;
  if (isTauri() && !isAndroid) void invoke("open_url", { url }).catch(() => window.open(url, "_blank", "noopener"));
  else window.open(url, "_blank", "noopener");
}

/** 触屏上回车换行、不自动弹键盘。 */
export const isTouch = matchMedia("(pointer: coarse)").matches;
export const isAndroid = /Android/i.test(navigator.userAgent);
/**
 * 窗口看得见（没最小化、没缩到托盘、没被完全挡住）。读秒和动画按这个暂停，不按焦点：
 * 用户常把 cchub 放在旁边看着、焦点在别的窗口。
 */
export const pageVisible = () => document.visibilityState === "visible";
/** 窄屏下会话列表是一个抽屉。 */
export const isNarrow = () => matchMedia("(max-width: 860px)").matches;

export interface BackgroundStatus {
  notificationsAllowed: boolean;
  batteryUnrestricted: boolean;
}

export const backgroundStatus = () => invoke<BackgroundStatus>("background_status");
export const requestBatteryUnrestricted = () => invoke<void>("request_battery_unrestricted");
export const takeOpenedSession = () => invoke<string | null>("take_opened_session");
