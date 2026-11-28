/** 截图的显示：输入框里待发的缩略图、消息里的图片、点开看大图。 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon.tsx";
import { cachedImage } from "./imageCache.ts";
import { imageSrc, type PastedImage } from "./images.ts";
import type { MessageImage } from "./model.ts";

/** 大图盖住整个窗口，点任意处或按 Esc 关掉（Esc 不再往下传，免得同时中断这一轮）。 */
function Viewer({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="image-viewer" role="dialog" aria-label="查看截图" onClick={onClose}>
      <img src={src} alt="截图" />
    </div>,
    document.body,
  );
}

/** 尺寸说明：缩小过的带上原图尺寸。放回输入框的旧截图不知道尺寸，返回空串。 */
const sizeText = (image: PastedImage): string => {
  if (!image.width) return "";
  const size = `${image.width}×${image.height}`;
  return image.originalWidth !== image.width ? `${size}（原图 ${image.originalWidth}×${image.originalHeight}，已缩小）` : size;
};

/**
 * 输入框里粘贴的截图，和拖进来的文件标签排在一行。缩略图按比例整张放下（不裁剪），
 * 鼠标停上去在上方弹出大一点的预览和尺寸；点一下看大图。
 */
export function PastedChips({ images, onRemove }: { images: PastedImage[]; onRemove: (id: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      {images.map((image) => (
        <span key={image.id} className="img-chip">
          <button type="button" className="img-open" aria-label={`查看截图 ${sizeText(image)}`.trim()} onClick={() => setOpen(imageSrc(image))}>
            <img src={imageSrc(image)} alt="" />
          </button>
          <span className="img-pop" aria-hidden="true">
            <img src={imageSrc(image)} alt="" />
            {sizeText(image) ? <em>{sizeText(image)}</em> : null}
          </span>
          <button type="button" className="img-remove" aria-label="移除" onClick={() => onRemove(image.id)}><Icon name="close" size={10} /></button>
        </span>
      ))}
      {open ? <Viewer src={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/** 消息里的截图。数据被 hubd 省掉时去本机缓存找，找不到显示占位。 */
export function MessageImages({ messageId, images }: { messageId: string; images: MessageImage[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="user-images">
      {images.map((image, i) => (
        <MessageImageView key={i} messageId={messageId} index={i} image={image} onOpen={setOpen} />
      ))}
      {open ? <Viewer src={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function MessageImageView({ messageId, index, image, onOpen }: { messageId: string; index: number; image: MessageImage; onOpen: (src: string) => void }) {
  // undefined：还在找；null：本机没有。
  const [found, setFound] = useState<MessageImage | null | undefined>(image.data ? image : undefined);
  useEffect(() => {
    if (image.data) {
      setFound(image);
      return;
    }
    let live = true;
    void cachedImage(messageId, index).then((hit) => {
      if (live) setFound(hit);
    });
    return () => {
      live = false;
    };
  }, [messageId, index, image]);
  if (!found) {
    return (
      <span className="img-placeholder" title={found === null ? "这张截图只存在发送它的设备上，这里看不到" : undefined}>
        <Icon name="image" size={13} />图片
      </span>
    );
  }
  const src = imageSrc(found);
  return (
    <button type="button" className="img-thumb" aria-label="查看截图" onClick={() => onOpen(src)}>
      <img src={src} alt="截图" />
    </button>
  );
}
