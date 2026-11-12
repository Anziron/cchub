// 消息区贴底检查（由 scroll-check.ps1 调用）：经 CDP 连无头 Edge 上的 demo `?s=long`，
// 读首次打开（事件分批到达）、切到别的会话再切回、真实滚轮往上之后的离底距离。
// 期望：前两项最终为 0；滚轮往上后保持非 0（用户往上翻不被拉回）。
const port = process.argv[2] ?? "9333";
const rounds = Number(process.argv[3] ?? 5);
const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const run = async (expr) => {
  const m = await send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  return m.result?.result?.value ?? m.result?.exceptionDetails?.exception?.description;
};
const helpers = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const gap = () => { const s = document.querySelector('.stream'); return s ? Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) : 'no-stream'; };
  const row = (t) => [...document.querySelectorAll('button.row.session')].find((b) => b.title.split('\\n')[0] === t);
  const watch = async () => { const at = [50, 150, 300, 600, 1200, 2000]; const out = []; let prev = 0; for (const ms of at) { await sleep(ms - prev); prev = ms; out.push(ms + 'ms:' + gap()); } return out.join(' '); };
`;
await new Promise((r) => setTimeout(r, 3000));
console.log("首次打开:", await run(`${helpers} return await watch();`));
for (let n = 0; n < rounds; n++) {
  console.log(`切回 #${n + 1}:`, await run(`${helpers}
    const other = document.querySelector('button.row.session:not(.current)'); if (!other) return 'no other row';
    other.click(); await sleep(400);
    [...document.querySelectorAll('button.row.more')].find((b) => b.textContent.includes('显示更多'))?.click(); await sleep(100);
    const back = row('长会话'); if (!back) return 'no long row'; back.click();
    return await watch();`));
}
const box = await run(`const r = document.querySelector('.stream').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];`);
for (let k = 0; k < 3; k++) await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box[0], y: box[1], deltaX: 0, deltaY: -400 });
console.log("滚轮往上后:", await run(`${helpers} return await watch();`));
// “回到底部”按钮：往上翻后出现，截图留档，点击后回到底部并消失。
console.log("按钮:", await run(`return document.querySelector('.to-bottom') ? '出现' : '没有';`));
const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 80 });
if (shot.result?.data) {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(".cc/shots", { recursive: true });
  const file = `.cc/shots/to-bottom-${process.argv[4] ?? "light"}-${Date.now()}.jpg`;
  writeFileSync(file, Buffer.from(shot.result.data, "base64"));
  console.log("截图:", file);
}
console.log("点击按钮后:", await run(`${helpers}
  document.querySelector('.to-bottom')?.click();
  const g = await watch();
  return g + (document.querySelector('.to-bottom') ? ' 按钮仍在' : ' 按钮已消失');`));
ws.close();
