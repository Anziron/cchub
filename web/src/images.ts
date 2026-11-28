/**
 * 输入框里粘贴的截图：从剪贴板取出，长边超过上限先缩小，编码成 base64 跟着消息发给 claude（见 model.ts 的 `userLine`）。
 * 图片不存成文件、不经过挂载，所以消息发出去以后设备断开也不影响模型看图。
 */
import type { MessageImage } from "./model.ts";

export interface PastedImage extends MessageImage {
  id: string;
  width: number;
  height: number;
  /** 缩小前的尺寸；没缩小时和 width、height 相同。 */
  originalWidth: number;
  originalHeight: number;
}

/** 长边上限：再大模型那边也会缩小，先缩小少传很多数据。 */
export const MAX_EDGE = 2000;
/** 单张图编码前的上限：Claude 限制单张 5MB，base64 还会再大三分之一。 */
export const MAX_BYTES = 3.5 * 1024 * 1024;
/**
 * 一条消息里所有图片的 base64 总长上限。hubd 把整条消息作为一行写进 claude 的 FIFO，一行最多约 1MB
 * （管道 1MB 减 8KB 预留，见 server/src/session.rs 的 `write_whole`），超了整条被拒，界面提示“消息太长或格式不对”。
 * 留出文字和 JSON 的余量；发送时再减去文字的长度（`imageBudget`）。微信里复制的原图常有 1MB 以上。
 */
export const MESSAGE_IMAGE_BUDGET = 960 * 1024;

/** 一条消息里图片还能用多少 base64 字符：总上限减去文字（按 UTF-8 字节算）。 */
export const imageBudget = (text: string): number => Math.max(0, MESSAGE_IMAGE_BUDGET - new TextEncoder().encode(text).length);

/** 这几种格式模型直接认，没超限就原样发。 */
const DIRECT = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/**
 * 剪贴板里要当截图处理的图片。同时带纯文字的按文字粘贴，返回空：
 * Excel、WPS 复制单元格，Word 复制文字，都会顺带一张图。
 */
export function clipboardImages(data: DataTransfer | null): File[] {
  if (!data || data.getData("text/plain")) return [];
  return [...data.items]
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file);
}

/** 按长边上限缩放后的尺寸（不放大）。 */
export function fitSize(width: number, height: number, max = MAX_EDGE): { width: number; height: number } {
  const k = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** 读图、按需缩小和转码。读不出来（不是图片、格式不支持）时抛错。 */
export async function prepareImage(file: Blob): Promise<PastedImage> {
  const bitmap = await createImageBitmap(file);
  try {
    const originalWidth = bitmap.width;
    const originalHeight = bitmap.height;
    const size = fitSize(originalWidth, originalHeight);
    let blob: Blob = file;
    if (size.width !== originalWidth || !DIRECT.includes(file.type) || file.size > MAX_BYTES) {
      const canvas = new OffscreenCanvas(size.width, size.height);
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, size.width, size.height);
      blob = await canvas.convertToBlob({ type: "image/png" });
      // 照片类的大图 PNG 压不小，换成 JPEG，质量逐步降到不超限。
      for (const quality of [0.9, 0.8, 0.65]) {
        if (blob.size <= MAX_BYTES) break;
        blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
      }
    }
    const image: PastedImage = { id: crypto.randomUUID(), mediaType: blob.type, data: await toBase64(blob), ...size, originalWidth, originalHeight };
    // 单张就放不进一条消息的（如微信复制的原图）先压到放得下，缩略图上显示的就是最后发出去的尺寸。
    return image.data.length > MESSAGE_IMAGE_BUDGET ? await shrink(image, MESSAGE_IMAGE_BUDGET) : image;
  } finally {
    bitmap.close();
  }
}

/**
 * 一条消息里的图片加起来超过 `budget`（base64 字符数）时，按张数平分重新压缩；没超就原样返回。
 * 压缩先降 JPEG 质量，再缩小尺寸；怎么压都放不下时抛错。
 */
export async function fitImages<T extends MessageImage>(images: T[], budget: number): Promise<T[]> {
  const total = images.reduce((sum, image) => sum + image.data.length, 0);
  if (total <= budget) return images;
  const each = Math.floor(budget / images.length);
  return Promise.all(images.map((image) => (image.data.length <= each ? image : shrink(image, each))));
}

/** 压到 base64 不超过 `limit` 个字符：JPEG（透明处垫白底），质量 0.85 → 0.55，尺寸逐步缩到 0.3 倍。 */
async function shrink<T extends MessageImage>(image: T, limit: number): Promise<T> {
  const bitmap = await createImageBitmap(fromBase64(image.data, image.mediaType));
  try {
    for (const scale of [1, 0.8, 0.64, 0.5, 0.4, 0.3]) {
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) break;
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      for (const quality of [0.85, 0.7, 0.55]) {
        const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
        // base64 是原始字节的 4/3。
        if (Math.ceil(blob.size / 3) * 4 <= limit) {
          return { ...image, mediaType: "image/jpeg", data: await toBase64(blob), ...("width" in image ? { width, height } : {}) };
        }
      }
    }
  } finally {
    bitmap.close();
  }
  throw new Error("截图太大，压缩后也放不进一条消息");
}

function fromBase64(data: string, type: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  // 分段拼：一次展开几 MB 的数组会超出参数个数上限。
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export const imageSrc = (image: MessageImage): string => `data:${image.mediaType};base64,${image.data}`;
