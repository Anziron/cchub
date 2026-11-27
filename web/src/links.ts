// 文字里的网址从哪到哪。中文里网址后面常常不留空格，紧跟的全角标点和后面的字都不算网址。

const URL_RE = /https?:\/\/[^\s<>"'`，。；：！？、（）【】「」『』《》〈〉“”‘’]+/g;

/** 普通文字，或一个网址。 */
export type Piece = string | { url: string };

/** 把文字切成普通文字和网址。末尾的英文标点不算网址。 */
export function splitUrls(text: string): Piece[] {
  const pieces: Piece[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0].replace(/[.,;:!?)\]}]+$/, "");
    if (match.index > last) pieces.push(text.slice(last, match.index));
    pieces.push({ url });
    last = match.index + url.length;
  }
  if (last < text.length) pieces.push(text.slice(last));
  return pieces;
}

/**
 * marked 认出的裸网址（GFM 自动链接，原文就是网址）按同样的规则重新切：marked 一直算到空格为止，只去掉末尾的英文标点，
 * `http://…/）。下一句` 会整串变成链接。别的链接（`[文字](网址)`、`<网址>`、www. 开头的）返回 null，照原样显示。
 */
export function autolinkPieces(link: { raw: string; href: string }): Piece[] | null {
  return link.raw === link.href ? splitUrls(link.raw) : null;
}
