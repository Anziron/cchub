# cchub

注意力优先的 Claude 长任务监督系统：服务器上跑常驻服务 `hubd`，由它托管 `claude` CLI 进程；桌面端只负责对话、看进度和做决定。

> 项目名暂定。当前是可验证的框架：同步链路已通，还没有真实界面。设计见 [docs/DESIGN.md](docs/DESIGN.md)。

## 目录

| 目录 | 内容 |
|---|---|
| `protocol/` | 线路消息和同步核心 |
| `client/` | 桌面端连接逻辑 |
| `server/` | `hubd` 和回放工具 `fake-claude` |
| `desktop/` | Tauri 2 桌面壳 |
| `web/` | React + Vite 前端 |
| `testdata/` | 脱敏后的录制数据 |
| `tools/record/` | 录制脚本 |
| `docs/` | 设计文档和实验脚本 |

## 开发

`hubd` 只支持 Linux；桌面端需要 [Tauri 的系统依赖](https://tauri.app/start/prerequisites/)。

```bash
npm install
npm run dev:web
npm run tauri dev

# 默认监听 127.0.0.1:7878；设备身份校验实现之前，hubd 拒绝非回环地址
HUBD_STATE_DIR=/tmp/hubd cargo run -p hubd --bin hubd
curl http://127.0.0.1:7878/health
```

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `HUBD_LISTEN` | `127.0.0.1:7878` | 监听地址，只允许回环地址 |
| `HUBD_STATE_DIR` | `/var/lib/hubd` | 会话目录 |
| `HUBD_HOST` | `systemd` | 进程托管方式：`systemd` 或 `direct` |
| `HUBD_CLAUDE_CMD` | `claude -p …` | 启动命令 |

## 检查

```bash
cargo fmt --all --check
cargo clippy -p cchub-protocol -p cchub-client -p hubd --all-targets -- -D warnings
cargo test -p cchub-protocol -p cchub-client -p hubd
bash scripts/check-budget.sh     # 需要 x86_64-unknown-linux-musl 目标
npm run build:web
```

用真实 `claude` 和 systemd 跑一次（消耗少量额度）：

```bash
cargo test -p hubd --test e2e -- --ignored
```
