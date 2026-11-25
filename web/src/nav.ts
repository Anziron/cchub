/** 界面上“在哪”：后退 / 前进的历史、右侧窗格、新会话页。纯逻辑，状态由 `store.ts` 持有。 */

/** 新会话页的草稿键（会话页的草稿按会话 ID）。 */
export const NEW_DRAFT = "";

export type PaneId = "changes" | "tasks" | "todos" | "plan" | "info" | "usage";
const PANES: PaneId[] = ["changes", "tasks", "todos", "plan", "info", "usage"];
/** 不依赖会话的窗格，新会话页也能打开。 */
export const GLOBAL_PANES: PaneId[] = ["usage"];

/** 本地存的窗格名，不认识的不用。 */
export const asPane = (value: string): PaneId | null => PANES.find((p) => p === value) ?? null;

const HISTORY_MAX = 50;

/**
 * 后退 / 前进的历史，像浏览器：位置是看过的会话 id，null 是新会话页。走到新位置丢掉“前进”那一截，
 * 连续重复的不记，最多记 50 个。已关闭或不存在的会话跳过，由调用方的 `open` 判断。
 */
export class History {
  private stack: (string | null)[] = [null];
  private at = 0;

  remember(id: string | null): void {
    if (this.stack[this.at] === id) return;
    this.stack = this.stack.slice(0, this.at + 1);
    this.stack.push(id);
    if (this.stack.length > HISTORY_MAX) this.stack.shift();
    this.at = this.stack.length - 1;
  }

  /** 往 `step` 方向第一个还能去的位置，没有就是 -1。 */
  private target(step: -1 | 1, open: (id: string) => boolean): number {
    for (let i = this.at + step; i >= 0 && i < this.stack.length; i += step) {
      const id = this.stack[i];
      if (id === null || open(id)) return i;
    }
    return -1;
  }

  canGo(step: -1 | 1, open: (id: string) => boolean): boolean {
    return this.target(step, open) >= 0;
  }

  /** 走一步，返回到达的位置；走不了返回 undefined。 */
  go(step: -1 | 1, open: (id: string) => boolean): string | null | undefined {
    const i = this.target(step, open);
    if (i < 0) return undefined;
    this.at = i;
    return this.stack[i];
  }
}
