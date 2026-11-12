# cchub

用于监督 Claude Code 长任务的自托管工具，注意力优先。任务在服务器上持续运行，关掉电脑也不会中断；只有需要你决定时才通知你。

- **`hubd`**：服务器上的常驻服务，用 systemd 托管官方 `claude` CLI 进程，只做转发和进程管理。
- **桌面端**（Tauri + React）：对话、查看进度、审批和回答提问，断线后自动补齐消息。

> **早期项目。** 作者自己在日常使用，接口和部署方式还会变。
>
> 这是个人项目，与 Anthropic 没有关联，也未获其认可。

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

## 使用规则

cchub 只启动你自己安装的官方 `claude` CLI，不修改它，也不读取、保存或转发任何 Claude 凭据。登录由 CLI 自己完成，用量算在你自己的账号上。使用时仍须遵守 [Claude Code 的法律与合规说明](https://code.claude.com/docs/en/legal-and-compliance) 和对应的服务条款：

- **自己用**：部署在自己的服务器上，用自己的账号登录。不要共享账号，也不要让别人使用你的账号。
- **订阅账号的用量**：官方说明里的订阅额度以普通的个人使用为前提。
- **做成产品或服务给别人用**：官方要求开发者使用 API Key（或受支持的云服务商），不得代用户转发订阅账号的请求，也不得代为购买或转售用量。在产品或服务里运行 Claude Code 还需要同意商业条款，每个用户都要用自己的凭据认证。cchub 的 MIT 许可证只覆盖本仓库代码，不包含任何 Claude 或 Claude Code 的使用权。
- **名称和商标**：Claude 和 Anthropic 是 Anthropic 的商标，不能用于你自己的产品名或 logo，也不能暗示获得了对方认可。

以上是作者对官方文档的理解，不构成法律意见，条款也可能变化，以官方最新内容为准。拿不准时请直接询问 Anthropic。

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

CI 只在推 `v*` 标签（发布）或在 Actions 页面手动运行时构建 `hubd` 静态二进制、Windows 桌面端和 Android APK。正式版本在 Releases；手动运行的产物在 Actions 页面下载（需要登录 GitHub）。

## 部署

安装包在 [Releases](https://github.com/Anziron/cchub/releases)：`hubd-linux-x86_64`（服务器）、`cchub-usage.py`（使用情况统计）、`install-server.sh`（安装脚本）、`cchub-windows.exe`（桌面端）、`cchub.apk`（手机端）。

### 一键安装（推荐）

服务器上先装好 Tailscale，再装好 `claude` CLI 并登录（`hubd` 用运行它的用户的登录状态），然后以 root 运行：

```bash
curl -fsSL https://github.com/Anziron/cchub/releases/latest/download/install-server.sh | bash -s -- --allow <你的 Tailscale 账号>
```

脚本做这几件事：把 `hubd` 和统计命令装到 `/usr/local/bin/`（旧的留成 `.bak`）；第一次运行时写 `/etc/systemd/system/hubd.service`，默认监听本机 Tailscale 地址的 7878 端口，可用 `--listen` 改；然后启动服务，用 `/health` 检查。升级时运行同一条命令，不用加 `--allow`：已有服务文件就不改配置，只换程序并重启。`--version v0.1.0` 安装指定版本，`--from <目录>` 用本地文件。

桌面端下载 `cchub-windows.exe`、手机端安装 `cchub.apk`，首次打开时填服务器的 Tailscale 地址（默认端口 7878，改过端口时写成 `IP:端口`）。升级桌面端前先从托盘菜单退出旧进程。

### 手动安装

以 root 运行、systemd 托管为例：

1. 在服务器上装好 `claude` CLI 并登录。
2. 把 `hubd`（Release 里的 `hubd-linux-x86_64`，或 `cargo build --release -p hubd`）放到 `/usr/local/bin/hubd`。
3. 安装使用情况统计命令：`install -m 755 cchub-usage.py /usr/local/bin/cchub-usage`（需要 Python 3）。不装的话“使用情况”窗格会报错，其余功能不受影响。
4. 写 systemd 服务，例如 `/etc/systemd/system/hubd.service`：

   ```ini
   [Unit]
   Description=cchub hubd
   After=network-online.target tailscaled.service

   [Service]
   ExecStart=/usr/local/bin/hubd
   # 只监听本机时可省略；监听 Tailscale 地址时必须同时设置 HUBD_ALLOWED_USERS
   Environment=HUBD_LISTEN=<Tailscale 地址>:7878
   Environment=HUBD_ALLOWED_USERS=<你的 Tailscale 账号>
   # claude 装在用户目录时要让 hubd 找得到它
   Environment=HOME=/root
   Environment=PATH=/root/.local/bin:/usr/local/bin:/usr/bin:/bin
   Restart=on-failure
   MemoryMax=64M

   [Install]
   WantedBy=multi-user.target
   ```

   然后 `systemctl daemon-reload && systemctl enable --now hubd`，用 `curl http://<地址>:7878/health` 检查。
5. 桌面端同上。

浏览、挂载设备目录要自己提供工作区命令（见下），没有它也能用：新建会话时手填服务器上的目录。

### 发布新版本（维护者）

推一个 `v*` 标签（如 `git tag v0.1.0 && git push origin v0.1.0`），CI 全部任务通过后自动创建 Release 并上传上面的文件和 `SHA256SUMS`。

## 配置

`hubd` 只读环境变量：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `HUBD_LISTEN` | `127.0.0.1:7878` | 监听地址，只允许回环或 Tailscale 地址 |
| `HUBD_ALLOWED_USERS` | 空 | 允许连接的 Tailscale 账号，逗号分隔；监听 Tailscale 地址时必填 |
| `HUBD_STATE_DIR` | `/var/lib/hubd` | 会话目录 |
| `HUBD_RETENTION_DAYS` | `7` | 进程已结束的会话日志保留天数 |
| `HUBD_HOST` | `systemd` | 进程托管方式：`systemd` 或 `direct` |
| `HUBD_CLAUDE_CMD` | `claude -p …` | 启动命令。要用 API Key 时，在 `hubd` 的环境里设置 `ANTHROPIC_API_KEY`，`-p` 模式下会优先使用它 |
| `HUBD_SESSION_MEMORY_MAX_MB` | `600` | 每个会话的内存上限，`0` 表示不限 |
| `HUBD_MIN_AVAILABLE_MB` | `100` | 可用内存低于此值时拒绝启动新会话，`0` 表示不检查 |
| `HUBD_IDLE_MINUTES` | `10` | 会话空闲（这一轮已结束、没有后台任务）这么久就结束进程，下次发消息自动恢复；`0` 表示不回收 |
| `HUBD_WORKSPACE_CMD` | `cc-workspace` | 工作区命令，见下 |
| `HUBD_USAGE_CMD` | `cchub-usage` | 使用情况统计命令（`tools/usage/cchub-usage.py`），为空时关闭 |

### 工作区命令

在新建会话时浏览和挂载设备目录，要自己提供，本仓库不含实现。约定如下：

| 子命令 | 输出 |
|---|---|
| `devices` | 每行一个设备名 |
| `ls <设备> [路径]` | 第 1 行当前路径，第 2 行上一级，之后每行一个子目录的完整路径 |
| `status` | 每行 `设备<Tab>系统<Tab>online 或 offline`，系统可留空；侧栏的设备状态用它 |
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

[MIT](LICENSE)
