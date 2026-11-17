# cchub

在自己的服务器上跑 Claude Code 长任务，用桌面端和手机端查看进度、审批和回答提问。任务在服务器上持续运行，关掉电脑也不会中断；需要你决定时才通知你。

- **`hubd`**：服务器上的常驻服务，用 systemd 托管官方 `claude` CLI 进程。
- **桌面端 / 手机端**：对话、查看进度、审批，断线后自动补齐消息。

## 功能

- 会话独立于桌面端运行，断线或重启 `hubd` 都不影响正在执行的任务
- 审批、提问、方案确认以卡片显示，并发送系统通知
- 会话按设备和项目分组，可切换模型和推理强度，支持 `/` 命令
- 显示上下文占用、5 小时和每周额度，以及按模型、项目统计的使用情况
- 后台任务面板：查看状态和输出，可单独停止
- 项目可以在其他设备上（经 sshfs 挂载），设备离线时会提示
- 占用资源少：`hubd` 常驻约 5～10MB

## 安装

需要：一台 Linux 服务器（systemd），装好并登录 `claude` CLI，建议装 Tailscale。

以 root 运行：

```bash
curl -fsSL https://github.com/Anziron/cchub/releases/latest/download/install-server.sh | bash -s -- --allow <你的 Tailscale 账号>
```

脚本会安装 `hubd` 和使用情况统计命令，写好 systemd 服务（默认监听本机 Tailscale 地址的 7878 端口，`--listen` 可改）并启动。升级时运行同一条命令，不用加 `--allow`。

然后从 [Releases](https://github.com/Anziron/cchub/releases) 下载桌面端 `cchub-windows.exe` 或手机端 `cchub.apk`，首次打开时填服务器的 Tailscale 地址（改过端口时写成 `IP:端口`）。升级桌面端前先从托盘菜单退出旧版本。

## 安全须知

- `hubd` 以运行它的用户身份启动 `claude`，能连上它的人就能操作服务器上的文件和命令。
- 只监听回环或 Tailscale 地址，不要用反向代理暴露到公网；监听 Tailscale 地址时必须设置 `HUBD_ALLOWED_USERS`。
- 会话目录保存完整的对话日志，注意目录权限。

## 配置

`hubd` 只读环境变量（写在 systemd 服务文件里）：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `HUBD_LISTEN` | `127.0.0.1:7878` | 监听地址，只允许回环或 Tailscale 地址 |
| `HUBD_ALLOWED_USERS` | 空 | 允许连接的 Tailscale 账号，逗号分隔；监听 Tailscale 地址时必填 |
| `HUBD_STATE_DIR` | `/var/lib/hubd` | 会话目录 |
| `HUBD_RETENTION_DAYS` | `7` | 进程已结束的会话日志保留天数 |
| `HUBD_CLAUDE_CMD` | `claude -p …` | 启动命令。要用 API Key 时在 `hubd` 的环境里设置 `ANTHROPIC_API_KEY` |
| `HUBD_SESSION_MEMORY_MAX_MB` | `600` | 每个会话的内存上限，`0` 表示不限 |
| `HUBD_MIN_AVAILABLE_MB` | `100` | 可用内存低于此值时不启动新会话，`0` 表示不检查 |
| `HUBD_IDLE_MINUTES` | `10` | 会话空闲这么久就结束进程，下次发消息自动恢复；`0` 表示不回收 |
| `HUBD_WORKSPACE_CMD` | `cc-workspace` | 工作区命令，见下 |
| `HUBD_USAGE_CMD` | `cchub-usage` | 使用情况统计命令，为空时关闭 |

### 工作区命令

新建会话时浏览、挂载其他设备的目录，要自己提供一个命令（本仓库不含实现）；没有它也能用，新建会话时手填服务器上的目录即可。

| 子命令 | 输出 |
|---|---|
| `devices` | 每行一个设备名 |
| `ls <设备> [路径]` | 第 1 行当前路径，第 2 行上一级，之后每行一个子目录的完整路径 |
| `status` | 每行 `设备<Tab>系统<Tab>online 或 offline`，系统可留空 |
| `mount <设备> <路径>` | 服务器上的路径 |

## 许可证

[MIT](LICENSE)。本项目与 Anthropic 没有关联。
