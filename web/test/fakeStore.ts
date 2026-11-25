// store.ts 测试用的脚手架：浏览器全局的桩和假 hub。
// 要在导入 store.ts 之前导入：platform.ts 加载时就读 matchMedia，Store 建立时读 localStorage。
import type { Hub } from "../src/hub.ts";

class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  clear(): void {
    this.items.clear();
  }
}

export const storage = new MemoryStorage();
const globals = {
  localStorage: storage,
  matchMedia: () => ({ matches: false }),
  // 界面刷新不在测试范围内：不执行回调。
  requestAnimationFrame: () => 1,
};
for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

type Msg = Parameters<Hub["send"]>[0];
type Input = Extract<Msg, { type: "input" }> & { body: any };

/** 假 hub：记下发出的消息，测试用 `emit` 推事件、用 `ack` 回执。 */
export function fakeHub() {
  const sent: Msg[] = [];
  let handler: (events: unknown[]) => void = () => {};
  let failing = false;
  const hub = {
    connect: async () => "connected" as const,
    send: async (msg: Msg) => {
      if (failing) throw new Error("连接已断开");
      sent.push(msg);
    },
    onEvent: async (h: (events: unknown[]) => void) => {
      handler = h;
    },
  };
  const inputs = (): Input[] => sent.flatMap((m) => (m.type === "input" ? [{ ...m, body: JSON.parse(m.line) }] : []));
  return {
    hub: hub as unknown as Hub,
    sent,
    inputs,
    /** 发出的用户消息。 */
    users: () => inputs().filter((m) => m.body.type === "user"),
    /** 发出的某种控制消息（`set_model`、`apply_flag_settings`、`initialize`…）。 */
    controls: (subtype: string) => inputs().filter((m) => m.body.type === "control_request" && m.body.request.subtype === subtype),
    /** 对卡片的回复。 */
    replies: () => inputs().filter((m) => m.body.type === "control_response"),
    of: (type: string) => sent.filter((m) => m.type === type) as any[],
    emit: (...events: unknown[]) => handler(events),
    ack: (input: Input, error: string | null = null) => handler([{ type: "ack", session: input.session, id: input.id, error }]),
    failSends: (on: boolean) => {
      failing = on;
    },
  };
}

/** 等发送失败的回调跑完（`hub.send` 是异步的）。 */
export const settle = () => new Promise((resolve) => setImmediate(resolve));

export const sessionInfo = (id: string, running: boolean, extra: object = {}) => ({
  id,
  title: "测试",
  cwd: "/work",
  running,
  updated: 100,
  archived: false,
  active: 100,
  ...extra,
});

export const event = (session: string, seq: number, payload: string) => ({ type: "event", session, class: "durable", seq, payload });
