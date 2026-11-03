#!/usr/bin/env bash
# 在模拟器上验证手机端：连接、退到后台、审批通知、划掉任务后重开。
# 用法：android-smoke.sh <apk> <hubd> <fake-claude> <录制文件> <截图目录>
set -euo pipefail

apk=$1 hubd=$2 shots=$5
# 会话在临时目录里启动，这两个必须是绝对路径。
fake=$(realpath "$3") recording=$(realpath "$4")
pkg=dev.anziron.cchub
port=7878
state=$(mktemp -d)
work=$(mktemp -d)
mkdir -p "$shots"

fail() {
  echo "失败：$1" >&2
  # 存进产物：运行记录的日志可能被删，产物下载后还在。
  echo "$1" >"$shots/failure.txt"
  adb shell dumpsys notification --noredact >"$shots/notifications.txt" || true
  adb logcat -d | grep -v s_gl >"$shots/logcat.txt" || true
  adb shell dumpsys notification --noredact | grep -E "android.(title|text)=" | tail -20 >&2 || true
  adb logcat -d | grep -E "FATAL|AndroidRuntime|RustStdoutStderr|cchub" | grep -v s_gl | tail -60 >&2 || true
  adb exec-out screencap -p >"$shots/failure.png" || true
  exit 1
}
wait_notification() {
  for _ in $(seq 1 "${2:-30}"); do
    adb shell dumpsys notification --noredact | grep -qF "$1" && return 0
    sleep 1
  done
  fail "等不到通知：$1"
}
shot() { sleep 2; adb exec-out screencap -p >"$shots/$1.png"; }
alive() { adb shell pidof "$pkg" >/dev/null || fail "$1：进程不在了"; }

start_session() {
python3 - "$port" "$work" <<'EOF'
import asyncio, json, sys, uuid
import websockets

async def main(port, cwd):
    session = str(uuid.uuid4())
    async with websockets.connect(f"ws://127.0.0.1:{port}/ws", origin=None) as ws:
        await ws.send(json.dumps({"type": "start", "session": session, "cwd": cwd, "title": "冒烟测试"}))
        line = json.dumps({"type": "user", "message": {"role": "user", "content": "test"}})
        await ws.send(json.dumps({"type": "input", "session": session, "line": line}))
        await asyncio.sleep(2)
    print(session)

asyncio.run(main(int(sys.argv[1]), sys.argv[2]))
EOF
}
# 整屏只有一两种颜色就是白屏。
not_blank() {
  adb exec-out screencap -p >"$shots/$1.png"
  python3 - "$shots/$1.png" <<'EOF' || fail "$1：界面是空白的"
import sys
from PIL import Image
image = Image.open(sys.argv[1]).convert("RGB")
width, height = image.size
body = image.crop((0, height // 10, width, height))
sys.exit(0 if len(set(body.getdata())) > 20 else 1)
EOF
}
notify_count() { adb logcat -d | grep -c "cchub-bridge: notify foreground=false" || true; }
wait_more_notifies() {
  for _ in $(seq 1 40); do
    [ "$(notify_count)" -gt "$1" ] && return 0
    sleep 1
  done
  fail "$2：等不到新的通知"
}

HUBD_LISTEN=127.0.0.1:$port HUBD_HOST=direct HUBD_STATE_DIR=$state \
  HUBD_MIN_AVAILABLE_MB=0 HUBD_CLAUDE_CMD="$fake $recording 1" "$hubd" &
hubd_pid=$!
trap 'kill $hubd_pid 2>/dev/null || true' EXIT
sleep 1

adb install -r "$apk"
adb reverse tcp:$port tcp:$port
adb shell pm grant "$pkg" android.permission.POST_NOTIFICATIONS
adb logcat -c
adb shell monkey -p "$pkg" -c android.intent.category.LAUNCHER 1 >/dev/null
sleep 8
shot 1-connect
# 先点输入框：没有焦点时回车会落到列表的第一个按钮上。坐标按默认模拟器的屏幕换算。
read -r width height < <(adb shell wm size | sed -E 's/.*: ([0-9]+)x([0-9]+).*/\1 \2/' | tr -d '\r')
adb shell input tap $((width / 2)) $((height * 291 / 640))
sleep 2
adb shell input text 127.0.0.1
shot 1b-typed
adb shell input keyevent 66
wait_notification "已连接"
shot 2-list
alive "连接后"
not_blank 2b-list

# 退到桌面后，审批请求要变成系统通知。
adb shell input keyevent 3
sleep 3
session=$(start_session)
wait_notification "有个操作等你批准"
shot 3-notification
alive "后台收到通知时"

# 从通知进入等同于带会话 ID 启动，要直接看到审批卡片。
adb shell am start -n "$pkg/.MainActivity" --es dev.anziron.cchub.SESSION "$session" -f 0x24000000 >/dev/null
sleep 4
shot 4-approval

# 划掉任务：Activity 被销毁，进程和通知要留下，重开不能崩溃。
task=$(adb shell am stack list | grep -F "$pkg" | head -1 | sed -E 's/.*taskId=([0-9]+).*/\1/' | tr -d '\r')
[ -n "$task" ] || fail "找不到任务"
adb shell am stack remove "$task"
sleep 5
alive "划掉任务后"
wait_notification "已连接" 5

# 界面销毁后，别处新开的会话也要能通知。
before=$(notify_count)
start_session >/dev/null
wait_more_notifies "$before" "划掉任务后"
alive "划掉任务后收到通知时"

for round in 1 2; do
  adb shell monkey -p "$pkg" -c android.intent.category.LAUNCHER 1 >/dev/null
  sleep 10
  not_blank "5-reopened-$round"
  alive "重开后"
  wait_notification "已连接" 30
  task=$(adb shell am stack list | grep -F "$pkg" | head -1 | sed -E 's/.*taskId=([0-9]+).*/\1/' | tr -d '\r')
  [ -n "$task" ] || fail "重开后找不到任务"
  adb shell am stack remove "$task"
  sleep 4
done
if adb logcat -d | grep -E "FATAL EXCEPTION|Fatal signal" | grep -F "anziron.cchub"; then
  fail "日志里有崩溃"
fi
echo "冒烟测试通过"
