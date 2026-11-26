import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ClientMsg } from "./generated/ClientMsg.ts";
import type { ConnectionState } from "./generated/ConnectionState.ts";
import type { UiEvent } from "./generated/UiEvent.ts";

/** 本机缓存的位置和占用（字节）；`movable`：能不能改位置（只有桌面端）。 */
export interface CacheInfo {
  path: string;
  bytes: number;
  movable: boolean;
}

/** 本机缓存的操作：查位置和占用、清空、搬到新位置。 */
export type CacheOp = "info" | "clear" | "move";

export interface Hub {
  connect(url: string): Promise<ConnectionState>;
  send(msg: ClientMsg): Promise<void>;
  /** Rust 侧约每 16ms 合批发一次，处理函数收到一批事件。 */
  onEvent(handler: (events: UiEvent[]) => void): Promise<unknown>;
  /** 本机缓存（打开过的会话内容存在本机）。`move` 时 `dir` 是新位置；失败时抛出原因。 */
  cache(op: CacheOp, dir?: string): Promise<CacheInfo>;
}

// 前端不直接连服务器：连接在 Rust 进程里，窗口关闭后也要维持。
const tauriHub: Hub = {
  connect: (url) => invoke<ConnectionState>("hub_connect", { url }),
  send: (msg) => invoke<void>("hub_send", { msg }),
  onEvent: (handler) => listen<UiEvent[]>("hub", (event) => handler(event.payload)),
  cache: (op, dir) => invoke<CacheInfo>("hub_cache", { op, dir }),
};

export async function loadHub(): Promise<Hub | null> {
  if (isTauri()) return tauriHub;
  // 只在开发时用录制数据回放，发布包里没有这部分。
  if (import.meta.env.DEV) return (await import("./demo.ts")).demoHub;
  return null;
}
