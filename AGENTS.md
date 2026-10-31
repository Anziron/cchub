# cchub 项目规则

设计方案、硬约束和验收指标见 `docs/DESIGN.md`，改动前先读。

## 结构

| 目录 | 内容 |
|---|---|
| `protocol/` | 线路消息、信封分类、`sans-IO` 同步核心，不碰网络和文件 |
| `client/` | 桌面端连接逻辑，不依赖 Tauri |
| `server/` | `hubd`（只支持 Linux）和回放工具 `fake-claude` |
| `desktop/` | Tauri 壳，连接在 Rust 进程里 |
| `web/` | 前端，只走 IPC；`src/generated/` 由 Rust 生成，不要手改 |
| `testdata/recordings/` | 脱敏后的真实录制，由 `tools/record/record.py` 生成 |

## 约束

- `hubd` 只做转发和进程管理，只解析事件信封（类型、序号、状态），不解析正文，不渲染；Markdown、diff、高亮、搜索都放在桌面端。
- 同步逻辑放进 `protocol`，用 `protocol/tests/simulation.rs` 验证；不能丢的事件绝不能被标记为已跳过。
- 改了线路类型要重新生成前端类型：`TS_RS_EXPORT_DIR=$PWD/web/src/generated cargo test -p cchub-protocol --features ts export_bindings`。
- 资源目标：`hubd` 常驻约 5～10MB；桌面端在托盘 < 20MB，窗口空闲 < 150MB。`scripts/check-budget.sh` 检查 `hubd`。
- 桌面端不引入大型 UI 框架和图表库，样式用 CSS；不使用 Anthropic 的 logo 和品牌素材。
- 不用数据库，历史记录读 `claude` 的 `.jsonl`，运行中的事件以会话目录的 `out` 文件为准。
- 录制数据入库前必须脱敏，不能出现邮箱、令牌、Tailscale 地址、本机路径。

## 已知坑

- FIFO 的最后一个 fd 关闭时缓冲数据会丢失：要先打开 FIFO 并持有，再启动进程。
- 只读命令（如 `cat`）可能不发审批请求，模型也可能把前台命令改成后台，测试脚本不能假设一定有审批，或一轮结束时任务已完成。
- sshfs 缓存文件属性：断网后 `stat` 已缓存的文件仍然成功，探测必须查新的文件名。
- 卡在断开挂载上的进程连 `SIGKILL` 都杀不掉（D 状态），要等连接恢复；不要等待这类子进程，同一路径同时只跑一个探测。
- 切换模型要用 `set_model` 控制消息；`/model` 回复成功但不生效。内置命令的输出会写进会话记录并占上下文，不要自动定时调用。
- 中断后 `result` 是 `error_during_execution`、`is_error: true`，界面不能显示成任务失败。
- 录制 `plan` 场景会在 `~/.claude/plans/` 留下方案文件，录完要删。
- 前端的 `demo.ts` 只在开发时用录制驱动界面：`npm run dev:web` 后打开 `/?s=rich&theme=dark`。经 `pcrun` 启动的开发服务器随 SSH 会话退出，要和截图放在同一条命令里。
- 设备没有 Rust，桌面端由 CI 编译，可执行文件在 Actions 的 `cchub-windows` 产物里。
- 服务器上的 `claude` 受用户配置影响可能不发审批请求，要测审批时加 `--setting-sources project,local`。
- CLI 会拦截 `sleep 60; ...` 这类命令，实验里要用脚本文件代替。
- `hubd` 不认任何参数（除 `--probe`），`hubd --version` 会真的启动并用默认状态目录 → 手动运行时必须设临时 `HUBD_STATE_DIR` 和回环端口。
- 部署 `hubd` 用 CI 产物 `hubd-linux-musl`，服务器和设备都没有 Rust。
- 弱网测试不要动服务器真实网卡（代理和会话都走它）→ 用 `ip netns` 建独立命名空间，在其回环上加 `netem`。
- 桌面端关窗后进程留在托盘，再双击 exe 曾启动第二个实例，两份连接和通知同时存在 → 现在靠占用 `127.0.0.1:47878` 保证单实例；升级 exe 前要先从托盘菜单退出旧进程，否则只会唤起旧版本。
- 测桌面端内存要沿父进程树汇总私有工作集：工作集含共享内存，且设备上还有别的程序的 WebView。
