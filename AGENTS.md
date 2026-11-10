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
- 模型列表来自 `initialize` 控制消息的 `models` → 可重复发送，不调用模型，回复进 `out` 但不进 `.jsonl`；重放 `out` 会读到旧回复，所以只认当次的 `request_id`。
- 乐观显示靠用户消息的 `uuid` → `--replay-user-messages` 回传时保持同一个 `uuid`，用它确认送达，不要按文字匹配。
- 工作区浏览和挂载调用外部命令 `cc-workspace`（可用 `HUBD_WORKSPACE_CMD` 替换）→ 部署新 `hubd` 前先 `cc-config apply`；`/mnt/<设备>/` 只有已挂载的项目，不能靠浏览服务器目录找新项目。
- `Frame.ts` 内联了一份 `ServerMsg` → 没有 Rust 不能本地生成时，手改 `ServerMsg` 要连它一起改；CI 的 `types` 任务会打印差异。
- `/` 命令的回传带同一个 `uuid`，但正文变成 `<command-name>` 标记，且排在回复之后 → 显示时要还原。
- 后台 Bash 可能先 `task_started`（`is_backgrounded: false`）再由 `task_updated` 转后台，以 `background_tasks_changed` 为准；这些事件没有时间戳，开始时间只能由客户端记。
- 额度和上下文不要调用 `/usage`、`/context`（写进会话记录）→ 用 `rate_limit_event` 和最后一条 `assistant` 的 `usage`。
- 官方会在窗口中途把额度清零，`resetsAt` 不变 → 合并额度不能按使用率大小判断新旧，要按事件来源（同一会话比 `seq`，不同会话比运行状态和日志更新时间）。
- `set_model` 会让 CLI 回显一条 `type: user` 的 `<local-command-stdout>Set model to …</local-command-stdout>`（会话记录里带 `/model` 命令名），模型能看到但不会回复 → 显示成提示，不能当用户消息，也不能把状态改成思考中。
- 进程已回收时往 FIFO 写 `set_model` 会丢 → 前端记下 `pendingModel`，恢复进程时在用户消息之前补发。
- 标题由 `hubd` 后台跑 `HUBD_TITLE_CMD`（默认 haiku）生成：`hubd` 的 `MemoryMax` 只有 64M，systemd 模式下必须用 `systemd-run --scope` 放进独立 cgroup；超时要结束整个进程组。
- CLI 常发内容为空的思考块，同一条消息里还可能一空一实 → 空块不显示，不要当成“思考过”。
- 技能正文等 CLI 注入的消息也是 `type: user`，实时事件带 `isSynthetic`，`.jsonl` 里带 `isMeta` → 两个都要过滤，不能显示成用户气泡。
- `input` 只是写进 FIFO，进程卡住或没启动时不报错也没有回复 → 中断要靠客户端超时提示，不能只等 `result`。
- 官方说 `--bare` 将成为 `-p` 的默认模式，它不读订阅登录，也不加载技能、`CLAUDE.md`、MCP → 升级 `claude` 后如果会话报未登录或技能消失，先查这个。
- 启动失败时目录也要先记下，并且丢弃紧跟着的 `Input` → 否则重试会退回会话目录，消息也会留在 FIFO 里被重复处理。
- Android 上 Activity 销毁后，`run_mobile_plugin` 和页面发起的 IPC 都会让 wry 以 `no available activity` panic，进程直接退出 → 通知和状态走本地 socket 发给前台服务；界面销毁时同时销毁 WebView。
- Android 上最后一个窗口销毁时 Tauri 会退出进程，要在 `ExitRequested` 里 `prevent_exit`；之后同一进程不能重建界面（白屏）→ 新 Activity 出现时由 `RestartActivity` 换一个干净的进程。
- `hubd` 不推送会话列表，订阅原本全由界面发起 → 手机端用 `HubClient::watching` 定时取列表并自动订阅，否则后台收不到别处新开会话的审批。
- `android-smoke.sh` 全绿不等于界面正常，曾经白屏也通过 → 要检查界面内容并看 `android-shots` 截图。`HUBD_CLAUDE_CMD` 里的路径必须是绝对路径，会话在别的目录启动。
- 手机端 APK 由 CI 编译，产物是 `cchub-android`；`desktop/gen/` 不入库，Android 的清单和原生代码都放在 `desktop/android-bridge/android/`，由 Gradle 合并。
- `ClientMsg::List` 不等进程启动 → `Start` 之后马上 `List` 可能看到 `running: false`，测试要重试。
