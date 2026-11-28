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
    return { id: crypto.randomUUID(), mediaType: blob.type, data: await toBase64(blob), ...size, originalWidth, originalHeight };
  } finally {
    bitmap.close();
  }
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  // 分段拼：一次展开几 MB 的数组会超出参数个数上限。
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export const imageSrc = (image: MessageImage): string => `data:${image.mediaType};base64,${image.data}`;
