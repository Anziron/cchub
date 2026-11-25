// 找前端模块之间的运行时循环导入（check.sh 的 rules 一步调用）。有循环就逐个打印，没有就什么都不输出。
// 只算会在运行时执行的导入：`import type`、全是 `type` 的花括号、动态 `import()` 不算。
// 用法：node scripts/import-cycles.mjs web/src
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "web/src");
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.tsx?$/.test(name)) files.push(path);
  }
})(root);

const STATIC = /^\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*["'](\.{1,2}\/[^"']+)["']/gm;
const typeOnly = (kind, clause) => {
  if (kind) return true;
  const braces = /^\{([\s\S]*)\}$/.exec(clause.trim());
  if (!braces) return false;
  const names = braces[1].split(",").map((s) => s.trim()).filter(Boolean);
  return names.length > 0 && names.every((n) => n.startsWith("type "));
};
const resolveImport = (from, spec) => {
  const base = resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (files.includes(candidate)) return candidate;
  }
  return null;
};

const graph = new Map(files.map((f) => [f, []]));
for (const file of files) {
  for (const m of readFileSync(file, "utf8").matchAll(STATIC)) {
    if (typeOnly(m[2], m[3])) continue;
    const target = resolveImport(file, m[4]);
    if (target) graph.get(file).push(target);
  }
}

// Tarjan 强连通分量：大于一个模块（或自己导入自己）的分量就是循环。
let index = 0;
const stack = [];
const info = new Map();
const cycles = [];
function connect(v) {
  info.set(v, { index, low: index, onStack: true });
  index++;
  stack.push(v);
  for (const w of graph.get(v)) {
    if (!info.has(w)) {
      connect(w);
      info.get(v).low = Math.min(info.get(v).low, info.get(w).low);
    } else if (info.get(w).onStack) {
      info.get(v).low = Math.min(info.get(v).low, info.get(w).index);
    }
  }
  if (info.get(v).low === info.get(v).index) {
    const group = [];
    let w;
    do {
      w = stack.pop();
      info.get(w).onStack = false;
      group.push(w);
    } while (w !== v);
    if (group.length > 1 || graph.get(v).includes(v)) cycles.push(group);
  }
}
for (const file of files) if (!info.has(file)) connect(file);

const name = (f) => relative(process.cwd(), f).replaceAll("\\", "/");
for (const group of cycles) {
  const members = new Set(group);
  const edges = [...new Set(group.flatMap((f) => graph.get(f).filter((t) => members.has(t)).map((t) => `${name(f)} → ${name(t)}`)))];
  console.log(`循环：${group.map(name).sort().join("、")}（${edges.join("；")}）`);
}
