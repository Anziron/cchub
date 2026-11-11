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

- `hubd` 只做转发和进程管理，只解析事件信封（类型、序号、状态），不解析正文，不渲染；Markdown、diff、高亮、搜索都放在桌面端。唯一例外：超过 64KB 的行发送前由 `protocol` 的 `elide_base64` 把 ≥4KB 的 base64 串换成空串（截图占长会话 `out` 的八成，界面不显示图片），`seq`/`next` 仍是原文偏移。
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
- 卡在断开挂载上的进程或线程连 `SIGKILL` 都杀不掉（D 状态），要等连接恢复；不要等待、回收这类线程，同一路径同时只跑一个探测。探测在进程内的线程里做（`device.rs`，每个项目目录所有连接共享一个，30 秒一次，无人订阅时停止），不再 fork 自身。
- 切换模型要用 `set_model` 控制消息；`/model` 回复成功但不生效。内置命令的输出会写进会话记录并占上下文，不要自动定时调用。
- 子代理的事件带 `parent_tool_use_id`，一轮结束后后台子代理还会持续产生事件 → 这类事件不能改主线程的 `phase`，否则一直显示“思考中”。
- 侧边栏按 `active`（用户最后发言，hubd 收到 `user` 输入时 touch `<dir>/active`）排序，不能按日志更新时间排，否则几个会话同时输出时会来回跳。
- 中断后 `result` 是 `error_during_execution`、`is_error: true`，界面不能显示成任务失败。
- 录制 `plan` 场景会在 `~/.claude/plans/` 留下方案文件，录完要删。
- 前端的 `demo.ts` 只在开发时用录制驱动界面：`npm run dev:web` 后打开 `/?s=rich&theme=dark`，`?s=turns` 是多轮对话（看轮次导航），`?scene=queue` 是排队消息和拖入的文件、`?draft=long` 是长输入（`setupDemo` 在输入框挂载前写草稿，挂载后再改赶不上无头截图），`?pane=changes` 打开窗格，`?click=<选择器>` 加载后点击（检查弹出菜单），`?hover=<选择器>` 元素出现后模拟悬停（检查图表浮层），`?range=today|7d|30d|all` 指定使用情况范围（会记住，每张截图都要写明）。经 `pcrun` 启动的开发服务器随 SSH 会话退出，要和截图放在同一条命令里 → 用 `scripts/ui-shots.ps1`（无头 Edge，图片在 `.cc/shots/`）。
- 弹窗高于容器时会被 `.main` 的 `overflow: hidden` 裁掉标题和关闭按钮，看起来像“弹不出来” → 遮罩用 flex 居中（grid 自动轨道会被内容撑大），弹窗用 `min(固定值, 100%)` 限宽高；改弹窗或窗格后用 `/?scene=tasks&pane=tasks`（40 个后台任务、长输出）在几种窗口尺寸下检查。
- 设备没有 Rust，桌面端由 CI 编译，可执行文件在 Actions 的 `cchub-windows` 产物里。
- 服务器上的 `claude` 受用户配置影响可能不发审批请求，要测审批时加 `--setting-sources project,local`。
- CLI 会拦截 `sleep 60; ...` 这类命令，实验里要用脚本文件代替。
- `hubd` 不认任何参数，`hubd --version` 会真的启动并用默认状态目录 → 手动运行时必须设临时 `HUBD_STATE_DIR` 和回环端口。
- 部署 `hubd` 用 CI 产物 `hubd-linux-musl`（服务器的 Rust 在 `~/.cargo/bin`、不在 PATH，可以限内存跑 `cargo test`，但不用来出部署包；设备没有 Rust）。
- “使用情况”窗格的数据来自 `tools/usage/cchub-usage.py`，服务器上装在 `/usr/local/bin/cchub-usage`（`HUBD_USAGE_CMD` 可替换），缓存在 `~/.cache/cchub-usage/` → 改了脚本要重新 `install -m 755` 过去；输出格式变了要同时改 `web/src/usage.ts` 并升 `version`。CLI 会清理旧会话记录，删掉的文件的统计留在缓存的 `gone` 里，不要清缓存。
- 列表和状态检查很频繁，不要在热路径上起子进程（每次 `systemctl` 约 6ms CPU，空闲时曾累计每 30 秒 400ms）→ 会话是否运行读 cgroup 的 `cgroup.procs`。
- 弱网测试不要动服务器真实网卡（代理和会话都走它）→ 用 `ip netns` 建独立命名空间，在其回环上加 `netem`。
- 桌面端关窗后进程留在托盘，再双击 exe 曾启动第二个实例，两份连接和通知同时存在 → 现在靠占用 `127.0.0.1:47878` 保证单实例；升级 exe 前要先从托盘菜单退出旧进程，否则只会唤起旧版本。
- 读秒、动画、定时刷新按 `pageVisible()`（`visibilityState`）暂停，不要按 `document.hasFocus()`：用户常把窗口放在旁边看着，焦点在别处时界面会像卡住。
- 测桌面端内存要沿父进程树汇总私有工作集：工作集含共享内存，且设备上还有别的程序的 WebView。
- 模型列表来自 `initialize` 控制消息的 `models` → 可重复发送，不调用模型，回复进 `out` 但不进 `.jsonl`；重放 `out` 会读到旧回复，所以只认当次的 `request_id`。
- 乐观显示靠用户消息的 `uuid` → `--replay-user-messages` 回传时保持同一个 `uuid`，用它确认送达，不要按文字匹配。
- 工作区浏览和挂载调用外部命令 `cc-workspace`（可用 `HUBD_WORKSPACE_CMD` 替换）→ 部署新 `hubd` 前先 `cc-config apply`；`/mnt/<设备>/` 只有已挂载的项目，不能靠浏览服务器目录找新项目。
- 老项目新会话进到空目录：sshfs 曾留在调用者的 cgroup（会话的 `cchub-session-*.service` 或 `hubd.service`），空闲回收或重启 `hubd` 时被 systemd 一起杀掉；没挂载的 `/mnt/...` 只是空文件夹，探测查“不存在”会当成在线 → 已修复：`cc-mount` 把 sshfs 放进 `ccmount.slice` 的独立 scope，`hubd` 启动 `/mnt` 下的会话前先 `cc-workspace ensure <目录>` 补挂。
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
- `ui-redesign` 分支上 Android 冒烟测试偶发失败（“等不到通知：已连接”“重开后：进程不在了”等，同一份代码重跑能过，原因未查）→ 先看失败的代码是否碰了 Android 或连接，没碰就 `gh run rerun <id> --failed` 再判断。
- `android-smoke.sh` 全绿不等于界面正常，曾经白屏也通过 → 要检查界面内容并看 `android-shots` 截图。`HUBD_CLAUDE_CMD` 里的路径必须是绝对路径，会话在别的目录启动。
- 手机端 APK 由 CI 编译，产物是 `cchub-android`；`desktop/gen/` 不入库，Android 的清单和原生代码都放在 `desktop/android-bridge/android/`，由 Gradle 合并。
- `ClientMsg::List` 不等进程启动 → `Start` 之后马上 `List` 可能看到 `running: false`，测试要重试。
- 子代理任务的 `output_file` 是指向子代理完整记录 `.jsonl` 的符号链接，夹着 `api-request-*`、`attachment` 等内部记录，单行可达几十 KB → `read_task_output` 对 `.jsonl` 只回整行的 `user` / `assistant`，前端用 `parseTranscript` 按对话显示；普通任务仍是纯文本末尾。
- 空闲回收（`idle.rs`）判定只看 `out` 末尾的信封：`result` 要在最后的 `assistant` / `control_request` 之后，最近的 `background_tasks_changed` 快照要为空；用户输入和 `set_model` 回显是 `user`，不算活动。被回收的会话前端照常走 `--resume` 恢复。
- 推理强度用 `apply_flag_settings` 的 `{effortLevel}`（`null` 恢复默认，`max` 也可用），不要发 `/effort`；它只在当前进程有效，`--resume` 后要重发；实时事件不带当前强度，只有 `.jsonl` 的 `assistant` 带 `effort`。
- 新会话页输入框在窗口中间，向上弹的菜单在矮窗口里会被 `.main` 裁掉、滚不到 → 弹出菜单用 `Dialogs.tsx` 的 `useMenuFit` 按上下剩余空间定方向和最大高度；改菜单后用 900×460 窗口检查新会话页。
- `web/src` 里的文件名不能只差大小写：设备是 Windows，`Sidebar.tsx` 和 `sidebar.ts` 会被当成同一个文件（tsc 报 TS1149）→ 侧栏组件叫 `SessionList.tsx`。
- 无头 Edge 截图的虚拟时钟会跑在网络加载前面，数据到达后马上抓图：`setTimeout` 等元素、React 异步调度的更新都可能赶不上 → demo 里用 `MutationObserver` 等元素出现；图表浮层用 `flushSync` 同步更新（也让悬停立刻跟手）。截图 PNG 过大时图片接口会拒收，用 `System.Drawing` 裁成 JPEG 再看。
- 图表悬停浮层（`UsagePane.tsx` 的 `ChartTip`）：容器上事件委托找 `data-i`，只有浮层重画；不要给每个格子加 `title` 或各自的状态。
- 窗格里的长内容（后台任务输出、子任务记录）不能跟着每秒的读秒重画：读秒放进独立的小组件，输出区 `memo` 按文本比较，子任务记录先只画最后 30 条。
- 外部链接走 `platform.ts` 的 `openUrl`（桌面端是 `desktop.rs` 的 `open_url` 命令，只放行 http/https；Windows 用 `rundll32 url.dll,FileProtocolHandler`，不要经 `cmd start`，网址里的 `&` 会被拆开）。
- 一轮进行中写进 FIFO 的用户消息，CLI 会在下一个工具结果之后插进同一轮（回传同一 `uuid`、带 `isReplay`，只出一个 `result`）→ “插入”直接发，看到回传才算送达；“等结束”留在桌面端（`queue.ts`），中断或进程结束时放回输入框，不自动发。
- 设备列表来自 `cc-workspace status`（登记表 + `tailscale status --json` 的 `Online`），hubd 缓存 15 秒；会话里的离线提示仍靠挂载探测（`Device` 消息），两者不一致时侧栏显示黄色“目录读不到”。
- 被测模块（`web/test/` 直接用 `node --test` 跑）之间只能有类型导入，导入函数会因缺 `.ts` 扩展名失败 → 小工具函数在模块内重写或放进 `model.ts`。Windows 上 `node --test test/` 不认目录，要写 `test/*.test.ts`。
- 弹出菜单统一用 `Common.tsx` 的 `Dropdown`（外层 `.dd` 是 `position: relative`）→ 要绝对定位的下拉要写 `.dd.xxx`，只写 `.xxx` 会被 `.dd` 覆盖，行高被撑开。
