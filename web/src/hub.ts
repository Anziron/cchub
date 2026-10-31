import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ClientMsg } from "./generated/ClientMsg";
import type { ConnectionState } from "./generated/ConnectionState";
import type { UiEvent } from "./generated/UiEvent";

export interface Hub {
  connect(url: string): Promise<ConnectionState>;
  send(msg: ClientMsg): Promise<void>;
  onEvent(handler: (event: UiEvent) => void): Promise<unknown>;
}

// 前端不直接连服务器：连接在 Rust 进程里，窗口关闭后也要维持。
const tauriHub: Hub = {
  connect: (url) => invoke<ConnectionState>("hub_connect", { url }),
  send: (msg) => invoke<void>("hub_send", { msg }),
  onEvent: (handler) => listen<UiEvent>("hub", (event) => handler(event.payload)),
};

export async function loadHub(): Promise<Hub | null> {
  if (isTauri()) return tauriHub;
  // 只在开发时用录制数据回放，发布包里没有这部分。
  if (import.meta.env.DEV) return (await import("./demo")).demoHub;
  return null;
}
