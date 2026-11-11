#!/usr/bin/env python3
"""cchub-usage：汇总 Claude Code CLI 会话记录（~/.claude/projects/**/*.jsonl）里的用量。

stdout 只输出一行 JSON（格式见 docs / 前端“使用情况”窗格），失败时退出码非 0、错误写 stderr。
缓存按 UTC 小时分桶、与 --tz 无关；--tz 只影响输出时的日期和小时切分。
"""
import argparse
import fcntl
import json
import os
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone

CACHE_VERSION = 1
# 一个桶的数值字段顺序：回复数、input、output、cacheWrite、cacheRead
M, I, O, CW, CR = range(5)


def parse_ts_hour(ts):
    """'2026-11-10T08:15:30.123Z' -> '2026-11-10T08'（按 UTC）；带非零偏移的转成 UTC；无法解析返回 None。"""
    if not isinstance(ts, str) or len(ts) < 13:
        return None
    if ts.endswith("Z") and ts[10] == "T" and ts[:4].isdigit():
        return ts[:13]  # 常见情形：UTC，直接截取
    try:
        d = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H")
    except ValueError:
        return None


def num(v):
    return v if isinstance(v, int) and not isinstance(v, bool) else 0


def scan_lines(f, start, state):
    """从 start 偏移读完整行并聚合进 state（dict: buckets/last_id）。返回新的偏移（停在最后一个换行之后）。"""
    f.seek(start)
    offset = start
    buckets = state["buckets"]
    last_id = state["last_id"]
    for line in f:
        if not line.endswith(b"\n"):
            break  # 最后一行没写完，下次再读
        offset += len(line)
        if b'"assistant"' not in line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if not isinstance(obj, dict) or obj.get("type") != "assistant":
            continue
        if obj.get("isApiErrorMessage") is True:
            continue
        msg = obj.get("message")
        if not isinstance(msg, dict):
            continue
        model = msg.get("model")
        usage = msg.get("usage")
        if model == "<synthetic>" or not isinstance(usage, dict):
            continue
        mid = msg.get("id")
        if mid is not None:
            if mid == last_id:
                continue  # 同一条 API 回复拆成多行，只算一次
            last_id = mid
        hour = parse_ts_hour(obj.get("timestamp"))
        if hour is None:
            continue
        b = buckets.get(hour)
        if b is None:
            b = buckets[hour] = {"n": [0, 0, 0, 0, 0], "models": {}, "projects": {}}
        inp, out = num(usage.get("input_tokens")), num(usage.get("output_tokens"))
        cw, cr = num(usage.get("cache_creation_input_tokens")), num(usage.get("cache_read_input_tokens"))
        n = b["n"]
        n[M] += 1
        n[I] += inp
        n[O] += out
        n[CW] += cw
        n[CR] += cr
        mk = model if isinstance(model, str) else ""
        b["models"][mk] = b["models"].get(mk, 0) + inp + out + cw
        cwd = obj.get("cwd")
        cwd = cwd if isinstance(cwd, str) else ""
        b["projects"][cwd] = b["projects"].get(cwd, 0) + 1
    state["last_id"] = last_id
    return offset


def list_files(root):
    res = []
    for dp, _dn, fns in os.walk(root):
        for fn in fns:
            if fn.endswith(".jsonl"):
                res.append(os.path.join(dp, fn))
    return res


def is_main(root, path):
    rel = os.path.relpath(path, root).split(os.sep)
    return "subagents" not in rel[:-1]


def update_cache(root, cache):
    files = cache.setdefault("files", {})
    # CLI 会清理旧的会话记录（默认 30 天）。删掉的文件只留聚合结果，历史统计不跟着消失。
    gone = cache.setdefault("gone", {})
    present = set()
    for path in list_files(root):
        try:
            st = os.stat(path)
        except OSError:
            continue
        present.add(path)
        gone.pop(path, None)  # 同名文件又出现：以新文件为准
        ent = files.get(path)
        size, mtime = st.st_size, st.st_mtime_ns
        main = is_main(root, path)
        if ent and ent["size"] == size and ent["mtime"] == mtime:
            ent["main"] = main
            continue
        if ent and size > ent["size"] and ent["offset"] <= ent["size"]:
            start = ent["offset"]  # 增量：只读新增部分
        else:
            ent = None
            start = 0  # 变小，或 mtime 变了但没变大：整份重读
        if ent is None:
            ent = {"offset": 0, "last_id": None, "buckets": {}}
        try:
            with open(path, "rb") as f:
                ent["offset"] = scan_lines(f, start, ent)
        except OSError:
            continue
        ent.update(size=size, mtime=mtime, main=main)
        files[path] = ent
    for path in list(files):
        if path not in present:
            ent = files.pop(path)
            gone[path] = {"main": ent.get("main"), "buckets": ent["buckets"]}


def load_cache(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            c = json.load(f)
        if isinstance(c, dict) and c.get("version") == CACHE_VERSION and isinstance(c.get("files"), dict):
            return c
    except (OSError, ValueError):
        pass
    return {"version": CACHE_VERSION, "files": {}}


def save_cache(path, cache):
    d = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(prefix=".cache-", suffix=".tmp", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(cache, f, separators=(",", ":"))
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def build_output(cache, tz):
    shift = timedelta(hours=round(tz / 60))  # 半小时时区四舍五入到小时
    days = {}
    day_sessions = {}
    parsed = {}
    entries = list(cache["files"].values()) + list(cache.get("gone", {}).values())
    for fi, ent in enumerate(entries):
        for hk, b in ent["buckets"].items():
            lt = parsed.get(hk)
            if lt is None:
                lt = parsed[hk] = datetime.strptime(hk, "%Y-%m-%dT%H") + shift
            date = lt.strftime("%Y-%m-%d")
            d = days.get(date)
            if d is None:
                d = days[date] = {
                    "date": date, "messages": 0, "sessions": 0,
                    "input": 0, "output": 0, "cacheWrite": 0, "cacheRead": 0,
                    "models": {}, "projects": {}, "hours": [0] * 24,
                }
            n = b["n"]
            d["messages"] += n[M]
            d["input"] += n[I]
            d["output"] += n[O]
            d["cacheWrite"] += n[CW]
            d["cacheRead"] += n[CR]
            for k, v in b["models"].items():
                d["models"][k] = d["models"].get(k, 0) + v
            for k, v in b["projects"].items():
                d["projects"][k] = d["projects"].get(k, 0) + v
            d["hours"][lt.hour] += n[M]
            if ent.get("main") and n[M] > 0:
                day_sessions.setdefault(date, set()).add(fi)
    for date, s in day_sessions.items():
        days[date]["sessions"] = len(s)
    return {
        "version": 1,
        "generatedAt": int(time.time()),
        "tzOffset": tz,
        "days": [days[k] for k in sorted(days)],
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description="汇总 Claude Code 会话记录的用量，输出一行 JSON")
    ap.add_argument("--root", default=os.path.expanduser("~/.claude/projects"))
    ap.add_argument("--cache", default=os.path.expanduser("~/.cache/cchub-usage/cache-v1.json"))
    ap.add_argument("--tz", type=int, default=0, help="相对 UTC 往东的分钟数（UTC+8 为 480）")
    args = ap.parse_args(argv)
    root = os.path.abspath(args.root)
    cache_path = os.path.abspath(args.cache)
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    with open(cache_path + ".lock", "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)  # 防止两个进程同时读写缓存
        cache = load_cache(cache_path)
        update_cache(root, cache)
        save_cache(cache_path, cache)
        out = build_output(cache, args.tz)
    sys.stdout.write(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("cchub-usage: %s: %s\n" % (type(e).__name__, e))
        sys.exit(1)
