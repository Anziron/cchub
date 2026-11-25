// store.ts 的测试。它经 platform.ts 在加载时读浏览器的 matchMedia，所以先补桩再动态导入。
import assert from "node:assert/strict";
import { test } from "node:test";

Object.assign(globalThis, { matchMedia: () => ({ matches: false }) });
const { describeCwd, isResumeCommand } = await import("../src/store.ts");

test("/mnt/<设备>/ 下是设备目录，其他是服务器本地目录", () => {
  assert.deepEqual(describeCwd("/mnt/laptop/work/app"), { project: "app", device: "laptop" });
  assert.deepEqual(describeCwd("/srv/tools/"), { project: "tools", device: "服务器" });
  assert.deepEqual(describeCwd("/"), { project: "/", device: "服务器" });
  assert.deepEqual(describeCwd(undefined), { project: "", device: "" });
});

test("只有单独的 /resume 由界面处理", () => {
  assert.equal(isResumeCommand(" /resume "), true);
  assert.equal(isResumeCommand("/resume abc"), false);
  assert.equal(isResumeCommand("/resumes"), false);
});
