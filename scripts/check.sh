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
step_rules() {
    RULE_COUNT=0
    RULE_BAD=0
    # （规则加在这里）
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
