/**
 * 发出去的截图在本机存一份（IndexedDB）。大图回传时 hubd 会省掉图片数据（见 model.ts 的 `MessageImage`），
 * 重新打开会话时按消息 ID 和序号找回来显示；别的设备上没有这份，显示占位。总量超过上限删最旧的。
 * 浏览器没有 IndexedDB（如 node 跑测试）时只记在内存里。
 */
import type { MessageImage } from "./model.ts";

const DB_NAME = "cchub-images";
/** 本机缓存的总量上限（按 base64 长度算）。 */
export const CACHE_LIMIT = 200 * 1024 * 1024;

interface Meta {
  key: string;
  size: number;
  at: number;
}

const keyOf = (messageId: string, index: number) => `${messageId}#${index}`;
/** 这次打开期间用过的，免得每次重画都去读库。 */
const memory = new Map<string, MessageImage>();
let opening: Promise<IDBDatabase | null> | undefined;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  opening ??= new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("images");
      db.createObjectStore("meta", { keyPath: "key" }).createIndex("at", "at");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  return opening;
}

const finished = (tx: IDBTransaction) =>
  new Promise<void>((resolve) => {
    tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
  });

/** 消息发出时存下它的截图。存不了（存储满、被禁用）就算了，只是重新打开后看不到缩略图。 */
export async function cacheImages(messageId: string, images: MessageImage[]): Promise<void> {
  images.forEach((image, i) => memory.set(keyOf(messageId, i), image));
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(["images", "meta"], "readwrite");
    const at = Date.now();
    images.forEach((image, i) => {
      const key = keyOf(messageId, i);
      tx.objectStore("images").put({ mediaType: image.mediaType, data: image.data }, key);
      tx.objectStore("meta").put({ key, size: image.data.length, at } satisfies Meta);
    });
    await finished(tx);
    await prune(db);
  } catch {
    // 同上：缓存失败不影响发送。
  }
}

/** 按时间从旧到新排好的记录里，要删掉哪些才能回到上限以内（最旧的先删）。 */
export function overLimit(metas: { key: string; size: number }[], limit = CACHE_LIMIT): string[] {
  let total = metas.reduce((sum, meta) => sum + meta.size, 0);
  const drop: string[] = [];
  for (const meta of metas) {
    if (total <= limit) break;
    drop.push(meta.key);
    total -= meta.size;
  }
  return drop;
}

async function prune(db: IDBDatabase): Promise<void> {
  const metas = await new Promise<Meta[]>((resolve) => {
    const request = db.transaction("meta").objectStore("meta").index("at").getAll();
    request.onsuccess = () => resolve(request.result as Meta[]);
    request.onerror = () => resolve([]);
  });
  const drop = overLimit(metas);
  if (!drop.length) return;
  const tx = db.transaction(["images", "meta"], "readwrite");
  for (const key of drop) {
    tx.objectStore("images").delete(key);
    tx.objectStore("meta").delete(key);
    memory.delete(key);
  }
  await finished(tx);
}

/** 找本机存的那张；没有返回 null。 */
export async function cachedImage(messageId: string, index: number): Promise<MessageImage | null> {
  const key = keyOf(messageId, index);
  const hit = memory.get(key);
  if (hit) return hit;
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const request = db.transaction("images").objectStore("images").get(key);
      request.onsuccess = () => {
        const image = request.result as MessageImage | undefined;
        if (image) memory.set(key, image);
        resolve(image ?? null);
      };
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
