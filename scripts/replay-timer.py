#!/usr/bin/env python3
"""测 hubd 从头回放一个会话要多久（只用标准库，服务器和设备上都能跑）。

  python scripts/replay-timer.py <host:port> <会话 ID> --size <out 字节数> [--deflate] [--idle 3] [-n 次数]

--size 是订阅时 out 文件的长度（服务器上 `stat -c %s /var/lib/hubd/<ID>/out`）；在服务器上跑可以改用
--out <路径>。收到 next >= 这个长度的事件即算回放完成。--deflate 让 hubd 合批压缩（和桌面端一样）。
--idle 先连上、空闲几秒再订阅，从订阅开始计时，模拟桌面端的常驻连接（不算建连和握手）。
"""
import argparse, base64, collections, json, os, socket, struct, sys, time, zlib


def ws_connect(host, port, path):
    s = socket.create_connection((host, port))
    key = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = s.recv(4096)
        if not chunk:
            sys.exit("握手时连接被关闭")
        buf += chunk
    head, rest = buf.split(b"\r\n\r\n", 1)
    if b" 101 " not in head.split(b"\r\n")[0]:
        sys.exit("握手失败：" + head.split(b"\r\n")[0].decode(errors="replace"))
    return s, rest


def ws_send_text(s, text):
    data, mask = text.encode(), os.urandom(4)
    n = len(data)
    if n < 126:
        hdr = bytes([0x81, 0x80 | n])
    elif n < 65536:
        hdr = bytes([0x81, 0x80 | 126]) + struct.pack(">H", n)
    else:
        hdr = bytes([0x81, 0x80 | 127]) + struct.pack(">Q", n)
    s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))


class Reader:
    def __init__(self, s, rest):
        self.s, self.buf = s, bytearray(rest)

    def need(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(1 << 20)
            if not chunk:
                raise EOFError("连接被关闭")
            self.buf += chunk
        out = bytes(self.buf[:n])
        del self.buf[:n]
        return out

    def frame(self):
        b0, b1 = self.need(2)
        n = b1 & 0x7F
        if n == 126:
            n = struct.unpack(">H", self.need(2))[0]
        elif n == 127:
            n = struct.unpack(">Q", self.need(8))[0]
        return b0 & 0x0F, self.need(n)


def run(host, port, session, target, deflate, idle):
    t0 = time.monotonic()
    s, rest = ws_connect(host, port, "/ws?z=deflate" if deflate else "/ws")
    r = Reader(s, rest)
    if idle:
        time.sleep(idle)
        t0 = time.monotonic()
    ws_send_text(s, json.dumps({"type": "attach", "session": session, "after": 0}))
    inflate = zlib.decompressobj(-15)
    messages = wire = 0
    first = None
    kinds, sizes = collections.Counter(), collections.Counter()
    try:
        while True:
            op, data = r.frame()
            if op == 1:
                texts = [data]
            elif op == 2:
                texts = inflate.decompress(data).split(b"\n")
            else:
                continue
            messages += 1
            wire += len(data)
            if first is None:
                first = time.monotonic() - t0
            for text in texts:
                f = json.loads(text)
                kind = f.get("type")
                if kind == "error":
                    sys.exit("hubd 报错：" + f.get("message", ""))
                if kind == "event":
                    try:
                        kind = "event:" + json.loads(f["payload"]).get("type", "?")
                    except ValueError:
                        kind = "event:?"
                kinds[kind] += 1
                sizes[kind] += len(text)
                if f.get("type") in ("event", "skipped") and f["next"] >= target:
                    return time.monotonic() - t0, first, messages, wire, kinds, sizes
    finally:
        s.close()


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("addr", help="hubd 地址 host:port")
    p.add_argument("session")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--size", type=int, help="订阅时 out 的字节数")
    g.add_argument("--out", help="out 文件路径（在服务器上跑时）")
    p.add_argument("--deflate", action="store_true", help="要求合批压缩")
    p.add_argument("--idle", type=float, default=0, help="连上后先空闲这么多秒再订阅，从订阅开始计时")
    p.add_argument("-n", type=int, default=1, help="重复次数")
    p.add_argument("-v", action="store_true", help="按事件类型列出原文大小")
    a = p.parse_args()
    host, port = a.addr.rsplit(":", 1)
    target = a.size if a.size is not None else os.path.getsize(a.out)
    for _ in range(a.n):
        total, first, messages, wire, kinds, sizes = run(host, int(port), a.session, target, a.deflate, a.idle)
        raw = sum(sizes.values())
        print(f"{'deflate' if a.deflate else 'text   '}{' 常驻' if a.idle else ''} out={target / 1048576:.1f}MB "
              f"原文 {raw / 1048576:.1f}MB 线上 {wire / 1048576:.2f}MB / {messages} 条消息，"
              f"首条 {first * 1000:.0f}ms，回放完成 {total:.2f}s")
        if a.v:
            for k, c in sizes.most_common(8):
                print(f"  {k:28s} {kinds[k]:7d} 条 {c / 1048576:7.2f}MB")


if __name__ == "__main__":
    main()
