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

CACHE_VERSION = 2
# 输出里每个模型的四项：[input, output, cacheWrite, cacheRead]
OUTPUT_VERSION = 2
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
        m = b["models"].setdefault(mk, [0, 0, 0, 0])
        m[0] += inp
        m[1] += out
        m[2] += cw
        m[3] += cr
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


def upgrade_buckets(buckets):
    """v1 桶里每个模型只存了 input+output+cacheWrite 的合计，桶的 n 里有整桶的四项。
    按各模型合计占比把 n 的四项分给它们：桶里只有一个模型时是精确的，多个模型时是近似。"""
    for b in buckets.values():
        models = b.get("models", {})
        total = sum(v for v in models.values() if isinstance(v, int))
        n = b["n"]
        for k, v in list(models.items()):
            if not isinstance(v, int):
                continue
            share = v / total if total else 1 / len(models)
            models[k] = [round(n[x] * share) for x in (I, O, CW, CR)]


def upgrade_v1(c, root):
    """v1 -> v2。源文件还在的条目丢掉，让它按新格式重新扫描（精确）；
    源文件已被 CLI 清理的条目（含原有的 gone）只剩缓存里的聚合，按 upgrade_buckets 转换后保留。"""
    gone = {}
    for path, ent in (c.get("gone") or {}).items():
        gone[path] = {"main": ent.get("main"), "buckets": ent["buckets"]}
    for path, ent in c["files"].items():
        if not os.path.exists(path):
            gone[path] = {"main": ent.get("main"), "buckets": ent["buckets"]}
    for ent in gone.values():
        upgrade_buckets(ent["buckets"])
    return {"version": CACHE_VERSION, "files": {}, "gone": gone}


def read_cache_file(path, version):
    try:
        with open(path, "r", encoding="utf-8") as f:
            c = json.load(f)
        if isinstance(c, dict) and c.get("version") == version and isinstance(c.get("files"), dict):
            return c
    except (OSError, ValueError):
        pass
    return None


def load_cache(path, root):
    c = read_cache_file(path, CACHE_VERSION)
    if c is not None:
        return c
    # 没有 v2 缓存：从旧格式迁移（旧文件不改动）。先看这个路径本身是不是旧格式（防止覆盖），再看同目录的 cache-v1.json。
    old = read_cache_file(path, 1) or read_cache_file(os.path.join(os.path.dirname(path), "cache-v1.json"), 1)
    if old is not None:
        return upgrade_v1(old, root)
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
                    # 各模型每个本地小时的 token（四项之和），“今天”的柱状图用。
                    "hourTokens": {},
                    # 各项目目录里各模型的四项，“常用项目”用。
                    "projectTokens": {},
                }
            n = b["n"]
            d["messages"] += n[M]
            d["input"] += n[I]
            d["output"] += n[O]
            d["cacheWrite"] += n[CW]
            d["cacheRead"] += n[CR]
            for k, v in b["models"].items():
                m = d["models"].setdefault(k, [0, 0, 0, 0])
                for x in range(4):
                    m[x] += v[x]
                d["hourTokens"].setdefault(k, [0] * 24)[lt.hour] += v[0] + v[1] + v[2] + v[3]
            for k, v in b["projects"].items():
                d["projects"][k] = d["projects"].get(k, 0) + v
            # 缓存里只按项目记了回复数。桶按文件和小时分，一个会话文件通常只有一个目录，
            # 这时整桶的 token 都归它（精确）；偶尔有多个目录时按回复数分摊（近似）。
            # 在输出时推算，缓存格式不变，已被 CLI 清理的会话也有数据。
            total = sum(b["projects"].values())
            for pk, count in b["projects"].items():
                share = count / total if total else 0
                pt = d["projectTokens"].setdefault(pk, {})
                for k, v in b["models"].items():
                    m = pt.setdefault(k, [0, 0, 0, 0])
                    for x in range(4):
                        m[x] += v[x] * share
            d["hours"][lt.hour] += n[M]
            if ent.get("main") and n[M] > 0:
                day_sessions.setdefault(date, set()).add(fi)
    for date, s in day_sessions.items():
        days[date]["sessions"] = len(s)
    for d in days.values():
        for pt in d["projectTokens"].values():
            for k, m in pt.items():
                pt[k] = [round(v) for v in m]
    return {
        "version": OUTPUT_VERSION,
        "generatedAt": int(time.time()),
        "tzOffset": tz,
        "days": [days[k] for k in sorted(days)],
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description="汇总 Claude Code 会话记录的用量，输出一行 JSON")
    ap.add_argument("--root", default=os.path.expanduser("~/.claude/projects"))
    ap.add_argument("--cache", default=os.path.expanduser("~/.cache/cchub-usage/cache-v2.json"))
    ap.add_argument("--tz", type=int, default=0, help="相对 UTC 往东的分钟数（UTC+8 为 480）")
    args = ap.parse_args(argv)
    root = os.path.abspath(args.root)
    cache_path = os.path.abspath(args.cache)
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    with open(cache_path + ".lock", "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)  # 防止两个进程同时读写缓存
        cache = load_cache(cache_path, root)
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
