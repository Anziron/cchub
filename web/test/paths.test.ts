// 拖进输入框的文件路径怎么转成服务器能读的引用。运行：node --test web/test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeCwd, DropMounts, dropRef, mentionText, mountTarget } from "../src/paths.ts";

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

test("项目外、同一台设备上的文件：挂载它所在的目录", () => {
  assert.deepEqual(mountTarget("D:\\blog\\PLAN.md", cwd), { device: "pc-company", dir: "D:\\blog", name: "PLAN.md" });
  assert.deepEqual(mountTarget("D:\\a\\b c\\x.txt", cwd), { device: "pc-company", dir: "D:\\a\\b c", name: "x.txt" });
  assert.deepEqual(mountTarget("/Users/me/notes/a.md", "/mnt/mac/Users/me/proj"), { device: "mac", dir: "/Users/me/notes", name: "a.md" });
  // 盘符根目录下的文件不挂整个盘；服务器上的项目不知道是哪台设备。
  assert.equal(mountTarget("D:\\x.txt", cwd), null);
  assert.equal(mountTarget("/x.txt", "/mnt/mac/Users/me/proj"), null);
  assert.equal(mountTarget("D:\\blog\\PLAN.md", "/root/work"), null);
  assert.equal(mountTarget("D:\\blog\\PLAN.md", undefined), null);
});

test("发送时以 @路径 拼在正文前，含空格的路径加引号", () => {
  assert.equal(mentionText(["web/src/App.tsx", "docs/a b.md"], "看看这两个"), '@web/src/App.tsx @"docs/a b.md"\n\n看看这两个');
  assert.equal(mentionText([], "hi"), "hi");
  assert.equal(mentionText(["a.ts"], ""), "@a.ts");
});

test("拖入文件的挂载登记：同一目录只挂一次，结果回来按草稿键换掉每个标签，只结算一次", () => {
  const mounts = new DropMounts();
  const first = mounts.plan("s1", ["D:\\cchub\\a.ts", "D:\\blog\\x.md", "D:\\blog\\y.md"], cwd);
  assert.deepEqual(first.mounts, [{ device: "pc-company", dir: "D:\\blog" }]);
  assert.deepEqual(first.refs, [
    { path: "a.ts", reachable: true },
    { path: "D:\\blog\\x.md", reachable: false, pending: true },
    { path: "D:\\blog\\y.md", reachable: false, pending: true },
  ]);
  assert.deepEqual(mounts.plan("", ["D:\\blog\\z.md"], cwd).mounts, [], "已经在等的目录不再挂");
  assert.deepEqual(mounts.settle("pc-company", "D:\\blog", "/mnt/pc-company/d/blog/", null), [
    { key: "s1", path: "D:\\blog\\x.md", ref: { path: "/mnt/pc-company/d/blog/x.md", reachable: true } },
    { key: "s1", path: "D:\\blog\\y.md", ref: { path: "/mnt/pc-company/d/blog/y.md", reachable: true } },
    { key: "", path: "D:\\blog\\z.md", ref: { path: "/mnt/pc-company/d/blog/z.md", reachable: true } },
  ]);
  assert.equal(mounts.settle("pc-company", "D:\\blog", null, null), null, "结算过就没人等了（之后的是选工作区的挂载）");
  mounts.plan("s1", ["D:\\blog\\x.md"], cwd);
  assert.deepEqual(mounts.settle("pc-company", "D:\\blog", null, null)?.[0].ref, { path: "D:\\blog\\x.md", reachable: false, error: "挂载失败" });
});

test("会话目录：/mnt/<设备>/ 下是设备目录，其他是服务器本地目录", () => {
  assert.deepEqual(describeCwd("/mnt/laptop/work/app"), { project: "app", device: "laptop" });
  assert.deepEqual(describeCwd("/srv/tools/"), { project: "tools", device: "服务器" });
  assert.deepEqual(describeCwd("/"), { project: "/", device: "服务器" });
  assert.deepEqual(describeCwd(undefined), { project: "", device: "" });
});
