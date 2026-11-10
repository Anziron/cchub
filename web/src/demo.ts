// 开发时的假后端：用真实录制驱动界面，不需要 Rust 和服务器。
// `?scene=offline`、`?scene=conn` 模拟设备离线和断线。
import approval from "../../testdata/recordings/approval/stream.jsonl?raw";
import interrupt from "../../testdata/recordings/interrupt/stream.jsonl?raw";
import plan from "../../testdata/recordings/plan/stream.jsonl?raw";
import question from "../../testdata/recordings/question/stream.jsonl?raw";
import type { UiEvent } from "./generated/UiEvent";
import type { Hub } from "./hub";

const params = new URLSearchParams(location.search);
const scene = params.get("scene");
localStorage.setItem("cchub.url", "ws://demo");
if (params.get("theme")) localStorage.setItem("cchub.theme", params.get("theme")!);

function until(recording: string, needle: string): string[] {
  const lines = recording.split("\n").filter(Boolean);
  const index = lines.findIndex((line) => line.includes(needle));
  return index < 0 ? lines : lines.slice(0, index + 1);
}

const user = (text: string) =>
  JSON.stringify({ type: "user", uuid: crypto.randomUUID(), timestamp: new Date(Date.now() - 12000).toISOString(), message: { role: "user", content: text } });

const assistant = (id: string, content: unknown[]) =>
  JSON.stringify({ type: "assistant", message: { id, model: "claude-sonnet-5-5", content: content } });

const result = (id: string, content: string) =>
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });

const rich = [
  user("帮我修一下登录接口，并跑一遍相关测试。"),
  assistant("m1", [{ type: "tool_use", id: "todo", name: "TodoWrite", input: { todos: [
    { content: "定位登录接口", status: "completed" },
    { content: "补充失败用例", status: "completed" },
    { content: "运行完整测试并汇报", status: "in_progress", activeForm: "运行完整测试并汇报" },
  ] } }]),
  assistant("m1", [{ type: "thinking", thinking: "账号不存在和密码错误应该返回同一条提示，避免泄露账号是否存在。" }]),
  assistant("m1", [{ type: "text", text: "我先看了现有实现。问题在于账号不存在和密码错误走了**两条分支**，返回的提示不一致，这会泄露账号是否存在。修改后在 `sign_in` 里返回同一条错误：\n\n```python\ndef sign_in(email, password):\n    account = users.find(email)\n    if not account or not verify(password, account.hash):\n        return {\"ok\": False, \"error\": \"账号或密码错误\"}\n    return create_session(account.id)\n```" }]),
  assistant("m1", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/work/src/auth.py" } }]),
  result("t1", "读取 184 行"),
  assistant("m1", [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/work/src/auth.py", old_string: "if not account: return None", new_string: "if not account or not verify(password, account.hash):\n    return {\"ok\": False, \"error\": \"账号或密码错误\"}" } }]),
  result("t2", "ok"),
  assistant("m1", [{ type: "tool_use", id: "t3", name: "Task", input: { description: "检查测试覆盖率" } }]),
  result("t3", "认证分支覆盖率 86%"),
  assistant("m1", [{ type: "tool_use", id: "t4", name: "Bash", input: { command: "sleep 60; echo ready" } }]),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t4", is_error: true, content: "<tool_use_error>Blocked: sleep 60 followed by: echo ready</tool_use_error>" }] } }),
  assistant("m1", [{ type: "text", text: "测试结果如下，错误密码的用例现在已经通过：\n\n| 用例 | 结果 | 耗时 |\n| --- | --- | ---: |\n| 登录成功 | 通过 | 41 ms |\n| 错误密码 | 通过 | 38 ms |\n| 账号不存在 | 通过 | 35 ms |" }]),
  assistant("m2", [{ type: "thinking", thinking: "" }]),
  assistant("m2", [{ type: "tool_use", id: "s1", name: "Skill", input: { skill: "hub-ops" } }]),
  result("s1", "Launching skill: hub-ops"),
  JSON.stringify({ type: "user", isSynthetic: true, message: { content: [{ type: "text", text: "Base directory for this skill: /root/.claude/skills/hub-ops\n\n# 中枢运维\n\n这段是技能正文，不是用户说的话。" }] } }),
  assistant("m3", [{ type: "tool_use", id: "t6", name: "Read", input: { file_path: "/work/src/missing.py" } }]),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t6", is_error: true, content: "<tool_use_error>File does not exist.</tool_use_error>" }] } }),
  assistant("m3", [{ type: "tool_use", id: "t7", name: "Bash", input: { command: "sleep 60; pytest" } }]),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t7", is_error: true, content: "<tool_use_error>Blocked: sleep 60 followed by: pytest\n第二行详情\n第三行详情</tool_use_error>" }] } }),
  assistant("m1", [{ type: "tool_use", id: "t5", name: "Bash", input: { command: "pytest tests/auth_test.py -q" } }]),
];

const SESSIONS: { id: string; title: string; running: boolean; lines: string[] }[] = [
  { id: "approval", title: "修登录接口", running: true, lines: [user("把 hi 写进 marker，再写一句话。"), ...until(approval, '"can_use_tool"')] },
  { id: "plan", title: "拆分账单模块", running: true, lines: [user("先出方案，确认后再写 hello.txt。"), ...until(plan, '"can_use_tool"')] },
  { id: "question", title: "选择登录入口", running: true, lines: [user("问我选哪个颜色。"), ...until(question, '"can_use_tool"')] },
  { id: "rich", title: "整理认证测试", running: true, lines: rich },
  { id: "interrupt", title: "跑一个长任务", running: false, lines: [user("运行 long.py"), ...interrupt.split("\n").filter(Boolean)] },
  ...["补充单元测试", "smoke test", "smoke test", "smoke test", "smoke test", "smoke test"].map((title, i) => ({ id: `old${i}`, title, running: false, lines: [user(title)] })),
];

let emit: (event: UiEvent) => void = () => {};

export const demoHub: Hub = {
  connect: async () => (scene === "conn" ? "disconnected" : "connected"),
  onEvent: async (handler) => { emit = (event) => handler([event]); },
  send: async (msg) => {
    if (msg.type === "browse") {
      if (!msg.device) emit({ type: "browse", device: null, path: null, parent: null, entries: ["laptop", "office-pc"], error: null });
      else if (msg.device === "office-pc") emit({ type: "browse", device: msg.device, path: null, parent: null, entries: [], error: "读取目录失败：设备离线、没有权限或路径不存在" });
      else if (!msg.path) emit({ type: "browse", device: msg.device, path: null, parent: null, entries: ["C:\\", "D:\\"], error: null });
      else emit({ type: "browse", device: msg.device, path: msg.path, parent: msg.path.length > 3 ? "D:\\" : null, entries: ["cchub", "demo-api", "docs-site"].map((name) => `${msg.path!.replace(/\\$/, "")}\\${name}`), error: null });
    } else if (msg.type === "task_output") {
      const text = scene === "tasks"
        ? Array.from({ length: 400 }, (_, i) => `[${i}] ${"building module ".repeat(1 + (i % 12))}`).join("\n")
        : "tick 1\ntick 2\n构建完成\n";
      emit({ type: "task_output", path: msg.path, text, error: null });
    } else if (msg.type === "mount") {
      emit({ type: "mounted", device: msg.device, path: msg.path, cwd: `/mnt/${msg.device}/${msg.path[0].toLowerCase()}/${msg.path.slice(3).replaceAll("\\", "/")}`, error: null });
    } else if (msg.type === "input") {
      const request = JSON.parse(msg.line);
      if (request.request?.subtype === "initialize") {
        const models = [
          { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
          { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "For complex work and everyday tasks", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
          { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "Most efficient for simpler tasks", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
          { value: "fable", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1", description: "For your toughest challenges", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
          { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku 5.5", description: "Fastest for quick answers", supportedEffortLevels: ["low", "medium", "high"] },
        ];
        const commands = [
          { name: "compact", description: "压缩对话，释放上下文", argumentHint: "<可选说明>" },
          { name: "context", description: "查看上下文占用", argumentHint: "" },
          { name: "usage", description: "查看额度", argumentHint: "" },
          { name: "review", description: "审查当前改动", argumentHint: "" },
          ...Array.from({ length: 20 }, (_, i) => ({ name: `skill-${i}`, description: `示例技能 ${i}`, argumentHint: "" })),
        ];
        emit({ type: "event", session: msg.session, class: "durable", seq: 0, payload: JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response: { models, commands } } }) });
      }
    } else if (msg.type === "list") {
      const now = Math.floor(Date.now() / 1000);
      emit({
        type: "sessions",
        mem_available_mb: 412,
        sessions: SESSIONS.map((s, i) => ({ id: s.id, title: s.title, cwd: "/mnt/laptop/d/demo-api", running: s.running, updated: now - i * 60, active: now - i * 60, archived: false })),
      });
    } else if (msg.type === "attach") {
      const session = SESSIONS.find((s) => s.id === msg.session);
      session?.lines.forEach((payload, i) => emit({ type: "event", session: msg.session, class: "durable", seq: i, payload }));
      const event = (o: unknown) => emit({ type: "event", session: msg.session, class: "durable", seq: 0, payload: JSON.stringify(o) });
      const hours = Math.floor(Date.now() / 1000) + 7200;
      event({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.34, resetsAt: hours }, seven_day: { utilization: 0.86, resetsAt: hours + 400000 } } } });
      event({ type: "assistant", message: { id: "usage", usage: { input_tokens: 2, cache_read_input_tokens: 240000, cache_creation_input_tokens: 4000 }, content: [] } });
      if (msg.session === "rich") {
        event({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "b1", task_type: "local_bash", description: "运行完整测试 npm test" }, { task_id: "b2", task_type: "local_bash", description: "构建桌面端" }, { task_id: "b3", task_type: "local_bash", description: "Run read-only codex test task in background" }] });
        event({ type: "system", subtype: "task_notification", task_id: "b3", status: "stopped", output_file: "/tmp/claude-0/x/tasks/b3.output" });
        event({ type: "system", subtype: "task_notification", task_id: "b2", status: "completed", summary: "构建完成", output_file: "/tmp/claude-0/x/tasks/b2.output" });
      }
      // `?scene=tasks`：后台任务很多、描述很长、输出几百行，用来检查弹窗不会撑出可见区域。
      if (msg.session === "rich" && scene === "tasks") {
        const many = Array.from({ length: 40 }, (_, i) => ({ task_id: `m${i}`, task_type: i % 3 ? "local_bash" : "local_agent", description: `第 ${i} 个任务 ${"运行很长的构建命令 ".repeat(1 + (i % 6))}` }));
        event({ type: "system", subtype: "background_tasks_changed", tasks: many });
        many.slice(0, 15).forEach((task) => event({ type: "system", subtype: "task_notification", task_id: task.task_id, status: "completed", summary: "完成", output_file: `/tmp/claude-0/x/tasks/${task.task_id}.output` }));
      }
      if (scene === "offline") emit({ type: "device", session: msg.session, online: false });
    }
  },
};
