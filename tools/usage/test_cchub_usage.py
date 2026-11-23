"""cchub-usage 的单元测试：python3 -m unittest 即可运行。"""
import importlib.util
import json
import os
import shutil
import tempfile
import unittest

_spec = importlib.util.spec_from_file_location(
    "cchub_usage", os.path.join(os.path.dirname(os.path.abspath(__file__)), "cchub-usage.py"))
cu = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cu)


def line(mid, ts="2026-11-10T08:00:00.000Z", model="claude-opus-5-5", cwd="/p", usage=None, **extra):
    if usage is None:
        usage = {"input_tokens": 1, "output_tokens": 10,
                 "cache_creation_input_tokens": 100, "cache_read_input_tokens": 1000}
    obj = {"type": "assistant", "timestamp": ts, "cwd": cwd, "sessionId": "s",
           "message": {"id": mid, "model": model, "usage": usage}}
    obj.update(extra)
    return json.dumps(obj) + "\n"


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.root = os.path.join(self.tmp, "projects")
        os.makedirs(os.path.join(self.root, "proj"))
        self.cache = os.path.join(self.tmp, "cache", "c.json")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def path(self, *parts):
        p = os.path.join(self.root, "proj", *parts)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        return p

    def write(self, p, text, mode="w"):
        with open(p, mode) as f:
            f.write(text)

    def run_tool(self, tz=0):
        import contextlib
        import io
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            cu.main(["--root", self.root, "--cache", self.cache, "--tz", str(tz)])
        out = buf.getvalue()
        self.assertEqual(out.count("\n"), 1)
        return json.loads(out)


class UsageTest(Base):
    def test_dedup_same_id(self):
        self.write(self.path("a.jsonl"), line("m1") * 3 + line("m2"))
        d = self.run_tool()["days"][0]
        self.assertEqual(d["messages"], 2)
        self.assertEqual(d["input"], 2)
        self.assertEqual(d["cacheRead"], 2000)
        self.assertEqual(d["models"], {"claude-opus-5-5": [2, 20, 200, 2000]})
        self.assertEqual(d["projects"], {"/p": 2})

    def test_project_tokens_by_model(self):
        # 每个项目各模型的四项。桶按文件分，一个会话文件通常只有一个目录，这时是精确的。
        self.write(self.path("a.jsonl"), line("m1", cwd="/a") + line("m2", cwd="/a"))
        self.write(self.path("b.jsonl"), line("m3", cwd="/b", model="claude-sonnet-5-5"))
        d = self.run_tool()["days"][0]
        self.assertEqual(d["projectTokens"], {
            "/a": {"claude-opus-5-5": [2, 20, 200, 2000]},
            "/b": {"claude-sonnet-5-5": [1, 10, 100, 1000]},
        })

    def test_project_tokens_split_when_bucket_has_two_dirs(self):
        # 同一个文件同一小时出现两个目录：按回复数把桶里各模型的 token 分给它们（近似）。
        self.write(self.path("a.jsonl"), line("m1", cwd="/a") + line("m2", cwd="/b") + line("m3", cwd="/b"))
        d = self.run_tool()["days"][0]
        self.assertEqual(d["projectTokens"], {
            "/a": {"claude-opus-5-5": [1, 10, 100, 1000]},
            "/b": {"claude-opus-5-5": [2, 20, 200, 2000]},
        })

    def test_subagent_counts_tokens_not_sessions(self):
        self.write(self.path("a.jsonl"), line("m1"))
        self.write(self.path("a", "subagents", "agent-1.jsonl"), line("m2") + line("m3"))
        d = self.run_tool()["days"][0]
        self.assertEqual(d["messages"], 3)
        self.assertEqual(d["sessions"], 1)
        self.assertEqual(d["output"], 30)

    def test_tz_shifts_day_and_hour(self):
        self.write(self.path("a.jsonl"), line("m1", ts="2026-11-10T23:30:00Z"))
        r0 = self.run_tool(tz=0)["days"]
        self.assertEqual(r0[0]["date"], "2026-11-10")
        self.assertEqual(r0[0]["hours"][23], 1)
        r = self.run_tool(tz=480)
        self.assertEqual(r["tzOffset"], 480)
        self.assertEqual(r["days"][0]["date"], "2026-11-11")
        self.assertEqual(r["days"][0]["hours"][7], 1)
        self.assertEqual(len(r["days"]), 1)

    def test_skip_synthetic_error_no_usage(self):
        text = (line("s1", model="<synthetic>") + line("e1", isApiErrorMessage=True)
                + json.dumps({"type": "assistant", "timestamp": "2026-11-10T08:00:00Z",
                              "message": {"id": "n1", "model": "x"}}) + "\n"
                + json.dumps({"type": "user", "message": "assistant"}) + "\n"
                + line("ok"))
        self.write(self.path("a.jsonl"), text)
        d = self.run_tool()["days"][0]
        self.assertEqual(d["messages"], 1)

    def test_no_cwd_goes_to_empty_string(self):
        obj = json.loads(line("m1"))
        del obj["cwd"]
        self.write(self.path("a.jsonl"), json.dumps(obj) + "\n")
        self.assertEqual(self.run_tool()["days"][0]["projects"], {"": 1})

    def test_incremental_and_partial_line(self):
        p = self.path("a.jsonl")
        self.write(p, line("m1"))
        self.assertEqual(self.run_tool()["days"][0]["messages"], 1)
        # 追加：一条完整 + 半条
        full = line("m2")
        half = line("m3")
        self.write(p, full + half[:20], "a")
        self.assertEqual(self.run_tool()["days"][0]["messages"], 2)
        with open(self.cache) as f:
            ent = list(json.load(f)["files"].values())[0]
        self.assertEqual(ent["offset"], len(line("m1").encode()) + len(full.encode()))
        # 补完半行
        self.write(p, half[20:], "a")
        self.assertEqual(self.run_tool()["days"][0]["messages"], 3)
        # 同一 id 跨增量边界也只算一次
        self.write(p, line("m3"), "a")
        self.assertEqual(self.run_tool()["days"][0]["messages"], 3)

    def test_incremental_reads_only_new_part(self):
        p = self.path("a.jsonl")
        self.write(p, line("m1"))
        self.run_tool()
        calls = []
        orig = cu.scan_lines

        def spy(f, start, state):
            calls.append(start)
            return orig(f, start, state)
        cu.scan_lines = spy
        try:
            self.write(p, line("m2"), "a")
            self.run_tool()
        finally:
            cu.scan_lines = orig
        self.assertEqual(calls, [len(line("m1").encode())])

    def test_truncate_rereads(self):
        p = self.path("a.jsonl")
        self.write(p, line("m1") + line("m2") + line("m3"))
        self.assertEqual(self.run_tool()["days"][0]["messages"], 3)
        self.write(p, line("x1"))
        self.assertEqual(self.run_tool()["days"][0]["messages"], 1)

    def test_same_size_rewrite_rereads(self):
        p = self.path("a.jsonl")
        self.write(p, line("m1", cwd="/aa"))
        self.run_tool()
        self.write(p, line("m1", cwd="/bb"))
        st = os.stat(p)
        os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))
        self.assertEqual(self.run_tool()["days"][0]["projects"], {"/bb": 1})

    def test_deleted_file_keeps_history(self):
        # CLI 会清理旧会话记录，删掉的文件的统计要留在缓存里，否则“全部”只剩最近一个月。
        p = self.path("a.jsonl")
        self.write(p, line("m1"))
        self.write(self.path("b.jsonl"), line("m2"))
        self.assertEqual(self.run_tool()["days"][0]["messages"], 2)
        os.unlink(p)
        d = self.run_tool()["days"][0]
        self.assertEqual((d["messages"], d["sessions"]), (2, 2))
        with open(self.cache) as f:
            cache = json.load(f)
        self.assertEqual((len(cache["files"]), len(cache["gone"])), (1, 1))
        # 同名文件又出现时以新文件为准，不重复计算。
        self.write(p, line("m3"))
        self.assertEqual(self.run_tool()["days"][0]["messages"], 2)

    def test_timestamp_with_offset_converted_to_utc(self):
        self.write(self.path("a.jsonl"), line("m1", ts="2026-11-10T08:30:00.000+08:00"))
        d = self.run_tool()["days"][0]
        self.assertEqual((d["date"], d["hours"][0]), ("2026-11-10", 1))

    def test_sessions_count_main_files_per_day(self):
        self.write(self.path("a.jsonl"), line("m1") + line("m2", ts="2026-11-10T09:00:00Z"))
        self.write(self.path("b.jsonl"), line("m3", ts="2026-11-11T09:00:00Z"))
        days = self.run_tool()["days"]
        self.assertEqual([(d["date"], d["sessions"], d["messages"]) for d in days],
                         [("2026-11-10", 1, 2), ("2026-11-11", 1, 1)])

    def test_output_schema(self):
        self.write(self.path("a.jsonl"), line("m1"))
        r = self.run_tool(tz=480)
        self.assertEqual(set(r), {"version", "generatedAt", "tzOffset", "days"})
        self.assertEqual(r["version"], 2)
        self.assertIsInstance(r["generatedAt"], int)
        d = r["days"][0]
        self.assertEqual(set(d), {"date", "messages", "sessions", "input", "output", "cacheWrite",
                                  "cacheRead", "models", "projects", "hours", "hourTokens", "projectTokens"})
        self.assertEqual(len(d["hours"]), 24)
        self.assertEqual(sum(d["hours"]), d["messages"])

    def test_empty_root(self):
        self.assertEqual(self.run_tool()["days"], [])


if __name__ == "__main__":
    unittest.main()
