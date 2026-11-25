#!/usr/bin/env bash
# 统一检查：本地和 CI（check 任务）跑的都是这个脚本。普通推送不触发 CI，提交前跑它是唯一的防线。
#
# 用法：bash scripts/check.sh [--fix] [-v] [步骤…]
#   步骤：fmt rules web webtest types clippy test（不写就全跑；总是按这个顺序，从快到慢）
#   --fix  先自动修所选步骤里能修的：fmt → cargo fmt --all；types → 重新生成 web/src/generated
#   -v     各步的输出直接打到终端（CI=true 时默认这样）；否则写进日志，失败时只打印末尾
# 需要：Linux（hubd 只支持 Linux）、Rust stable（带 rustfmt、clippy）、Node 22+，并已在仓库根目录 npm ci。
# 退出码：0 全部通过；1 有步骤失败；2 用法或环境有问题。
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
SELF=$ROOT/scripts/check.sh

ALL_STEPS=(fmt rules web webtest types clippy test)
# 桌面端（Tauri）在 Linux 上缺 GTK，由 CI 的 desktop 任务在 Windows 上查；这里不要用 --workspace。
CRATES=(-p cchub-protocol -p cchub-client -p hubd)

# 数组都要初始化：脚本里 set -u 碰到未定义的变量只中止当前那条复合命令，后面照跑，会变成“一步没跑也算通过”。
declare -A TITLE=() HINT=() RESULT=() TIME=() WANT=()
TITLE[fmt]="Rust 格式"
HINT[fmt]="跑 scripts/check.sh --fix fmt（即 cargo fmt --all）自动格式化"
TITLE[rules]="仓库规则（$(grep -c '^    rule "' "$SELF") 条）"
HINT[rules]="按上面每条违例下面的说明改"
TITLE[web]="前端构建（tsc + vite）"
HINT[web]="按报错改代码"
TITLE[webtest]="前端测试"
HINT[webtest]="单个文件：cd web && node --test test/<名字>.test.ts"
TITLE[types]="前端类型和 Rust 一致"
HINT[types]="改了线路类型就重新生成：scripts/check.sh --fix types；不要手改 web/src/generated"
TITLE[clippy]="Rust lint（clippy，警告也算失败）"
HINT[clippy]="按提示改代码"
TITLE[test]="Rust 测试"
HINT[test]="看日志里的 failures 一段；单个测试：cargo test -p <crate> <测试名>"

usage() { sed -n '4,9p' "$SELF" | sed 's/^# \{0,1\}//'; }

FIX=0
VERBOSE=0
[ "${CI:-}" = true ] && VERBOSE=1
for a in "$@"; do
    case "$a" in
        --fix) FIX=1 ;;
        -v | --verbose) VERBOSE=1 ;;
        -h | --help) usage; exit 0 ;;
        -*) echo "未知参数：$a" >&2; usage >&2; exit 2 ;;
        *)
            [ -n "${TITLE[$a]:-}" ] || { echo "没有这个步骤：$a（可选：${ALL_STEPS[*]}）" >&2; exit 2; }
            WANT[$a]=1
            ;;
    esac
done
STEPS=()
for s in "${ALL_STEPS[@]}"; do
    if [ ${#WANT[@]} -eq 0 ] || [ -n "${WANT[$s]:-}" ]; then STEPS+=("$s"); fi
done
[ ${#STEPS[@]} -gt 0 ] || { echo "check.sh: 一个步骤都没选上（脚本出错了？）" >&2; exit 2; }
wants() { [[ " ${STEPS[*]} " == *" $1 "* ]]; }

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少 $1：$2" >&2; exit 2; }; }
if wants fmt || wants types || wants clippy || wants test; then need cargo "装 Rust stable（rustup，带 rustfmt、clippy）"; fi
if wants web || wants webtest; then
    need npm "装 Node 22 或更新的版本"
    [ -d node_modules ] || { echo "缺少 node_modules：先在仓库根目录跑 npm ci" >&2; exit 2; }
fi

LOG_DIR=${CHECK_LOG_DIR:-$ROOT/target/check-logs}
mkdir -p "$LOG_DIR"
TAIL=60
if [ "$VERBOSE" != 1 ]; then
    export CARGO_TERM_COLOR=${CARGO_TERM_COLOR:-never} NO_COLOR=1
fi

# ---- 各步 ----

export_types() { TS_RS_EXPORT_DIR="$1" cargo test -p cchub-protocol --features ts --locked export_bindings; }

step_fmt() { cargo fmt --all --check; }
step_web() { npm run build:web; }
step_webtest() { npm test -w web; }
step_clippy() { cargo clippy "${CRATES[@]}" --all-targets --locked -- -D warnings; }
step_test() { cargo test "${CRATES[@]}" --locked; }

step_types() {
    local tmp rc
    tmp=$(mktemp -d)
    if ! export_types "$tmp"; then rm -rf "$tmp"; return 1; fi
    echo "---- 比对 web/src/generated（-）和按 Rust 生成的（+）----"
    diff -ru web/src/generated "$tmp"
    rc=$?
    rm -rf "$tmp"
    return $rc
}

# ---- 仓库规则：grep 一类的轻量检查 ----
# 每条写成：rule "<规则>" "<违反时怎么改>" <命令…>。命令输出任何内容就算违反，输出的就是违例位置。
# 加一条规则，就删掉 AGENTS.md 里对应的文字条目。
RULE_COUNT=0
RULE_BAD=0
rule() {
    local name=$1 fix=$2 out
    shift 2
    RULE_COUNT=$((RULE_COUNT + 1))
    out=$("$@" 2>&1)
    if [ -n "$out" ]; then
        RULE_BAD=$((RULE_BAD + 1))
        printf '✗ %s\n%s\n  → %s\n' "$name" "$out" "$fix"
    fi
}
# 在前端的 .ts / .tsx 里找（不含 Rust 生成的类型）。
web_grep() { grep -rnE --include='*.ts' --include='*.tsx' --exclude-dir=generated "$@" web/src; }

mask_used() {
    grep -rnE --include='*.css' '(^|[^-[:alnum:]])(-webkit-)?mask(-image)?[[:space:]]*:' web/src
    web_grep '[mM]askImage[[:space:]]*:'
}

demo_not_awaited() {
    web_grep "from ['\"]\./demo(\.ts)?['\"]|import\(['\"]\./demo(\.ts)?['\"]\)" | grep -v 'await import("./demo.ts")'
}

# 没写扩展名的相对导入（含 import()、只为副作用的 import "…"）；带 ?raw 这类查询串的放行。
import_without_ext() {
    grep -rnE --include='*.ts' --include='*.tsx' --exclude-dir=generated \
        "(from|import)[[:space:]]*\(?[[:space:]]*['\"]\.{1,2}/[^'\"?]*['\"]" web/src web/test |
        grep -vE "['\"]\.{1,2}/[^'\"?]*\.(tsx?|css|json)['\"]"
}

case_clash() { git ls-files | sort -f | uniq -di; }

ps1_without_bom() {
    local f
    git ls-files '*.ps1' | while IFS= read -r f; do
        [ "$(head -c3 "$f" | od -An -tx1 | tr -d ' \n')" = efbbbf ] || echo "$f"
    done
}

# 录制里的邮箱、Tailscale 地址（100.64/10、fd7a:115c:a1e0::/48）、令牌、本机路径；record.py 换上的占位值放行。
unredacted() {
    grep -rnoE \
        -e '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' \
        -e '\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}\b' \
        -e '[Ff][Dd]7[Aa]:115[Cc]:[Aa]1[Ee]0' \
        -e 'sk-ant-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}' \
        -e '/root/|/home/[A-Za-z0-9._-]+|/Users/[A-Za-z0-9._-]+|[A-Za-z]:\\+Users\\+[A-Za-z0-9._-]+|/mnt/[A-Za-z0-9._-]+' \
        testdata | grep -vE ':(user@example\.com|100\.64\.0\.1|/home/user)$'
}

step_rules() {
    RULE_COUNT=0
    RULE_BAD=0
    rule "前端发给 claude 的输入只走 store.ts 的 input()" \
        "改用 store.input()：它带 id、登记回执回调；控制消息用 store.control()" \
        web_grep --exclude=store.ts 'type: *"input"'
    rule "外部链接只走 platform.ts 的 openUrl" \
        "改用 openUrl：桌面端经 desktop.rs 的 open_url 打开（只放行 http/https），window.open、target=_blank 在 exe 里不可靠" \
        web_grep --exclude=platform.ts 'window\.open\(|_blank'
    rule "读秒、动画、定时刷新按 pageVisible() 暂停，不用 document.hasFocus()" \
        "用 pageVisible()（visibilityState）：用户常把窗口放在旁边看着，焦点在别处时界面会像卡住" \
        web_grep 'hasFocus'
    rule "不用 mask-image 做渐隐" \
        "用吸顶 / 吸底的渐变伪元素（见 styles.css 的 .stream::before）：带遮罩的区域里有转圈、呼吸点这类无限动画时，整块每帧重新合成，GPU 一直忙" \
        mask_used
    rule "不把 HTML 字符串塞进界面" \
        "用 React 渲染文本或元素：工具输出、模型回复里都可能带 HTML" \
        web_grep 'innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML'
    rule "demo 在渲染前加载完" \
        "只在 main.tsx 里 await import(\"./demo.ts\")：它顶层按地址参数重置本地存储（宽度、收起、设备筛选），晚加载时界面先读到上一张截图残留的值" \
        demo_not_awaited
    rule "前端模块之间没有运行时循环导入" \
        "把两边共用的函数挪进纯逻辑模块（model.ts 等），组件之间只单向依赖：循环时谁先初始化取决于加载顺序，可能拿到 undefined" \
        node scripts/import-cycles.mjs web/src
    rule "前端相对导入写全扩展名" \
        "写成 ./xxx.ts、./xxx.tsx：web/test 用 node --test 直接跑源码，Node 不会补扩展名，漏写的模块在测试里加载不了" \
        import_without_ext
    rule "文件名不能只差大小写" \
        "改名：设备是 Windows，只差大小写的两个文件会被当成同一个（tsc 报 TS1149；侧栏组件因此叫 SessionList.tsx）" \
        case_clash
    rule ".ps1 存成带 BOM 的 UTF-8" \
        "加上 BOM：设备上的 PowerShell 5 把无 BOM 的 .ps1 按 GBK 读，中文注释以全角标点结尾时会吞掉下一行" \
        ps1_without_bom
    rule "录制里没有没脱敏的内容（邮箱、令牌、Tailscale 地址、本机路径）" \
        "用 tools/record/record.py 重录，或照它的规则替换：邮箱 → user@example.com，Tailscale 地址 → 100.64.0.1，家目录 → /home/user，项目目录 → /work" \
        unredacted
    echo "规则 $RULE_COUNT 条，违反 $RULE_BAD 条"
    [ "$RULE_BAD" -eq 0 ]
}

# ---- 自动修 ----

if [ "$FIX" = 1 ]; then
    if wants fmt; then
        echo "== 修：cargo fmt --all"
        cargo fmt --all || echo "（cargo fmt 失败，下面的 fmt 一步会显示原因）"
    fi
    if wants types; then
        echo "== 修：重新生成 web/src/generated"
        tmp=$(mktemp -d)
        if export_types "$tmp" >"$LOG_DIR/fix-types.log" 2>&1 && [ -n "$(ls -A "$tmp")" ]; then
            rm -rf web/src/generated
            mkdir -p web/src/generated
            cp -R "$tmp"/. web/src/generated/
        else
            echo "（生成失败，没有改动 web/src/generated；日志：$LOG_DIR/fix-types.log）"
        fi
        rm -rf "$tmp"
    fi
fi

# ---- 依次运行，失败也继续 ----

run_step() {
    local s=$1 log="$LOG_DIR/$1.log" t0=$SECONDS rc
    echo "== $s：${TITLE[$s]}"
    [ "${GITHUB_ACTIONS:-}" = true ] && echo "::group::$s"
    if [ "$VERBOSE" = 1 ]; then
        "step_$s" 2>&1 | tee "$log"
        rc=${PIPESTATUS[0]}
    else
        "step_$s" >"$log" 2>&1
        rc=$?
    fi
    [ "${GITHUB_ACTIONS:-}" = true ] && echo "::endgroup::"
    RESULT[$s]=$rc
    TIME[$s]=$((SECONDS - t0))
    [ "$rc" -eq 0 ] && return
    if [ "$VERBOSE" != 1 ]; then
        echo "---- $s 的日志末尾（全文：$log）----"
        tail -n "$TAIL" "$log"
        echo "----"
    fi
    echo "  → 变红时：${HINT[$s]}"
    if grep -q 'SIGKILL' "$log"; then echo "  → 日志里有 SIGKILL：多半是内存不够，进程被系统结束了"; fi
    [ "${GITHUB_ACTIONS:-}" = true ] && echo "::error title=check::$s（${TITLE[$s]}）失败"
}

for s in "${STEPS[@]}"; do run_step "$s"; done

echo
echo "== 检查结果 =="
failed=0
for s in "${STEPS[@]}"; do
    # 没有结果的步骤（没跑到）也算失败
    if [ "${RESULT[$s]:-x}" = 0 ]; then mark="✓"; else mark="✗"; failed=$((failed + 1)); fi
    printf '%s %-8s %5ss  %s\n' "$mark" "$s" "${TIME[$s]:-?}" "${TITLE[$s]}"
done
if [ "$failed" -gt 0 ]; then
    echo "$failed 项失败（日志在 $LOG_DIR）"
    exit 1
fi
echo "全部通过"
