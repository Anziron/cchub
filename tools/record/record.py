#!/usr/bin/env python3
"""录制一份 stream-json 和对应的 .jsonl，脱敏后写到 testdata/recordings/<名称>/。

用法：python3 -I tools/record/record.py <场景> <输出目录>
会调用真实 claude，消耗少量额度。运行结束后删除这次产生的会话记录。
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

CMD = (
    "claude -p --input-format stream-json --output-format stream-json --verbose "
    "--permission-prompt-tool stdio --permission-mode {mode} --model haiku "
    "--include-partial-messages"
)
SCENARIOS = {
    "approval": {
        "mode": "default",
        "prompt": "Use the Bash tool once in the foreground to run: echo hi > marker . "
        "Then reply with one short sentence about rivers.",
    },
    "question": {
        "mode": "default",
        "prompt": 'Call the AskUserQuestion tool once with one question "Pick a color" and '
        "options Red and Blue. After the answer, reply with just the chosen color.",
    },
    "plan": {
        "mode": "plan",
        "prompt": "Plan only: creating a file hello.txt in the current directory. Write a one "
        "line plan and call ExitPlanMode. After approval, create the file and reply OK.",
    },
    "interrupt": {
        "mode": "default",
        "prompt": "Use the Bash tool once in the foreground to run: python3 long.py . Then reply OK.",
        "setup": ("long.py", "import time\ntime.sleep(59)\n"),
        "interrupt_after": 4,
    },
}
DROP_LISTS = {
    "tools", "mcp_servers", "slash_commands", "terminal_slash_commands", "agents",
    "skills", "plugins", "capabilities", "memory_paths", "additional_directories",
}
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
TAILNET_IP = re.compile(r"\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b")


def scrub_text(text, cwd):
    encoded = cwd.replace("/", "-").replace(".", "-").replace("_", "-")
    text = text.replace(cwd, "/work").replace(encoded, "-work")
    text = text.replace(os.path.expanduser("~"), "/home/user")
    text = EMAIL.sub("user@example.com", text)
    return TAILNET_IP.sub("100.64.0.1", text)


def scrub(value, cwd):
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if key in DROP_LISTS and isinstance(item, (list, dict)):
                out[key] = [] if isinstance(item, list) else {}
            elif key == "signature":
                out[key] = ""
            else:
                out[key] = scrub(item, cwd)
        return out
    if isinstance(value, list):
        return [scrub(item, cwd) for item in value]
    if isinstance(value, str):
        return scrub_text(value, cwd)
    return value


def write_lines(path, lines):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        for line in lines:
            f.write(json.dumps(line, ensure_ascii=False) + "\n")


def reply(event):
    """按请求类型回答，和用户在界面上点“允许”的效果一样。"""
    request = event["request"]
    updated = dict(request.get("input") or {})
    if request.get("tool_name") == "AskUserQuestion":
        updated["answers"] = {q["question"]: q["options"][-1]["label"] for q in updated["questions"]}
    elif "run_in_background" in updated:
        updated["run_in_background"] = False
    return {"type": "control_response", "response": {
        "subtype": "success", "request_id": event["request_id"],
        "response": {"behavior": "allow", "updatedInput": updated},
    }}


def main():
    name, dest = sys.argv[1], sys.argv[2]
    scenario = SCENARIOS[name]
    work = tempfile.mkdtemp(prefix="cchub-record-")
    fifo, out = f"{work}/in", f"{work}/out"
    os.mkfifo(fifo)
    open(out, "w").close()
    hold = os.open(fifo, os.O_RDWR)
    if "setup" in scenario:
        with open(f"{work}/{scenario['setup'][0]}", "w") as f:
            f.write(scenario["setup"][1])
    command = CMD.format(mode=scenario["mode"])
    proc = subprocess.Popen(
        ["sh", "-c", f"exec {command} <>{fifo} >>{out} 2>>{work}/err"], cwd=work,
    )
    send = lambda obj: os.write(hold, (json.dumps(obj) + "\n").encode())
    send({"type": "user", "message": {"role": "user", "content": scenario["prompt"]}})

    pos, buf, stream, session = 0, "", [], None
    deadline = time.time() + 150
    done = False
    interrupt_at = None
    while not done and time.time() < deadline:
        with open(out, encoding="utf-8") as f:
            f.seek(pos)
            buf += f.read()
            pos = f.tell()
        *lines, buf = buf.split("\n")
        for line in filter(str.strip, lines):
            event = json.loads(line)
            stream.append(event)
            session = session or event.get("session_id")
            if event.get("type") == "control_request":
                send(reply(event))
                if "interrupt_after" in scenario:
                    interrupt_at = time.time() + scenario["interrupt_after"]
            done = done or event.get("type") == "result"
        if interrupt_at and time.time() >= interrupt_at:
            interrupt_at = None
            send({"type": "control_request", "request_id": "interrupt-1",
                  "request": {"subtype": "interrupt"}})
        time.sleep(0.1)
    proc.terminate()
    proc.wait()
    if not done:
        sys.exit("录制超时：没有等到 result")

    found = glob.glob(os.path.expanduser(f"~/.claude/projects/*/{session}.jsonl"))
    if len(found) != 1:
        sys.exit(f"找不到会话记录：{found}")
    transcript = [json.loads(l) for l in open(found[0], encoding="utf-8") if l.strip()]
    transcript = [o for o in transcript if o.get("type") in ("user", "assistant")]

    cwd = os.path.realpath(work)
    os.makedirs(dest, exist_ok=True)
    write_lines(f"{dest}/stream.jsonl", [scrub(o, cwd) for o in stream])
    write_lines(f"{dest}/transcript.jsonl", [scrub(o, cwd) for o in transcript])

    # 工作目录是这次新建的，它对应的项目记录目录里只有这次会话的内容。
    shutil.rmtree(os.path.dirname(found[0]))
    shutil.rmtree(work)
    print("stream", len(stream), "transcript", len(transcript))


if __name__ == "__main__":
    main()
