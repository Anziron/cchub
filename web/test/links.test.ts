// 文字里的网址：中文里网址后面常常不留空格，紧跟的中文标点和后面的字不算网址。运行：node --test web/test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { marked, type Tokens } from "marked";
import { autolinkPieces, splitUrls } from "../src/links.ts";

const autolink = (text: string) => marked.lexer(text)[0] as Tokens.Paragraph;

test("marked 认出的裸网址在中文标点处截断，后面的字还是文字", () => {
  const link = autolink("面板地址 http://a.example:8790/）。下一句").tokens.find((t) => t.type === "link") as Tokens.Link;
  assert.deepEqual(autolinkPieces(link), [{ url: "http://a.example:8790/" }, "）。下一句"]);
});

test("顿号、问号、书名号、引号也是网址的边界", () => {
  assert.deepEqual(splitUrls("见 https://a.example/x、「https://b.example/y」？"),
    ["见 ", { url: "https://a.example/x" }, "、「", { url: "https://b.example/y" }, "」？"]);
});
