import { invoke } from "@tauri-apps/api/core";

/** 触屏上回车换行、不自动弹键盘。 */
export const isTouch = matchMedia("(pointer: coarse)").matches;
export const isAndroid = /Android/i.test(navigator.userAgent);
/** 窄屏下会话列表是一个抽屉。 */
export const isNarrow = () => matchMedia("(max-width: 860px)").matches;

export interface BackgroundStatus {
  notificationsAllowed: boolean;
  batteryUnrestricted: boolean;
}

export const backgroundStatus = () => invoke<BackgroundStatus>("background_status");
export const requestBatteryUnrestricted = () => invoke<void>("request_battery_unrestricted");
export const takeOpenedSession = () => invoke<string | null>("take_opened_session");
