//! 完整链路：录制数据 → fake-claude → hubd → 同步核心，不耗 Claude 额度。
#![cfg(unix)]

use std::collections::HashSet;
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use cchub_protocol::{
    classify, AckError, ClientMsg, EventClass, Frame, Inbound, InboundAction, ServerMsg,
    PROTOCOL_VERSION,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

const TIMEOUT: Duration = Duration::from_secs(90);
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

fn recording_in(scenario: &str, name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../testdata/recordings")
        .join(scenario)
        .join(name)
}

fn recording(name: &str) -> PathBuf {
    recording_in("approval", name)
}

struct Temp(PathBuf);

impl Temp {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("hubd-e2e-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        // 测试失败时也不留下 fake-claude。
        if let Ok(entries) = std::fs::read_dir(&self.0) {
            for entry in entries.flatten() {
                if let Ok(pid) = std::fs::read_to_string(entry.path().join("pid")) {
                    let _ = std::process::Command::new("kill").arg(pid.trim()).status();
                }
            }
        }
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn spawn_hubd(state: &Path) -> (Child, String) {
    spawn_replay(state, "approval").await
}

async fn spawn_replay(state: &Path, scenario: &str) -> (Child, String) {
    let cmd = format!(
        "{} {} 1",
        env!("CARGO_BIN_EXE_fake-claude"),
        recording_in(scenario, "stream.jsonl").display()
    );
    spawn_hubd_with(state, "direct", &cmd).await
}

async fn spawn_hubd_with(state: &Path, host: &str, cmd: &str) -> (Child, String) {
    spawn_hubd_env(state, host, cmd, &[]).await
}

async fn spawn_hubd_env(
    state: &Path,
    host: &str,
    cmd: &str,
    env: &[(&str, &str)],
) -> (Child, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_hubd"))
        .envs(env.iter().copied())
        .env("HUBD_LISTEN", "127.0.0.1:0")
        .env("HUBD_HOST", host)
        .env("HUBD_STATE_DIR", state)
        .env("HUBD_CLAUDE_CMD", cmd)
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut lines = BufReader::new(stdout).lines();
    let line = lines.next_line().await.unwrap().unwrap();
    let addr = line.rsplit(' ').next().unwrap().to_string();
    (child, addr)
}

async fn connect(addr: &str) -> Socket {
    connect_url(&format!("ws://{addr}/ws?v=1")).await
}

/// 连上后先收 `Hello`，之后才是其他消息。
async fn connect_url(url: &str) -> Socket {
    let mut socket = connect_async(url).await.unwrap().0;
    let first = tokio::time::timeout(TIMEOUT, socket.next())
        .await
        .expect("等待 Hello 超时")
        .expect("连接意外关闭")
        .unwrap();
    let Message::Text(text) = first else {
        panic!("第一帧不是文本：{first:?}");
    };
    let frame: Frame = serde_json::from_str(text.as_str()).unwrap();
    assert!(
        matches!(frame.msg, ServerMsg::Hello { protocol_version, .. } if protocol_version == PROTOCOL_VERSION),
        "第一帧不是 Hello：{text}"
    );
    socket
}

/// 每条输入一个新 id。
fn next_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!("in-{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

async fn send(socket: &mut Socket, msg: ClientMsg) {
    let text = serde_json::to_string(&msg).unwrap();
    socket.send(Message::Text(text.into())).await.unwrap();
}

/// 客户端逻辑：把收到的消息交给同步核心，直到 `stop` 对新事件返回真。
async fn read_until(
    socket: &mut Socket,
    inbound: &mut Inbound,
    applied: &mut Vec<String>,
    stop: impl Fn(&str) -> bool,
) {
    let wait = async {
        while let Some(message) = socket.next().await {
            let Message::Text(text) = message.unwrap() else {
                continue;
            };
            let frame: Frame = serde_json::from_str(text.as_str()).unwrap();
            if let ServerMsg::Error { message } = &frame.msg {
                panic!("hubd 报错：{message}");
            }
            match inbound.on_message(frame.msg) {
                Some(InboundAction::Apply { payload, .. }) => {
                    applied.push(payload);
                    if stop(applied.last().unwrap()) {
                        return;
                    }
                }
                Some(InboundAction::Resync { after }) => panic!("链路正常时出现缺口：{after}"),
                _ => {}
            }
        }
        panic!("连接意外关闭");
    };
    tokio::time::timeout(TIMEOUT, wait)
        .await
        .expect("等待事件超时");
}

fn event_type(line: &str) -> String {
    let value: Value = serde_json::from_str(line).unwrap();
    value["type"].as_str().unwrap_or_default().to_string()
}

fn ids(lines: impl Iterator<Item = String>) -> (HashSet<String>, HashSet<String>, HashSet<String>) {
    let (mut uuids, mut messages, mut tools) = (HashSet::new(), HashSet::new(), HashSet::new());
    for line in lines {
        let value: Value = serde_json::from_str(&line).unwrap();
        let kind = value["type"].as_str().unwrap_or_default();
        if kind != "user" && kind != "assistant" {
            continue;
        }
        if let Some(uuid) = value["uuid"].as_str() {
            uuids.insert(uuid.to_string());
        }
        if let Some(id) = value.pointer("/message/id").and_then(Value::as_str) {
            messages.insert(id.to_string());
        }
        for block in value
            .pointer("/message/content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(id) = block["tool_use_id"].as_str() {
                tools.insert(id.to_string());
            }
        }
    }
    (uuids, messages, tools)
}

#[tokio::test]
async fn replay_survives_hubd_kill_and_matches_transcript() {
    let temp = Temp::new("kill");
    let (mut hubd, addr) = spawn_hubd(&temp.0).await;
    let mut socket = connect(&addr).await;
    let session = "s1".to_string();

    let mut inbound = Inbound::new(0);
    let mut applied = Vec::new();
    send(
        &mut socket,
        ClientMsg::Start {
            session: session.clone(),
            title: None,
            prompt: None,
            model: None,
            resume: None,
            cwd: None,
        },
    )
    .await;
    send(
        &mut socket,
        ClientMsg::Attach {
            session: session.clone(),
            after: 0,
        },
    )
    .await;
    let user = r#"{"type":"user","message":{"role":"user","content":"go"}}"#;
    send(
        &mut socket,
        ClientMsg::Input {
            session: session.clone(),
            id: next_id(),
            line: user.into(),
        },
    )
    .await;

    read_until(&mut socket, &mut inbound, &mut applied, |line| {
        classify(line) == EventClass::Approval
    })
    .await;

    // hubd 被杀时审批还没回复：进程必须活着，等新的 hubd 接回。
    hubd.kill().await.unwrap();
    hubd.wait().await.unwrap();
    let pid = std::fs::read_to_string(temp.0.join("s1/pid")).unwrap();
    assert!(
        Path::new(&format!("/proc/{}", pid.trim())).exists(),
        "fake-claude 随 hubd 退出了"
    );

    let (_hubd, addr) = spawn_hubd(&temp.0).await;
    let mut socket = connect(&addr).await;
    send(
        &mut socket,
        ClientMsg::Attach {
            session: session.clone(),
            after: inbound.expected(),
        },
    )
    .await;

    let request: Value = serde_json::from_str(applied.last().unwrap()).unwrap();
    let reply = serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request["request_id"],
            "response": {"behavior": "allow", "updatedInput": request["request"]["input"]},
        },
    });
    send(
        &mut socket,
        ClientMsg::Input {
            session: session.clone(),
            id: next_id(),
            line: reply.to_string(),
        },
    )
    .await;
    read_until(&mut socket, &mut inbound, &mut applied, |line| {
        event_type(line) == "result"
    })
    .await;

    // 除了可以跳过的逐字片段，收到的内容要和录制逐条一致。
    let stream = std::fs::read_to_string(recording("stream.jsonl")).unwrap();
    let durable = |lines: Vec<String>| -> Vec<String> {
        lines
            .into_iter()
            .filter(|l| classify(l) != EventClass::Partial)
            .collect()
    };
    assert_eq!(
        durable(applied.clone()),
        durable(stream.lines().map(str::to_string).collect())
    );

    // 再和 claude 自己写的会话记录比对。
    let transcript = std::fs::read_to_string(recording("transcript.jsonl")).unwrap();
    let (got_uuids, got_messages, got_tools) = ids(applied.into_iter());
    let (want_uuids, want_messages, want_tools) = ids(transcript.lines().map(str::to_string));
    assert!(!got_uuids.is_empty());
    assert!(
        got_uuids.is_subset(&want_uuids),
        "{got_uuids:?} / {want_uuids:?}"
    );
    assert_eq!(got_messages, want_messages);
    assert_eq!(got_tools, want_tools);

    send(&mut socket, ClientMsg::Stop { session }).await;
}

/// 真实 claude + systemd，消耗少量额度，手动运行：
/// `cargo test -p hubd --test e2e -- --ignored`
#[tokio::test]
#[ignore]
async fn real_claude_under_systemd_survives_hubd_kill() {
    let temp = Temp::new("real");
    let cmd = "claude -p --input-format stream-json --output-format stream-json --verbose \
        --permission-prompt-tool stdio --permission-mode default --model haiku \
        --no-session-persistence";
    let session = format!("e2e-{}", std::process::id());
    let (mut hubd, addr) = spawn_hubd_with(&temp.0, "systemd", cmd).await;
    let mut socket = connect(&addr).await;
    let mut inbound = Inbound::new(0);
    let mut applied = Vec::new();

    send(
        &mut socket,
        ClientMsg::Start {
            session: session.clone(),
            title: None,
            prompt: None,
            model: None,
            resume: None,
            cwd: None,
        },
    )
    .await;
    send(
        &mut socket,
        ClientMsg::Attach {
            session: session.clone(),
            after: 0,
        },
    )
    .await;
    let user = serde_json::json!({"type": "user", "message": {"role": "user",
        "content": "Use the Bash tool once in the foreground to run: echo hi > marker . Then reply OK."}});
    send(
        &mut socket,
        ClientMsg::Input {
            session: session.clone(),
            id: next_id(),
            line: user.to_string(),
        },
    )
    .await;
    read_until(&mut socket, &mut inbound, &mut applied, |line| {
        classify(line) == EventClass::Approval
    })
    .await;

    hubd.kill().await.unwrap();
    hubd.wait().await.unwrap();
    let (_hubd, addr) = spawn_hubd_with(&temp.0, "systemd", cmd).await;
    let mut socket = connect(&addr).await;
    send(
        &mut socket,
        ClientMsg::Attach {
            session: session.clone(),
            after: inbound.expected(),
        },
    )
    .await;

    let request: Value = serde_json::from_str(applied.last().unwrap()).unwrap();
    let reply = serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request["request_id"],
            "response": {"behavior": "allow", "updatedInput": request["request"]["input"]},
        },
    });
    send(
        &mut socket,
        ClientMsg::Input {
            session: session.clone(),
            id: next_id(),
            line: reply.to_string(),
        },
    )
    .await;
    read_until(&mut socket, &mut inbound, &mut applied, |line| {
        event_type(line) == "result"
    })
    .await;

    let stopped = std::process::Command::new("systemctl")
        .args(["stop", &format!("cchub-session-{session}")])
        .status();
    assert!(
        temp.0.join(&session).join("marker").exists(),
        "工具没有在会话目录里执行"
    );
    assert!(stopped.unwrap().success());
}

fn context_switches(pid: u32) -> u64 {
    let mut total = 0;
    for task in std::fs::read_dir(format!("/proc/{pid}/task"))
        .unwrap()
        .flatten()
    {
        let status = std::fs::read_to_string(task.path().join("status")).unwrap_or_default();
        total += status
            .lines()
            .filter(|line| line.contains("ctxt_switches"))
            .filter_map(|line| line.split_whitespace().nth(1)?.parse::<u64>().ok())
            .sum::<u64>();
    }
    total
}

#[tokio::test]
async fn idle_subscription_does_not_poll() {
    let temp = Temp::new("idle");
    let (hubd, addr) = spawn_hubd(&temp.0).await;
    let mut socket = connect(&addr).await;
    send(
        &mut socket,
        ClientMsg::Start {
            session: "s1".into(),
            title: None,
            prompt: None,
            model: None,
            resume: None,
            cwd: None,
        },
    )
    .await;
    send(
        &mut socket,
        ClientMsg::Attach {
            session: "s1".into(),
            after: 0,
        },
    )
    .await;
    tokio::time::sleep(Duration::from_millis(500)).await;

    let pid = hubd.id().unwrap();
    let before = context_switches(pid);
    tokio::time::sleep(Duration::from_secs(3)).await;
    let woken = context_switches(pid) - before;
    // 100ms 轮询在这段时间至少会醒 30 次。
    assert!(woken < 20, "空闲时被唤醒 {woken} 次");
    send(
        &mut socket,
        ClientMsg::Stop {
            session: "s1".into(),
        },
    )
    .await;
}

#[tokio::test]
async fn reports_device_online_for_project_dir() {
    let temp = Temp::new("device");
    let project = temp.0.join("project");
    std::fs::create_dir_all(&project).unwrap();
    let (_hubd, addr) = spawn_hubd(&temp.0).await;
    let mut socket = connect(&addr).await;
    send(
        &mut socket,
        ClientMsg::Start {
            session: "s1".into(),
            title: None,
            prompt: None,
            model: None,
            resume: None,
            cwd: Some(project.display().to_string()),
        },
    )
    .await;
    send(
        &mut socket,
        ClientMsg::Attach {
            session: "s1".into(),
            after: 0,
        },
    )
    .await;
    let wait = async {
        loop {
            if let Message::Text(text) = socket.next().await.unwrap().unwrap() {
                let frame: Frame = serde_json::from_str(text.as_str()).unwrap();
                if let ServerMsg::Device { online } = frame.msg {
                    return online;
                }
            }
        }
    };
    assert!(tokio::time::timeout(TIMEOUT, wait).await.unwrap());
    send(
        &mut socket,
        ClientMsg::Stop {
            session: "s1".into(),
        },
    )
    .await;
}

#[tokio::test]
async fn failed_start_keeps_cwd_and_rejects_input() {
    let temp = Temp::new("failed-start");
    // 把目录位置占成普通文件，探测会失败，效果和挂载断开相同。
    let project = temp.0.join("project");
    std::fs::write(&project, "").unwrap();
    let (mut hubd, addr) = spawn_hubd(&temp.0).await;
    let mut socket = connect(&addr).await;
    let start = |cwd: Option<String>| ClientMsg::Start {
        session: "s1".into(),
        title: None,
        prompt: None,
        model: None,
        resume: None,
        cwd,
    };
    let path = project.display().to_string();
    send(&mut socket, start(Some(path.clone()))).await;
    send(
        &mut socket,
        ClientMsg::Input {
            session: "s1".into(),
            id: next_id(),
            line: "不该留下".into(),
        },
    )
    .await;
    // 重试不带目录，也不能退回会话目录启动。
    send(&mut socket, start(None)).await;
    let errors = async {
        let (mut count, mut refused) = (0, false);
        while count < 2 || !refused {
            let message = socket.next().await.expect("连接断开").unwrap();
            let Message::Text(text) = message else {
                continue;
            };
            let frame: Frame = serde_json::from_str(text.as_str()).unwrap();
            match frame.msg {
                ServerMsg::Error { message } => {
                    assert!(message.contains("设备离线"), "{message}");
                    count += 1;
                }
                // 进程没起来：输入被拒，没有写进 FIFO 留到下次启动。
                ServerMsg::Ack { error, .. } => {
                    assert_eq!(error, Some(AckError::NotRunning));
                    refused = true;
                }
                _ => {}
            }
        }
    };
    tokio::time::timeout(TIMEOUT, errors).await.unwrap();

    let mut fifo = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(temp.0.join("s1").join("in"))
        .unwrap();
    let error = fifo.read(&mut [0; 64]).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
    drop(fifo);

    // 恢复后不带目录也回到原来的目录。
    std::fs::remove_file(&project).unwrap();
    std::fs::create_dir(&project).unwrap();
    send(&mut socket, start(None)).await;
    send(&mut socket, ClientMsg::List).await;
    let listed = tokio::time::timeout(TIMEOUT, async {
        loop {
            let message = socket.next().await.expect("连接断开").unwrap();
            let Message::Text(text) = message else {
                continue;
            };
            let frame: Frame = serde_json::from_str(text.as_str()).unwrap();
            match frame.msg {
                ServerMsg::Sessions { sessions, .. } => {
                    if sessions.iter().all(|session| session.running) {
                        return sessions;
                    }
                    send(&mut socket, ClientMsg::List).await;
                }
                ServerMsg::Error { message } => panic!("hubd 报错：{message}"),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(listed[0].cwd.as_deref(), Some(path.as_str()));
    let _ = hubd.kill().await;
}

/// 订阅先回 `Attached`，`live` 是订阅时日志的长度：之前的是历史，之后的是实时。
#[tokio::test]
async fn attach_reports_where_history_ends() {
    let temp = Temp::new("attached");
    let (_hubd, addr) = spawn_hubd(&temp.0).await;
    let mut socket = connect(&addr).await;
    let start = ClientMsg::Start {
        session: "s1".into(),
        title: None,
        prompt: None,
        model: None,
        resume: None,
        cwd: None,
    };
    send(&mut socket, start).await;
    let attach = ClientMsg::Attach {
        session: "s1".into(),
        after: 0,
    };
    send(&mut socket, attach.clone()).await;
    let user = r#"{"type":"user","message":{"role":"user","content":"go"}}"#;
    let input = ClientMsg::Input {
        session: "s1".into(),
        id: next_id(),
        line: user.into(),
    };
    send(&mut socket, input).await;
    let (mut inbound, mut applied) = (Inbound::new(0), Vec::new());
    // 停在审批上：fake-claude 等回复，日志不再增长。
    read_until(&mut socket, &mut inbound, &mut applied, |line| {
        classify(line) == EventClass::Approval
    })
    .await;
    let length = std::fs::metadata(temp.0.join("s1/out")).unwrap().len();

    let mut other = connect(&addr).await;
    send(&mut other, attach).await;
    let first = async {
        loop {
            if let Message::Text(text) = other.next().await.unwrap().unwrap() {
                let frame: Frame = serde_json::from_str(text.as_str()).unwrap();
                if frame.session.as_deref() == Some("s1") {
                    return frame.msg;
                }
            }
        }
    };
    let first = tokio::time::timeout(TIMEOUT, first).await.unwrap();
    assert_eq!(first, ServerMsg::Attached { live: length });
    assert!(length >= inbound.expected());
}

#[tokio::test]
async fn attach_beyond_log_end_reports_error() {
    let temp = Temp::new("beyond");
    let (_hubd, addr) = spawn_hubd(&temp.0).await;
    let mut socket = connect(&addr).await;
    send(
        &mut socket,
        ClientMsg::Start {
            session: "s1".into(),
            title: None,
            prompt: None,
            model: None,
            resume: None,
            cwd: None,
        },
    )
    .await;
    send(
        &mut socket,
        ClientMsg::Attach {
            session: "s1".into(),
            after: 999,
        },
    )
    .await;
    let wait = async {
        loop {
            if let Message::Text(text) = socket.next().await.unwrap().unwrap() {
                let frame: Frame = serde_json::from_str(text.as_str()).unwrap();
                if matches!(frame.msg, ServerMsg::Error { .. }) {
                    return;
                }
            }
        }
    };
    tokio::time::timeout(TIMEOUT, wait).await.unwrap();
    send(
        &mut socket,
        ClientMsg::Stop {
            session: "s1".into(),
        },
    )
    .await;
}

#[tokio::test]
async fn tailscale_listen_requires_allowed_users() {
    let status = Command::new(env!("CARGO_BIN_EXE_hubd"))
        .env("HUBD_LISTEN", "100.64.0.1:0")
        .stderr(Stdio::null())
        .status()
        .await
        .unwrap();
    assert!(!status.success());
}

/// 回放一个场景：遇到需要人介入的事件就回答，全部走完后和录制、`.jsonl` 比对。
async fn replay_scenario(scenario: &str, expected: EventClass) {
    let temp = Temp::new(scenario);
    let (_hubd, addr) = spawn_replay(&temp.0, scenario).await;
    let mut socket = connect(&addr).await;
    let session = "s1".to_string();
    let mut inbound = Inbound::new(0);
    let mut applied = Vec::new();
    send(
        &mut socket,
        ClientMsg::Start {
            session: session.clone(),
            title: None,
            prompt: None,
            model: None,
            resume: None,
            cwd: None,
        },
    )
    .await;
    send(
        &mut socket,
        ClientMsg::Attach {
            session: session.clone(),
            after: 0,
        },
    )
    .await;
    let user = r#"{"type":"user","message":{"role":"user","content":"go"}}"#;
    send(
        &mut socket,
        ClientMsg::Input {
            session: session.clone(),
            id: next_id(),
            line: user.into(),
        },
    )
    .await;

    let mut interventions = Vec::new();
    loop {
        read_until(&mut socket, &mut inbound, &mut applied, |line| {
            classify(line).needs_human() || event_type(line) == "result"
        })
        .await;
        let last = applied.last().unwrap().clone();
        if event_type(&last) == "result" {
            break;
        }
        interventions.push(classify(&last));
        let request: Value = serde_json::from_str(&last).unwrap();
        let reply = serde_json::json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request["request_id"],
                "response": {"behavior": "allow", "updatedInput": request["request"]["input"]},
            },
        });
        send(
            &mut socket,
            ClientMsg::Input {
                session: session.clone(),
                id: next_id(),
                line: reply.to_string(),
            },
        )
        .await;
        if scenario == "interrupt" {
            let interrupt = serde_json::json!({
                "type": "control_request",
                "request_id": "interrupt-1",
                "request": {"subtype": "interrupt"},
            });
            send(
                &mut socket,
                ClientMsg::Input {
                    session: session.clone(),
                    id: next_id(),
                    line: interrupt.to_string(),
                },
            )
            .await;
        }
    }
    assert!(interventions.contains(&expected), "{interventions:?}");

    let stream = std::fs::read_to_string(recording_in(scenario, "stream.jsonl")).unwrap();
    let durable = |lines: Vec<String>| -> Vec<String> {
        lines
            .into_iter()
            .filter(|l| classify(l) != EventClass::Partial)
            .collect()
    };
    assert_eq!(
        durable(applied.clone()),
        durable(stream.lines().map(str::to_string).collect())
    );

    let transcript = std::fs::read_to_string(recording_in(scenario, "transcript.jsonl")).unwrap();
    let (got_uuids, got_messages, got_tools) = ids(applied.into_iter());
    let (want_uuids, want_messages, want_tools) = ids(transcript.lines().map(str::to_string));
    assert!(
        got_uuids.is_subset(&want_uuids),
        "{got_uuids:?} / {want_uuids:?}"
    );
    assert_eq!(got_messages, want_messages);
    assert_eq!(got_tools, want_tools);
    send(&mut socket, ClientMsg::Stop { session }).await;
}

#[tokio::test]
async fn replays_question() {
    replay_scenario("question", EventClass::Question).await;
}

#[tokio::test]
async fn replays_plan_approval() {
    replay_scenario("plan", EventClass::Question).await;
}

#[tokio::test]
async fn replays_interrupt() {
    replay_scenario("interrupt", EventClass::Approval).await;
}

#[tokio::test]
async fn lists_started_sessions_with_title_and_memory() {
    let temp = Temp::new("list");
    let (mut hubd, addr) = spawn_hubd(&temp.0).await;
    let mut socket = connect(&addr).await;
    send(
        &mut socket,
        ClientMsg::Start {
            session: "s1".into(),
            title: Some("修登录".into()),
            prompt: None,
            model: None,
            resume: None,
            cwd: None,
        },
    )
    .await;
    send(&mut socket, ClientMsg::List).await;

    let listed = tokio::time::timeout(TIMEOUT, async {
        loop {
            let message = socket.next().await.expect("连接断开").unwrap();
            let Message::Text(text) = message else {
                continue;
            };
            if let Ok(Frame {
                msg:
                    ServerMsg::Sessions {
                        sessions,
                        mem_available_mb,
                    },
                ..
            }) = serde_json::from_str(text.as_str())
            {
                // 列表不等进程启动完，所以启动前可能看到未运行，再问一次。
                if sessions.iter().all(|session| session.running) {
                    return (sessions, mem_available_mb);
                }
                send(&mut socket, ClientMsg::List).await;
            }
        }
    })
    .await
    .unwrap();

    assert_eq!(listed.0.len(), 1);
    assert_eq!(listed.0[0].title.as_deref(), Some("修登录"));
    assert!(listed.0[0].running);
    assert!(listed.1.is_some());
    let _ = hubd.kill().await;
}

#[tokio::test]
async fn devices_come_from_workspace_status_and_are_cached() {
    use std::os::unix::fs::PermissionsExt;
    let temp = Temp::new("devices");
    let calls = temp.0.join("calls");
    let script = temp.0.join("cc-workspace");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\necho \"$1\" >> {}\n[ \"$1\" = status ] || exit 1\nprintf 'pc\\tWindows\\tonline\\nmac\\t\\toffline\\n'\n",
            calls.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let cmd = format!(
        "{} {} 1",
        env!("CARGO_BIN_EXE_fake-claude"),
        recording_in("approval", "stream.jsonl").display()
    );
    let mut child = Command::new(env!("CARGO_BIN_EXE_hubd"))
        .env("HUBD_LISTEN", "127.0.0.1:0")
        .env("HUBD_HOST", "direct")
        .env("HUBD_STATE_DIR", &temp.0)
        .env("HUBD_CLAUDE_CMD", cmd)
        .env("HUBD_WORKSPACE_CMD", &script)
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let line = lines.next_line().await.unwrap().unwrap();
    let addr = line.rsplit(' ').next().unwrap().to_string();

    // 两条连接各请求一次，命令只该跑一次。
    for _ in 0..2 {
        let mut socket = connect(&addr).await;
        send(&mut socket, ClientMsg::Devices).await;
        let reply = tokio::time::timeout(TIMEOUT, async {
            loop {
                if let Message::Text(text) = socket.next().await.unwrap().unwrap() {
                    let frame: Frame = serde_json::from_str(text.as_str()).unwrap();
                    if let ServerMsg::Devices { devices, error } = frame.msg {
                        return (devices, error);
                    }
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(reply.1, None);
        assert_eq!(reply.0.len(), 2);
        assert_eq!(reply.0[0].name, "pc");
        assert_eq!(reply.0[0].os.as_deref(), Some("Windows"));
        assert!(reply.0[0].online);
        assert_eq!(reply.0[1].os, None);
        assert!(!reply.0[1].online);
    }
    assert_eq!(std::fs::read_to_string(&calls).unwrap(), "status\n");
}

#[tokio::test]
async fn websocket_with_origin_is_rejected() {
    let temp = Temp::new("origin");
    let (_hubd, addr) = spawn_hubd(&temp.0).await;
    let mut request = format!("ws://{addr}/ws").into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Origin", "https://evil.example".parse().unwrap());
    let error = connect_async(request).await.expect_err("应该被拒绝");
    assert!(error.to_string().contains("403"), "{error}");
}

#[tokio::test]
async fn invalid_session_id_is_rejected() {
    let temp = Temp::new("id");
    let (_hubd, addr) = spawn_hubd(&temp.0).await;
    let mut socket = connect(&addr).await;
    send(
        &mut socket,
        ClientMsg::Start {
            session: "../x".into(),
            title: None,
            prompt: None,
            model: None,
            resume: None,
            cwd: None,
        },
    )
    .await;
    let wait = async {
        loop {
            if let Message::Text(text) = socket.next().await.unwrap().unwrap() {
                return serde_json::from_str::<Frame>(text.as_str()).unwrap();
            }
        }
    };
    let frame = tokio::time::timeout(TIMEOUT, wait).await.unwrap();
    assert!(matches!(frame.msg, ServerMsg::Error { .. }));
    assert!(!temp.0.parent().unwrap().join("x").exists());
}

#[tokio::test]
async fn non_loopback_listen_is_refused() {
    let status = Command::new(env!("CARGO_BIN_EXE_hubd"))
        .env("HUBD_LISTEN", "0.0.0.0:0")
        .stderr(Stdio::null())
        .status()
        .await
        .unwrap();
    assert!(!status.success());
}

/// 订阅到 `target`（订阅时 `out` 的长度）为止，返回收到的事件和跳过区间，以及二进制消息的条数。
async fn collect_replay(socket: &mut Socket, target: u64) -> (Vec<(u64, u64, String)>, usize) {
    let mut decoder = cchub_protocol::FrameDecoder::new();
    let mut got = Vec::new();
    let mut binary = 0;
    let wait = async {
        loop {
            let texts = match socket.next().await.unwrap().unwrap() {
                Message::Text(text) => vec![text.to_string()],
                Message::Binary(bytes) => {
                    binary += 1;
                    decoder.decode(&bytes).unwrap()
                }
                _ => continue,
            };
            for text in texts {
                let frame: Frame = serde_json::from_str(&text).unwrap();
                let (seq, next, payload) = match frame.msg {
                    ServerMsg::Event {
                        seq, next, payload, ..
                    } => (seq, next, payload),
                    ServerMsg::Skipped { seq, next } => (seq, next, String::new()),
                    ServerMsg::Error { message } => panic!("hubd 报错：{message}"),
                    _ => continue,
                };
                got.push((seq, next, payload));
                if next >= target {
                    return;
                }
            }
        }
    };
    tokio::time::timeout(TIMEOUT, wait)
        .await
        .expect("等待回放超时");
    (got, binary)
}

#[tokio::test]
async fn deflate_connection_replays_the_same_events_in_binary_batches() {
    let temp = Temp::new("deflate");
    // 不启动进程，直接放一份日志：录制重复几遍，再加一行带大块 base64 的（会被省略）。
    let dir = temp.0.join("s1");
    std::fs::create_dir_all(&dir).unwrap();
    let mut out = std::fs::read_to_string(recording("stream.jsonl"))
        .unwrap()
        .repeat(20);
    let blob = "QUJD".repeat(30_000);
    out.push_str(&format!(
        "{{\"type\":\"user\",\"message\":{{\"content\":[{{\"type\":\"image\",\"source\":{{\"data\":\"{blob}\"}}}}]}}}}\n"
    ));
    std::fs::write(dir.join("out"), &out).unwrap();
    let target = out.len() as u64;

    let (_hubd, addr) = spawn_hubd(&temp.0).await;
    let attach = ClientMsg::Attach {
        session: "s1".into(),
        after: 0,
    };
    let mut plain = connect(&addr).await;
    send(&mut plain, attach.clone()).await;
    let (expected, binary) = collect_replay(&mut plain, target).await;
    assert_eq!(binary, 0, "没要求压缩的连接不能收到二进制消息");

    let mut socket = connect_url(&format!("ws://{addr}/ws?z=deflate&v=1")).await;
    send(&mut socket, attach).await;
    let (got, binary) = collect_replay(&mut socket, target).await;
    assert!(binary > 0, "要求压缩的连接应收到二进制批次");
    assert!(
        binary < got.len(),
        "应该合批：{binary} 条消息 {} 个事件",
        got.len()
    );
    assert_eq!(got, expected);
}

/// 等某条输入的回执。
async fn ack_for(socket: &mut Socket, id: &str) -> Option<AckError> {
    let wait = async {
        loop {
            let message = socket.next().await.expect("连接断开").unwrap();
            let Message::Text(text) = message else {
                continue;
            };
            let frame: Frame = serde_json::from_str(text.as_str()).unwrap();
            match frame.msg {
                ServerMsg::Ack { id: got, error } if got == id => return error,
                ServerMsg::Error { message } => panic!("hubd 报错：{message}"),
                _ => {}
            }
        }
    };
    tokio::time::timeout(TIMEOUT, wait)
        .await
        .expect("等待回执超时")
}

fn start_plain(session: &str) -> ClientMsg {
    ClientMsg::Start {
        session: session.into(),
        resume: None,
        cwd: None,
        title: None,
        prompt: None,
        model: None,
    }
}

fn input(id: &str, line: &str) -> ClientMsg {
    ClientMsg::Input {
        session: "s1".into(),
        id: id.into(),
        line: line.into(),
    }
}

/// 不带协议版本的旧客户端只收到一条 `Error`，然后连接被关闭。
#[tokio::test]
async fn old_client_is_told_to_upgrade_and_disconnected() {
    let temp = Temp::new("old-client");
    let (_hubd, addr) = spawn_hubd(&temp.0).await;
    let mut socket = connect_async(format!("ws://{addr}/ws?z=deflate"))
        .await
        .unwrap()
        .0;
    let first = socket.next().await.unwrap().unwrap();
    let Message::Text(text) = first else {
        panic!("第一帧不是文本：{first:?}");
    };
    let frame: Frame = serde_json::from_str(text.as_str()).unwrap();
    assert!(
        matches!(&frame.msg, ServerMsg::Error { message } if message.contains("客户端版本过旧")),
        "{text}"
    );
    let rest = tokio::time::timeout(TIMEOUT, async {
        while let Some(Ok(message)) = socket.next().await {
            if matches!(message, Message::Text(_) | Message::Binary(_)) {
                panic!("拒绝后还收到了消息：{message:?}");
            }
        }
    });
    rest.await.expect("连接没有关闭");
}

/// 进程不在：输入不写进 FIFO，回执 `not_running`。
#[tokio::test]
async fn input_is_refused_when_process_is_not_running() {
    let temp = Temp::new("not-running");
    let (_hubd, addr) = spawn_hubd_with(&temp.0, "direct", "true").await;
    let mut socket = connect(&addr).await;
    send(&mut socket, start_plain("s1")).await;
    // `true` 马上退出；等它真的不在了再发。
    let pid: i32 = loop {
        if let Ok(pid) = std::fs::read_to_string(temp.0.join("s1/pid")) {
            break pid.trim().parse().unwrap();
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    while Path::new(&format!("/proc/{pid}/cmdline")).exists()
        && !std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .unwrap_or_default()
            .contains(") Z")
    {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    send(&mut socket, input("a", r#"{"type":"user"}"#)).await;
    assert_eq!(ack_for(&mut socket, "a").await, Some(AckError::NotRunning));

    let mut fifo = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(temp.0.join("s1").join("in"))
        .unwrap();
    let error = fifo.read(&mut [0; 64]).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
}

/// 同一个 id 重发（含换一条连接补发）只写一次，回执照常是成功。
#[tokio::test]
async fn duplicate_input_is_written_once() {
    let temp = Temp::new("dedupe");
    // `cat` 把读到的输入原样写进日志，日志里出现几次就是写了几次。
    let (_hubd, addr) = spawn_hubd_with(&temp.0, "direct", "cat").await;
    let mut socket = connect(&addr).await;
    send(&mut socket, start_plain("s1")).await;
    let attach = ClientMsg::Attach {
        session: "s1".into(),
        after: 0,
    };
    send(&mut socket, attach.clone()).await;
    let first = r#"{"type":"user","n":1}"#;
    send(&mut socket, input("a", first)).await;
    assert_eq!(ack_for(&mut socket, "a").await, None);
    send(&mut socket, input("a", first)).await;
    assert_eq!(ack_for(&mut socket, "a").await, None);

    let mut other = connect(&addr).await;
    send(&mut other, input("a", first)).await;
    assert_eq!(ack_for(&mut other, "a").await, None);
    let last = r#"{"type":"user","n":2}"#;
    send(&mut other, input("b", last)).await;
    assert_eq!(ack_for(&mut other, "b").await, None);

    send(&mut other, attach).await;
    let mut inbound = Inbound::new(0);
    let mut applied = Vec::new();
    read_until(&mut other, &mut inbound, &mut applied, |line| line == last).await;
    assert_eq!(applied, [first, last]);
}

/// 进程一直不读输入：写满后等超时回执 `stalled`，FIFO 里只有完整的行。
#[tokio::test]
async fn stalled_input_times_out_without_half_lines() {
    let temp = Temp::new("stalled");
    let env = [("HUBD_INPUT_TIMEOUT_MS", "300")];
    let (_hubd, addr) = spawn_hubd_env(&temp.0, "direct", "sleep 600", &env).await;
    let mut socket = connect(&addr).await;
    send(&mut socket, start_plain("s1")).await;
    let line = format!(r#"{{"type":"user","pad":"{}"}}"#, "z".repeat(200 * 1024));
    let mut written = 0;
    loop {
        let id = format!("big-{written}");
        send(&mut socket, input(&id, &line)).await;
        match ack_for(&mut socket, &id).await {
            None => written += 1,
            Some(error) => {
                assert_eq!(error, AckError::Stalled);
                break;
            }
        }
        assert!(written < 100, "一直写得进去");
    }
    assert!(written > 0);
    // 停掉进程前读出 FIFO：只能有完整的行。
    let mut fifo = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(temp.0.join("s1").join("in"))
        .unwrap();
    let mut data = Vec::new();
    let mut buffer = vec![0; 64 * 1024];
    loop {
        match fifo.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => data.extend_from_slice(&buffer[..count]),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(error) => panic!("{error}"),
        }
    }
    assert_eq!(data.len(), written * (line.len() + 1));
    send(
        &mut socket,
        ClientMsg::Stop {
            session: "s1".into(),
        },
    )
    .await;
}
