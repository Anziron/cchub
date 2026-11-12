#!/bin/bash
# cchub 服务器端安装 / 升级：hubd、使用情况统计命令 cchub-usage、systemd 服务。
#
# 首次安装（root，服务器已装好 Tailscale 和 claude CLI 并登录）：
#   curl -fsSL https://github.com/Anziron/cchub/releases/latest/download/install-server.sh | bash -s -- --allow <你的 Tailscale 账号>
# 升级：同一条命令去掉 --allow（已有服务文件时只换程序并重启，不改配置）。
#
# 选项：
#   --allow <账号[,账号]>  允许连接的 Tailscale 账号（HUBD_ALLOWED_USERS），监听 Tailscale 地址时首次安装必填
#   --listen <地址:端口>   监听地址，默认 `tailscale ip -4` 的地址加 7878；没有 Tailscale 时 127.0.0.1:7878
#   --version <标签>       安装指定版本（如 v0.1.0），默认最新 Release
#   --from <目录>          不下载，用目录里的 hubd-linux-x86_64 和 cchub-usage.py
# 测试用的环境变量：CCHUB_BIN_DIR（默认 /usr/local/bin）、CCHUB_UNIT_DIR（默认 /etc/systemd/system）、
#   CCHUB_NO_SYSTEMCTL=1（不调用 systemctl、不检查 /health）、CCHUB_REPO（默认 Anziron/cchub）。
set -euo pipefail

REPO=${CCHUB_REPO:-Anziron/cchub}
BIN_DIR=${CCHUB_BIN_DIR:-/usr/local/bin}
UNIT_DIR=${CCHUB_UNIT_DIR:-/etc/systemd/system}
NO_SYSTEMCTL=${CCHUB_NO_SYSTEMCTL:-}
UNIT="$UNIT_DIR/hubd.service"
ALLOW="" LISTEN="" VERSION="" FROM=""

die() { echo "错误：$*" >&2; exit 1; }
warn() { echo "注意：$*" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --allow) ALLOW=${2:?--allow 后面要写账号}; shift 2 ;;
    --listen) LISTEN=${2:?--listen 后面要写地址}; shift 2 ;;
    --version) VERSION=${2:?--version 后面要写标签}; shift 2 ;;
    --from) FROM=${2:?--from 后面要写目录}; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "不认识的参数 $1（--help 查看用法）" ;;
  esac
done

[ "$(uname -s)" = Linux ] || die "hubd 只支持 Linux"
[ "$(uname -m)" = x86_64 ] || die "目前只提供 x86_64 的 hubd，其他架构请从源码编译：cargo build --release -p hubd"
if [ -z "$NO_SYSTEMCTL" ]; then
  [ "$(id -u)" = 0 ] || die "请用 root 运行（hubd 用 systemd 管理会话进程）"
  command -v systemctl >/dev/null || die "没有找到 systemctl，hubd 需要 systemd"
fi

# claude 常装在用户目录，hubd 的 PATH 要包含它所在的目录。
CLAUDE=$(command -v claude || true)
[ -n "$CLAUDE" ] || { [ -x "$HOME/.local/bin/claude" ] && CLAUDE="$HOME/.local/bin/claude"; } || true
[ -n "$CLAUDE" ] || warn "没有找到 claude CLI：装好并登录后才能开会话（https://code.claude.com/docs）"
command -v python3 >/dev/null || warn "没有 python3：“使用情况”窗格会报错，其余功能不受影响"

# 先定监听地址并检查参数，再下载安装，参数不对时什么都不改。
fresh=""
if [ -f "$UNIT" ]; then
  LISTEN=$(sed -n 's/^Environment="\{0,1\}HUBD_LISTEN=\([^" ]*\).*/\1/p' "$UNIT" | tail -1)
  LISTEN=${LISTEN:-127.0.0.1:7878}
else
  fresh=1
  if [ -z "$LISTEN" ]; then
    ts=$(command -v tailscale >/dev/null && tailscale ip -4 2>/dev/null | head -1 || true)
    LISTEN="${ts:-127.0.0.1}:7878"
  fi
  case "$LISTEN" in
    127.*|localhost:*|\[::1\]:*) ;;
    *) [ -n "$ALLOW" ] || die "监听 $LISTEN（不是本机）时必须用 --allow 指定允许连接的 Tailscale 账号" ;;
  esac
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if [ -n "$FROM" ]; then
  for f in hubd-linux-x86_64 cchub-usage.py; do
    [ -f "$FROM/$f" ] || die "$FROM 里没有 $f"
    cp "$FROM/$f" "$work/$f"
  done
else
  command -v curl >/dev/null || die "需要 curl"
  if [ -n "$VERSION" ]; then base="https://github.com/$REPO/releases/download/$VERSION"
  else base="https://github.com/$REPO/releases/latest/download"; fi
  for f in hubd-linux-x86_64 cchub-usage.py; do
    echo "下载 $f …"
    curl -fsSL --retry 3 -o "$work/$f" "$base/$f" || die "下载 $base/$f 失败"
  done
fi

# 装程序：旧的留成 .bak，出问题时可以换回去。
mkdir -p "$BIN_DIR"
put() {   # 源文件 目标名
  local dst="$BIN_DIR/$2"
  if [ -f "$dst" ]; then cp -p "$dst" "$dst.bak"; fi
  # 先写临时文件再改名：正在运行的 hubd 不受影响，重启后才换成新版本。
  install -m 755 "$1" "$dst.new" && mv -f "$dst.new" "$dst"
  echo "已安装 $dst"
}
put "$work/hubd-linux-x86_64" hubd
put "$work/cchub-usage.py" cchub-usage

if [ -z "$fresh" ]; then
  echo "已有 $UNIT，保留原配置"
else
  path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  [ -n "$CLAUDE" ] && path="$(dirname "$CLAUDE"):$path"
  mkdir -p "$UNIT_DIR"
  {
    echo "[Unit]"
    echo "Description=cchub hubd"
    echo "After=network-online.target tailscaled.service"
    echo "Wants=tailscaled.service"
    echo
    echo "[Service]"
    echo "ExecStart=$BIN_DIR/hubd"
    echo "Environment=HUBD_LISTEN=$LISTEN"
    [ -n "$ALLOW" ] && echo "Environment=HUBD_ALLOWED_USERS=$ALLOW"
    echo "Environment=HOME=$HOME"
    echo "Environment=PATH=$path"
    echo "Restart=on-failure"
    echo "RestartSec=3"
    echo "MemoryMax=64M"
    echo
    echo "[Install]"
    echo "WantedBy=multi-user.target"
  } > "$UNIT"
  echo "已写入 $UNIT（监听 $LISTEN）"
fi

if [ -n "$NO_SYSTEMCTL" ]; then
  echo "跳过 systemctl（CCHUB_NO_SYSTEMCTL）"
  exit 0
fi
systemctl daemon-reload
if [ -n "$fresh" ]; then systemctl enable --now hubd; else systemctl restart hubd; fi

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://$LISTEN/health" >/dev/null 2>&1; then
    echo
    echo "hubd 已运行：http://$LISTEN/health"
    echo "桌面端：从 https://github.com/$REPO/releases 下载 cchub-windows.exe（手机端 cchub.apk），"
    echo "首次打开时填服务器地址 ${LISTEN%:7878}。"
    exit 0
  fi
  sleep 1
done
die "hubd 没有在 $LISTEN 上响应，查看日志：journalctl -u hubd -n 50"
