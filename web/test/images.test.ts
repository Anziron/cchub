// 输入框粘贴的截图：发出去的消息格式、回传确认、排队合并、缩放尺寸、本机缓存。运行：node --test web/test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheImages, cachedImage, overLimit } from "../src/imageCache.ts";
import { clipboardImages, fitImages, fitSize, imageBudget, MAX_EDGE, MESSAGE_IMAGE_BUDGET } from "../src/images.ts";
import { addSending, apply, newThread, userLine, type MessageImage } from "../src/model.ts";
import { joinQueued, joinQueuedImages, settleCancel, type Queued } from "../src/queue.ts";

const shot: MessageImage = { mediaType: "image/png", data: "iVBORw0KGgo" };

test("带截图的消息：内容是图片在前、文字在后的数组；没截图时还是纯文字", () => {
  const line = JSON.parse(userLine("看看这个", "u1", [shot]));
  assert.equal(line.uuid, "u1");
  assert.deepEqual(line.message.content, [
    { type: "image", source: { type: "base64", media_type: "image/png", data: shot.data } },
    { type: "text", text: "看看这个" },
  ]);
  assert.deepEqual(JSON.parse(userLine("", "u2", [shot])).message.content, [{ type: "image", source: { type: "base64", media_type: "image/png", data: shot.data } }]);
  assert.equal(JSON.parse(userLine("只有字", "u3", [])).message.content, "只有字");
});

test("带截图的消息回传后按 uuid 确认送达，不多出一条", () => {
  const thread = newThread();
  addSending(thread, "u1", "看看这个", [shot]);
  apply(thread, JSON.stringify({ type: "user", uuid: "u1", isReplay: true, message: JSON.parse(userLine("看看这个", "u1", [shot])).message }));
  assert.deepEqual(thread.items, [{ kind: "user", id: "u1", text: "看看这个", images: [shot] }]);
  assert.equal(thread.phase, "thinking");
});

test("回传的大图被 hubd 省掉：发送的这台沿用本地那份；重新打开时是空数据（界面去本机缓存找）", () => {
  const elided = JSON.stringify({
    type: "user",
    uuid: "u1",
    message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "" }, cchub_omitted: 90000 }, { type: "text", text: "看看" }] },
  });
  const live = newThread();
  addSending(live, "u1", "看看", [shot]);
  apply(live, elided);
  assert.deepEqual(live.items, [{ kind: "user", id: "u1", text: "看看", images: [shot] }]);

  const reopened = newThread();
  apply(reopened, elided);
  assert.deepEqual(reopened.items, [{ kind: "user", id: "u1", text: "看看", images: [{ mediaType: "image/png", data: "" }] }]);
});

test("子代理和工具结果里的图片不算用户截图", () => {
  const thread = newThread();
  apply(thread, JSON.stringify({ type: "user", uuid: "s1", parent_tool_use_id: "t1", message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: shot.data } }] } }));
  apply(thread, JSON.stringify({ type: "user", uuid: "s2", isMeta: true, message: { role: "user", content: [{ type: "text", text: "注入" }, { type: "image", source: { type: "base64", media_type: "image/png", data: shot.data } }] } }));
  assert.deepEqual(thread.items, []);
});

test("排队的消息合成一条时截图按顺序合在一起；撤回来不及时截图还在", () => {
  const other: MessageImage = { mediaType: "image/jpeg", data: "/9j/4AAQ" };
  const queue: Queued[] = [
    { id: "a", text: "第一条", images: [shot], mode: "wait" },
    { id: "b", text: "", images: [other], mode: "wait" },
    { id: "c", text: "第三条", mode: "wait" },
  ];
  assert.equal(joinQueued(queue), "第一条\n\n第三条");
  assert.deepEqual(joinQueuedImages(queue), [shot, other]);
  const late = settleCancel([{ id: "i", text: "插入", images: [shot], mode: "insert", delivered: true }], "i", false);
  assert.deepEqual(late, [{ id: "i", text: "插入", images: [shot], mode: "insert", delivered: true, late: true }]);
});

test("长边超过上限按比例缩小，小图不放大", () => {
  assert.deepEqual(fitSize(3840, 2160), { width: MAX_EDGE, height: 1125 });
  assert.deepEqual(fitSize(1000, 4000), { width: 500, height: MAX_EDGE });
  assert.deepEqual(fitSize(800, 600), { width: 800, height: 600 });
});

test("剪贴板同时带文字时按文字粘贴，不当截图", () => {
  const file = { name: "shot.png" } as unknown as File;
  const clipboard = (text: string, type = "image/png") =>
    ({ getData: () => text, items: [{ kind: "file", type, getAsFile: () => file }] }) as unknown as DataTransfer;
  assert.deepEqual(clipboardImages(clipboard("")), [file]);
  assert.deepEqual(clipboardImages(clipboard("A1\tB1")), []);
  assert.deepEqual(clipboardImages(clipboard("", "application/pdf")), []);
  assert.deepEqual(clipboardImages(null), []);
});

test("本机缓存超过上限从最旧的删起，删到回到上限以内", () => {
  const metas = [{ key: "old", size: 60 }, { key: "mid", size: 50 }, { key: "new", size: 40 }];
  assert.deepEqual(overLimit(metas, 200), []);
  assert.deepEqual(overLimit(metas, 100), ["old"]);
  assert.deepEqual(overLimit(metas, 30), ["old", "mid", "new"]);
});

test("没有 IndexedDB 时缓存只在内存里，按消息 ID 和序号取回", async () => {
  await cacheImages("m1", [shot, { mediaType: "image/jpeg", data: "/9j/" }]);
  assert.deepEqual(await cachedImage("m1", 1), { mediaType: "image/jpeg", data: "/9j/" });
  assert.equal(await cachedImage("m1", 2), null);
  assert.equal(await cachedImage("m2", 0), null);
});

test("一条消息里图片的预算：总上限减去文字的 UTF-8 字节数，不会是负数", () => {
  assert.equal(imageBudget(""), MESSAGE_IMAGE_BUDGET);
  assert.equal(imageBudget("abc"), MESSAGE_IMAGE_BUDGET - 3);
  assert.equal(imageBudget("截图"), MESSAGE_IMAGE_BUDGET - 6);
  assert.equal(imageBudget("字".repeat(400_000)), 0);
  // hubd 一行最多 1MB 减 8KB 预留，预算要留出文字和 JSON 的余量。
  assert.ok(MESSAGE_IMAGE_BUDGET < 1024 * 1024 - 8192 - 32 * 1024);
});

test("图片总量没超预算时原样返回，不重新压缩", async () => {
  const images = [shot, { mediaType: "image/jpeg", data: "/9j/4AAQ" }];
  assert.equal(await fitImages(images, 1000), images);
  assert.deepEqual(await fitImages([], 0), []);
});
