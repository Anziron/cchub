// 外观：配色、正文字体、字号的选项、解析和本地存储（纯函数，不碰 DOM）。
export type ThemeId = "light" | "dark" | "black" | "eye" | "cool" | "navy";
export type FontId = "serif" | "sans" | "kai" | "mono";
export type SizeId = "sm" | "md" | "lg";
export type Tone = "light" | "dark";
export type Appearance = { theme: ThemeId; font: FontId; size: SizeId };
export type KV = { getItem(key: string): string | null; setItem(key: string, value: string): void };

export const DEFAULT_APPEARANCE: Appearance = { theme: "light", font: "serif", size: "md" };

// swatch：[背景, 文字, 强调色]，只用于面板里的色块预览
export const THEMES: { id: ThemeId; label: string; swatch: [string, string, string] }[] = [
  { id: "light", label: "浅色", swatch: ["#faf9f5", "#1f1e1d", "#c6613f"] },
  { id: "dark", label: "深色", swatch: ["#262624", "#e8e5db", "#d97757"] },
  { id: "black", label: "纯黑", swatch: ["#000000", "#e6e6e6", "#e08a6a"] },
  { id: "eye", label: "护眼", swatch: ["#dce8d5", "#26352b", "#356040"] },
  { id: "cool", label: "冷灰", swatch: ["#f1f4f8", "#1c2430", "#2f5fa8"] },
  { id: "navy", label: "午夜蓝", swatch: ["#0e1a2e", "#dbe5f2", "#6cc3d5"] },
];
export const FONTS: { id: FontId; label: string }[] = [
  { id: "serif", label: "宋体" },
  { id: "sans", label: "黑体" },
  { id: "kai", label: "楷体" },
  { id: "mono", label: "等宽" },
];
export const SIZES: { id: SizeId; label: string }[] = [
  { id: "sm", label: "小" },
  { id: "md", label: "中" },
  { id: "lg", label: "大" },
];

const DARK_THEMES: ThemeId[] = ["dark", "black", "navy"];

const pick = <T extends string>(list: { id: T }[], raw: string | null, fallback: T): T =>
  list.find((o) => o.id === raw)?.id ?? fallback;

/** 旧版本有“跟随系统”（存的值是 `system`）：读取时按当时的系统深浅色转成具体主题。 */
export const parseTheme = (raw: string | null, systemDark = false): ThemeId =>
  raw === "system" ? (systemDark ? "dark" : "light") : pick(THEMES, raw, DEFAULT_APPEARANCE.theme);
export const parseFont = (raw: string | null) => pick(FONTS, raw, DEFAULT_APPEARANCE.font);
export const parseSize = (raw: string | null) => pick(SIZES, raw, DEFAULT_APPEARANCE.size);

// 给出主题的深浅色调
export function resolveTheme(theme: ThemeId): { theme: ThemeId; tone: Tone } {
  return { theme, tone: DARK_THEMES.includes(theme) ? "dark" : "light" };
}

const read = (s: KV, key: string) => {
  try { return s.getItem(key); } catch { return null; }
};

export function loadAppearance(s: KV, systemDark = false): Appearance {
  return {
    theme: parseTheme(read(s, "cchub.theme"), systemDark),
    font: parseFont(read(s, "cchub.font")),
    size: parseSize(read(s, "cchub.size")),
  };
}

export function saveAppearance(s: KV, a: Appearance) {
  try {
    s.setItem("cchub.theme", a.theme);
    s.setItem("cchub.font", a.font);
    s.setItem("cchub.size", a.size);
  } catch { /* 存储不可用时只在本次生效 */ }
}
