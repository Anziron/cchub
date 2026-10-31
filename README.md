# cchub

轻量的 Claude 桌面客户端：服务器上跑常驻服务 `hubd`，由它管理 `claude` CLI 进程；桌面端只负责对话、看进度和审批。

> 项目名暂定。当前只有框架，还没有实现业务功能。

## 目录

| 目录 | 内容 |
|---|---|
| `server/` | `hubd`，Rust 服务端 |
| `protocol/` | `hubd` 和桌面端共用的类型 |
| `desktop/` | Tauri 2 桌面壳 |
| `web/` | React + Vite 前端 |

## 开发

需要 Rust stable 和 Node 22；桌面端还需要 [Tauri 的系统依赖](https://tauri.app/start/prerequisites/)。

```bash
npm install

# 前端
npm run dev:web
npm run build:web

# 服务端，默认监听 127.0.0.1:7878，可用 HUBD_LISTEN 修改
cargo run -p hubd
curl http://127.0.0.1:7878/health

# 桌面端
npm run tauri dev
```

## 检查

```bash
cargo fmt --all --check
cargo clippy -p hubd -p cchub-protocol --all-targets -- -D warnings
cargo test -p hubd -p cchub-protocol
npm run build:web
```
