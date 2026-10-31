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

- 本目录位于 `buspi` 的工作区内，但是独立仓库。`buspi` 靠它自己的 `.git/info/exclude` 忽略 `cchub/`，换设备克隆时要重新排除，或者克隆到别的位置。
- FIFO 的最后一个 fd 关闭时缓冲数据会丢失：要先打开 FIFO 并持有，再启动进程。
- 只读命令（如 `cat`）可能不发审批请求，模型也可能把前台命令改成后台，测试脚本不能假设一定有审批，或一轮结束时任务已完成。
- sshfs 缓存文件属性：断网后 `stat` 已缓存的文件仍然成功，探测必须查新的文件名。
- 卡在断开挂载上的进程连 `SIGKILL` 都杀不掉（D 状态），要等连接恢复；不要等待这类子进程，同一路径同时只跑一个探测。
- CLI 会拦截 `sleep 60; ...` 这类命令，实验里要用脚本文件代替。
