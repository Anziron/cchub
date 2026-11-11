// 拖进输入框的文件路径怎么转成服务器能读的引用。运行：node --test web/test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { dropRef, mentionText } from "../src/paths.ts";

const cwd = "/mnt/pc-company/d/cchub";

test("项目内的 Windows 路径转成相对项目的路径，盘符和大小写不敏感", () => {
  assert.deepEqual(dropRef("D:\\cchub\\web\\src\\App.tsx", cwd), { path: "web/src/App.tsx", reachable: true });
  assert.deepEqual(dropRef("d:\\CCHub\\README.md", cwd), { path: "README.md", reachable: true });
});

test("拖入项目目录本身得到 .", () => {
  assert.deepEqual(dropRef("D:\\cchub", cwd), { path: ".", reachable: true });
});

test("项目外的文件保留原路径并标记服务器读不到", () => {
  assert.deepEqual(dropRef("C:\\Users\\me\\a.txt", cwd), { path: "C:\\Users\\me\\a.txt", reachable: false });
  // 名字前缀相同但不是子目录。
  assert.deepEqual(dropRef("D:\\cchub2\\a.txt", cwd), { path: "D:\\cchub2\\a.txt", reachable: false });
});

test("macOS / Linux 设备上的路径按 /mnt/<设备><路径> 对应，区分大小写", () => {
  const mac = "/mnt/mac/Users/me/proj";
  assert.deepEqual(dropRef("/Users/me/proj/src/a.ts", mac), { path: "src/a.ts", reachable: true });
  assert.deepEqual(dropRef("/Users/me/Proj/src/a.ts", mac), { path: "/Users/me/Proj/src/a.ts", reachable: false });
});

test("服务器上的项目（不在 /mnt 下）只认完全相同的路径前缀", () => {
  assert.deepEqual(dropRef("/root/work/x.py", "/root/work"), { path: "x.py", reachable: true });
  assert.deepEqual(dropRef("D:\\x.py", "/root/work"), { path: "D:\\x.py", reachable: false });
});

test("没有工作区时原样保留", () => {
  assert.deepEqual(dropRef("D:\\a\\b.txt", undefined), { path: "D:\\a\\b.txt", reachable: false });
});

test("发送时以 @路径 拼在正文前，含空格的路径加引号", () => {
  assert.equal(mentionText(["web/src/App.tsx", "docs/a b.md"], "看看这两个"), '@web/src/App.tsx @"docs/a b.md"\n\n看看这两个');
  assert.equal(mentionText([], "hi"), "hi");
  assert.equal(mentionText(["a.ts"], ""), "@a.ts");
});
