import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ClientMsg } from "./generated/ClientMsg";
import type { UiEvent } from "./generated/UiEvent";

// 前端不直接连服务器：连接在 Rust 进程里，窗口关闭后也要维持。
export const hub = {
  connect: (url: string) => invoke<void>("hub_connect", { url }),
  send: (msg: ClientMsg) => invoke<void>("hub_send", { msg }),
  onEvent: (handler: (event: UiEvent) => void): Promise<UnlistenFn> =>
    listen<UiEvent>("hub", (event) => handler(event.payload)),
};
