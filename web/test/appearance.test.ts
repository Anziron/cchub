// 外观设置的解析、旧值兼容和“跟随系统”。运行：node --test web/test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadAppearance, parseFont, parseSize, parseTheme, resolveTheme, saveAppearance } from "../src/appearance.ts";

const fakeStorage = (init: Record<string, string> = {}) => {
  const data = { ...init };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => { data[k] = v; },
  };
};

test("旧的 light / dark 值继续可用", () => {
  assert.equal(parseTheme("light"), "light");
  assert.equal(parseTheme("dark"), "dark");
});

test("非法或缺失的值回落到默认", () => {
  assert.equal(parseTheme("neon"), "system");
  assert.equal(parseTheme(null), "system");
  assert.equal(parseFont("comic"), "serif");
  assert.equal(parseFont(null), "serif");
  assert.equal(parseSize("huge"), "md");
  assert.equal(parseSize(null), "md");
});

test("各主题对应的 tone", () => {
  assert.deepEqual(resolveTheme("light", true), { theme: "light", tone: "light" });
  assert.deepEqual(resolveTheme("dark", false), { theme: "dark", tone: "dark" });
  assert.deepEqual(resolveTheme("black", false), { theme: "black", tone: "dark" });
  assert.deepEqual(resolveTheme("eye", true), { theme: "eye", tone: "light" });
  assert.deepEqual(resolveTheme("cool", true), { theme: "cool", tone: "light" });
  assert.deepEqual(resolveTheme("navy", false), { theme: "navy", tone: "dark" });
});

test("跟随系统：系统深色解析为 dark，浅色解析为 light", () => {
  assert.deepEqual(resolveTheme("system", true), { theme: "dark", tone: "dark" });
  assert.deepEqual(resolveTheme("system", false), { theme: "light", tone: "light" });
});

test("读写本地存储，异常时不抛错", () => {
  const s = fakeStorage({ "cchub.theme": "navy", "cchub.font": "kai", "cchub.size": "lg" });
  assert.deepEqual(loadAppearance(s), { theme: "navy", font: "kai", size: "lg" });
  assert.deepEqual(loadAppearance(fakeStorage({ "cchub.theme": "dark" })), { theme: "dark", font: "serif", size: "md" });
  const w = fakeStorage();
  saveAppearance(w, { theme: "eye", font: "mono", size: "sm" });
  assert.deepEqual(w.data, { "cchub.theme": "eye", "cchub.font": "mono", "cchub.size": "sm" });
  const broken = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } };
  assert.deepEqual(loadAppearance(broken), { theme: "system", font: "serif", size: "md" });
  assert.doesNotThrow(() => saveAppearance(broken, { theme: "light", font: "serif", size: "md" }));
});
