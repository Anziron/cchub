# cchub

注意力优先的 Claude 长任务监督系统。任务在服务器上持续运行，关掉电脑也不会中断；只有需要你决定时才通知你。

- **`hubd`**：服务器上的常驻服务，用 systemd 托管官方 `claude` CLI 进程，只做转发和进程管理。
- **桌面端**（Tauri + React）：对话、查看进度、审批和回答提问，断线后自动补齐消息。

> **早期项目。** 作者自己在日常使用，接口和部署方式还会变，暂时没有安装包和安装脚本。
>
> 这是个人项目，与 Anthropic 没有关联，也未获其认可。它调用你自己安装并登录的 `claude` CLI，请自行确认你的用法符合所用账号的服务条款。

设计和实测记录见 [docs/DESIGN.md](docs/DESIGN.md)。

## 功能

- 会话独立于桌面端运行，`hubd` 重启或桌面端断线都不影响正在执行的任务
- 审批、提问、方案确认以卡片显示，并发送系统通知
- 按工作区管理会话，可切换模型，支持 `/` 命令
- 显示上下文占用、5 小时和每周额度
- 后台任务面板：查看状态和输出，可单独停止
- 单独显示设备状态：项目可经 sshfs 挂载在其他设备上，离线时会提示
- 占用资源少：`hubd` 常驻目标约 5～10MB

## 环境要求

| 位置 | 要求 |
|---|---|
| 服务器 | Linux 和 systemd，已安装并登录 `claude` CLI，建议安装 Tailscale |
| 桌面端 | 目前主要在 Windows 上使用；从源码构建需要 [Tauri 的系统依赖](https://tauri.app/start/prerequisites/) |

## 安全须知

`hubd` 以运行它的用户身份启动 `claude`，能连上它的人就能操作服务器上的文件和命令。

- 只允许监听回环或 Tailscale 地址，连接没有加密层和令牌认证，不要用反向代理暴露到公网。
- 监听 Tailscale 地址时必须设置 `HUBD_ALLOWED_USERS`。
- 会话目录保存完整的对话日志，注意目录权限。

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
| `docs/` | 设计文档和界面原型 |

## 开发

```bash
npm install
npm run dev:web      # 只看前端：打开 /?s=rich&theme=dark，用录制数据驱动界面
npm run tauri dev    # 桌面端

# hubd 只支持 Linux，默认监听 127.0.0.1:7878
HUBD_STATE_DIR=/tmp/hubd cargo run -p hubd --bin hubd
curl http://127.0.0.1:7878/health
```

CI 会构建 `hubd` 静态二进制和 Windows 桌面端，产物在 Actions 页面下载（需要登录 GitHub）。

## 配置

`hubd` 只读环境变量：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `HUBD_LISTEN` | `127.0.0.1:7878` | 监听地址，只允许回环或 Tailscale 地址 |
| `HUBD_ALLOWED_USERS` | 空 | 允许连接的 Tailscale 账号，逗号分隔；监听 Tailscale 地址时必填 |
| `HUBD_STATE_DIR` | `/var/lib/hubd` | 会话目录 |
| `HUBD_RETENTION_DAYS` | `7` | 进程已结束的会话日志保留天数 |
| `HUBD_HOST` | `systemd` | 进程托管方式：`systemd` 或 `direct` |
| `HUBD_CLAUDE_CMD` | `claude -p …` | 启动命令 |
| `HUBD_SESSION_MEMORY_MAX_MB` | `600` | 每个会话的内存上限，`0` 表示不限 |
| `HUBD_MIN_AVAILABLE_MB` | `300` | 可用内存低于此值时拒绝启动新会话，`0` 表示不检查 |
| `HUBD_WORKSPACE_CMD` | `cc-workspace` | 工作区命令，见下 |

### 工作区命令

在新建会话时浏览和挂载设备目录，要自己提供，本仓库不含实现。约定如下：

| 子命令 | 输出 |
|---|---|
| `devices` | 每行一个设备名 |
| `ls <设备> [路径]` | 第 1 行当前路径，第 2 行上一级，之后每行一个子目录的完整路径 |
| `mount <设备> <路径>` | 服务器上的路径 |

## 检查

```bash
cargo fmt --all --check
cargo clippy -p cchub-protocol -p cchub-client -p hubd --all-targets -- -D warnings
cargo test -p cchub-protocol -p cchub-client -p hubd
bash scripts/check-budget.sh     # 需要 x86_64-unknown-linux-musl 目标
npm run build:web
npm test -w web
```

用真实 `claude` 和 systemd 跑一次（消耗少量额度）：

```bash
cargo test -p hubd --test e2e -- --ignored
```

## 许可证

暂未选择开源许可证。在添加许可证之前，代码版权归作者所有，公开只代表可以查看。
