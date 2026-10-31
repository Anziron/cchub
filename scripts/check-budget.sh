#!/bin/bash
# 检查 hubd 的 musl 构建：必须静态链接，体积和空闲内存在预算内。
set -euo pipefail

MAX_BYTES=$((3 * 1024 * 1024))
MAX_RSS_KB=$((10 * 1024))
TARGET=x86_64-unknown-linux-musl

cargo build --release --locked -p hubd --bin hubd --target "$TARGET"
binary="target/$TARGET/release/hubd"

if ldd "$binary" 2>&1 | grep -q '=>'; then
    echo "不是静态链接：" >&2
    ldd "$binary" >&2
    exit 1
fi

bytes=$(stat -c %s "$binary")
echo "体积 $bytes 字节（上限 $MAX_BYTES）"
[ "$bytes" -le "$MAX_BYTES" ]

state=$(mktemp -d)
HUBD_LISTEN=127.0.0.1:0 HUBD_HOST=direct HUBD_STATE_DIR="$state" "$binary" >/dev/null &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; rm -rf "$state"' EXIT
sleep 2
rss=$(awk '/VmRSS/ {print $2}' "/proc/$pid/status")
echo "空闲内存 $rss KB（上限 $MAX_RSS_KB）"
[ "$rss" -le "$MAX_RSS_KB" ]
