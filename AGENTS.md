# cchub 项目规则

## 约束

- `hubd` 只做转发和进程管理，不解析消息内容，不渲染；Markdown、diff、高亮、搜索都放在桌面端。
- 资源目标：`hubd` 常驻约 5～10MB；桌面端在托盘 < 20MB，窗口空闲 < 150MB。
- 桌面端不引入大型 UI 框架和图表库，样式用 CSS；不使用 Anthropic 的 logo 和品牌素材。
- 不用数据库，会话记录直接读 `claude` 的 `.jsonl`。

## 已知坑

- 本目录位于 `buspi` 的工作区内，但是独立仓库。`buspi` 靠它自己的 `.git/info/exclude` 忽略 `cchub/`，换设备克隆时要重新排除，或者克隆到别的位置。
