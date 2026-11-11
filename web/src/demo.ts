// 开发时的假后端：用真实录制驱动界面，不需要 Rust 和服务器。
// `?scene=offline`、`?scene=conn` 模拟设备离线和断线。
import approval from "../../testdata/recordings/approval/stream.jsonl?raw";
import interrupt from "../../testdata/recordings/interrupt/stream.jsonl?raw";
import plan from "../../testdata/recordings/plan/stream.jsonl?raw";
import question from "../../testdata/recordings/question/stream.jsonl?raw";
import type { UiEvent } from "./generated/UiEvent";
import type { Hub } from "./hub";
import { NEW_DRAFT, type Store } from "./store";

const params = new URLSearchParams(location.search);
const scene = params.get("scene");
localStorage.setItem("cchub.url", "ws://demo");
if (params.get("theme")) localStorage.setItem("cchub.theme", params.get("theme")!);
// `?pane=changes` 等：打开指定窗格，`?pane=` 关闭。
if (params.has("pane")) localStorage.setItem("cchub.pane", params.get("pane")!);
// `?click=<选择器>`：加载后点一下，用来截图检查弹出菜单。
if (params.get("click")) setTimeout(() => document.querySelector<HTMLElement>(params.get("click")!)?.click(), 1200);
// `?range=today|7d|30d|all`：使用情况窗格的范围（会记住，截图时每张都写明）。
if (params.get("range")) localStorage.setItem("cchub.usageRange", params.get("range")!);
// `?metric=tokens|requests`：使用情况柱状图显示模型 token 还是请求次数（会记住）。
if (params.get("metric")) localStorage.setItem("cchub.usageMetric", params.get("metric")!);
// `?models=tokens|cost`：常用模型显示 token 还是费用（会记住）。
if (params.get("models")) localStorage.setItem("cchub.usageModelView", params.get("models")!);
// `?hover=<选择器>`：元素出现后模拟鼠标移上去，用来截图检查悬停浮层。
// 统计数据异步到达；无头浏览器的虚拟时钟会跑在网络加载前面，不能按定时等，要看元素出现。
if (params.get("hover")) {
  const selector = params.get("hover")!;
  const observer = new MutationObserver(() => {
    const el = document.querySelector(selector);
    if (!el) return;
    observer.disconnect();
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function until(recording: string, needle: string): string[] {
  const lines = recording.split("\n").filter(Boolean);
  const index = lines.findIndex((line) => line.includes(needle));
  return index < 0 ? lines : lines.slice(0, index + 1);
}

/** 使用情况演示数据：按权重把当天的四项分给各模型。 */
function demoModels(messages: number, weights: Record<string, number>): Record<string, [number, number, number, number]> {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  return Object.fromEntries(
    Object.entries(weights).map(([model, w]) => {
      const share = w / total;
      return [model, [messages * 3, messages * 900, messages * 4000, messages * 60000].map((v) => Math.round(v * share)) as [number, number, number, number]];
    }),
  );
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
  { id: "rich", title: "整理认证测试", running: true, lines: scene === "effort" ? [...rich, JSON.stringify({ type: "assistant", effort: "high", message: { id: "m9", model: "claude-sonnet-5-5", content: [] } })] : rich },
  { id: "interrupt", title: "跑一个长任务", running: false, lines: [user("运行 long.py"), ...interrupt.split("\n").filter(Boolean)] },
  // 多轮对话：检查左侧的轮次导航。
  { id: "turns", title: "多轮讨论", running: false, lines: Array.from({ length: 14 }, (_, i) => [
    user(`第 ${i + 1} 轮：${["看一下这个函数", "再加个测试", "改成异步", "补上错误处理"][i % 4]}`),
    assistant(`n${i}`, [{ type: "text", text: Array.from({ length: 3 + (i % 3) }, (_, k) => `第 ${i + 1} 轮回复第 ${k + 1} 段。这里是一段足够长的说明文字，用来把消息流撑高，方便检查滚动时当前轮的高亮是否跟着变化。`).join("\n\n") }]),
  ]).flat() },
  ...["补充单元测试", "smoke test", "smoke test", "smoke test", "smoke test", "smoke test"].map((title, i) => ({ id: `old${i}`, title, running: false, lines: [user(title)] })),
];

let emit: (event: UiEvent) => void = () => {};

/**
 * 需要操作界面状态的场景。`?scene=queue`：运行中排了两条消息、拖入两个文件（一个在项目外）、输入框里一段长文字。
 * `?draft=long`：只放长文字，检查滚动条和发送按钮的位置。
 */
export function setupDemo(store: Store): void {
  const long = Array.from({ length: 14 }, (_, i) => `第 ${i + 1} 行：补充说明，输入框变高后滚动条和发送按钮的位置。`).join("\n");
  // 草稿要在输入框挂载前写好：无头浏览器的虚拟时钟到点就截图，之后的重画赶不上。
  const key = params.get("s") ?? NEW_DRAFT;
  store.setDraft(key, scene === "queue" || params.get("draft") === "long" ? long : "");
  // 项目内一个；项目外同设备的一个（自动挂载所在目录后可读）；盘符根目录下的一个（不挂整个盘，标黄）。
  if (scene === "queue") store.dropFiles(key, ["D:\\work\\src\\auth.py", "C:\\Users\\me\\Desktop\\需求说明.docx", "D:\\notes.txt"], "/mnt/laptop/d/work");
  setTimeout(() => {
    const session = store.sessions.get(key);
    if (scene === "queue" && session) {
      store.enqueue(session, "顺便看下 CI 日志里为什么慢", "insert");
      store.enqueue(session, "这一轮结束后把改动提交了，提交信息写清楚改了哪些接口", "wait");
      store.enqueue(session, "然后跑一遍完整测试", "wait");
    }
  }, 600);
}

export const demoHub: Hub = {
  connect: async () => (scene === "conn" ? "disconnected" : "connected"),
  onEvent: async (handler) => { emit = (event) => handler([event]); },
  send: async (msg) => {
    if (msg.type === "devices") {
      setTimeout(() => emit({ type: "devices", error: null, devices: [
        { name: "laptop", os: "windows", online: true },
        { name: "office-pc", os: "windows", online: false },
        { name: "mac-mini", os: "macos", online: true },
      ] }), 100);
      return;
    }
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
    } else if (msg.type === "usage") {
      // 假统计：最近 120 天，工作日多、周末少，三个模型加一个零星的。
      const today = new Date();
      const days = Array.from({ length: 120 }, (_, i) => {
        const date = new Date(today.getTime() - (119 - i) * 86400000);
        const weekend = date.getDay() === 0 || date.getDay() === 6;
        const seed = (i * 37) % 11;
        // 今天总有数据，“今天”范围能看到按小时的柱子（到当前小时为止，起伏不同）。
        const isToday = i === 119;
        const messages = scene === "usage-empty" ? 0 : isToday ? 96 : (weekend && seed < 7) || seed === 3 ? 0 : 40 + seed * 30 + (i % 5) * 25;
        const hours = isToday
          ? Array.from({ length: 24 }, (_, h) => (h <= today.getHours() && h >= 8 ? 2 + ((h * 7) % 9) : 0))
          : Array.from({ length: 24 }, (_, h) => (h >= 9 && h <= 22 && messages ? Math.round(messages / 14) : 0));
        return {
          date: new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10),
          messages, sessions: messages ? 1 + (seed % 4) : 0,
          input: messages * 3, output: messages * 900, cacheWrite: messages * 4000, cacheRead: messages * 60000,
          models: messages ? demoModels(messages, { "claude-opus-5-5": 3200, "claude-sonnet-5-5": 1200, "claude-haiku-5-5": (seed % 3) * 300, ...(seed > 8 ? { "claude-fable-5-2": 200 } : {}) }) : {},
          projects: messages ? { "/mnt/pc/d/demo-api": Math.round(messages * 0.6), "/mnt/pc/d/cchub": Math.round(messages * 0.3), "/root/notes": Math.round(messages * 0.1) } : {},
          hours,
          hourTokens: isToday ? {
            "claude-opus-5-5": hours.map((n) => n * 52000),
            "claude-sonnet-5-5": hours.map((n, h) => (h % 3 ? n * 18000 : 0)),
            "claude-haiku-5-5": hours.map((n, h) => (h % 4 === 1 ? n * 6000 : 0)),
          } : undefined,
        };
      }).filter((d) => d.messages);
      setTimeout(() => emit({ type: "usage", stats: JSON.stringify({ version: 2, generatedAt: Math.floor(Date.now() / 1000) - 120, tzOffset: 480, days }), error: scene === "usage-error" ? "统计命令没有安装，或运行超时" : null }), 300);
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
        // 这一轮的实时 token：一条已结束的消息 + 正在生成的片段。
        event({ type: "stream_event", event: { type: "message_delta", delta: {}, usage: { output_tokens: 1840 } } });
        event({ type: "stream_event", event: { type: "message_start", message: { id: "live" } } });
        event({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "x".repeat(1400) } } });
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
