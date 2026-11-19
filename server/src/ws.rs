//! WebSocket 连接：每个订阅的会话一个读日志任务，经有界通道汇到一个发送任务。

use std::collections::HashMap;
use std::io::SeekFrom;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{ConnectInfo, RawQuery, State, WebSocketUpgrade};
use axum::http::{header::ORIGIN, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use cchub_protocol::{
    client_version, is_user_message, wants_deflate, ClientMsg, DeviceInfo, Frame, FrameEncoder,
    LineSplitter, Outbound, OutboundLimits, ServerMsg, PROTOCOL_VERSION,
};
use futures_util::{SinkExt, StreamExt};
use inotify::{Inotify, WatchMask};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::mpsc;
use tokio::task::{spawn_blocking, JoinHandle};

use crate::auth;
use crate::device::{self, Probes, Subscription};
use crate::host::{valid_model, Launch, ProcessHost};
use crate::session::{valid_id, Sessions, Written};
use crate::title;
use crate::usage;
use crate::workspace;

const HEARTBEAT: Duration = Duration::from_secs(15);
const STATUS_EVERY: Duration = Duration::from_secs(5);
const READ_CHUNK: usize = 64 * 1024;
const CHANNEL_FRAMES: usize = 16;
/// 压缩连接一批最多合并这么多字节的帧原文。
const BATCH_BYTES: usize = 256 * 1024;
const TITLE_TIMEOUT: Duration = Duration::from_secs(30);

pub struct App {
    pub sessions: Sessions,
    pub host: Box<dyn ProcessHost>,
    pub allowed_users: Vec<String>,
    /// 监听地址。监听 Tailscale 地址时，来自本机的连接一律拒绝（见 `auth`）。
    pub listen: SocketAddr,
    pub min_available_mb: u64,
    pub workspace_cmd: String,
    pub title_cmd: String,
    /// 标题和用量统计命令所在 scope 的 `MemoryMax`；0 表示不放进独立 scope。
    pub title_memory_mb: u64,
    /// 用量统计命令，协议见 `usage.rs`；为空时关闭。
    pub usage_cmd: String,
    pub usage_lock: tokio::sync::Mutex<()>,
    /// 设备探测按项目目录共享，所有连接订阅同一个结果。
    pub probes: Probes,
    /// `cc-workspace status` 的结果和取得时间。
    pub devices_cache: tokio::sync::Mutex<Option<(std::time::Instant, Vec<DeviceInfo>)>>,
    /// 进程不读输入时写一行最多等这么久，见 `Sessions::write_input`。
    pub input_timeout: Duration,
}

pub async fn upgrade(
    State(app): State<Arc<App>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    // 桌面端的连接在 Rust 进程里，不带 Origin。带 Origin 的只可能来自网页，一律拒绝，
    // 否则设备上任何网页都能连上来，在服务器上执行命令。
    if headers.contains_key(ORIGIN) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let users = app.clone();
    let allowed =
        spawn_blocking(move || auth::is_allowed(peer, users.listen, &users.allowed_users))
            .await
            .unwrap_or(false);
    if !allowed {
        return StatusCode::FORBIDDEN.into_response();
    }
    let deflate = wants_deflate(query.as_deref());
    let version = client_version(query.as_deref());
    ws.on_upgrade(move |socket| serve(app, socket, deflate, version))
}

/// 协议版本不一致时给对方看的话；一致时为空。旧客户端不带版本，只认得 `Error`。
fn version_mismatch(client: Option<u32>) -> Option<&'static str> {
    match client {
        Some(version) if version == PROTOCOL_VERSION => None,
        Some(version) if version > PROTOCOL_VERSION => {
            Some("服务器版本过旧，请升级服务器上的 hubd")
        }
        _ => Some("客户端版本过旧，请升级"),
    }
}

/// `deflate`：客户端要求压缩（见 `cchub_protocol::codec`）。这时把已经就绪的帧合成一批，
/// 压缩后作为一条二进制消息发出；回放长会话时消息数和字节数都大幅减少。
async fn serve(app: Arc<App>, socket: WebSocket, deflate: bool, version: Option<u32>) {
    let (mut sink, mut stream) = socket.split();
    // 第一帧总是文本：版本不对就说明原因后断开；对了就发 `Hello`，客户端收到才开始收发。
    let first = match version_mismatch(version) {
        Some(message) => ServerMsg::Error {
            message: message.to_string(),
        },
        None => ServerMsg::Hello {
            version: env!("CARGO_PKG_VERSION").to_string(),
            protocol_version: PROTOCOL_VERSION,
        },
    };
    let first = Frame {
        session: None,
        msg: first,
    };
    let Ok(text) = serde_json::to_string(&first) else {
        return;
    };
    if sink.send(Message::Text(text.into())).await.is_err() || version_mismatch(version).is_some() {
        let _ = sink.close().await;
        return;
    }
    let (tx, mut rx) = mpsc::channel::<Frame>(CHANNEL_FRAMES);

    let writer = tokio::spawn(async move {
        let mut heartbeat = tokio::time::interval(HEARTBEAT);
        let mut encoder = deflate.then(FrameEncoder::new);
        loop {
            let message = tokio::select! {
                frame = rx.recv() => match frame {
                    Some(frame) => {
                        let Ok(text) = serde_json::to_string(&frame) else { continue };
                        match encoder.take() {
                            None => Message::Text(text.into()),
                            Some(enc) => {
                                let mut size = text.len();
                                let mut batch = vec![text];
                                while size < BATCH_BYTES {
                                    let Ok(frame) = rx.try_recv() else { break };
                                    if let Ok(text) = serde_json::to_string(&frame) {
                                        size += text.len();
                                        batch.push(text);
                                    }
                                }
                                // 运行时是单线程的：压缩放到阻塞线程池，读日志的任务同时接着读。
                                let Ok((enc, bytes)) = spawn_blocking(move || {
                                    let mut enc = enc;
                                    let bytes = enc.encode(&batch);
                                    (enc, bytes)
                                })
                                .await
                                else {
                                    return;
                                };
                                encoder = Some(enc);
                                Message::Binary(bytes.into())
                            }
                        }
                    }
                    None => return,
                },
                _ = heartbeat.tick() => Message::Ping(Vec::new().into()),
            };
            if sink.send(message).await.is_err() {
                return;
            }
        }
    });

    // 每个会话一个有序队列：启动进程要几秒，不能挡住其他会话和列表请求。
    let mut workers: HashMap<String, mpsc::UnboundedSender<ClientMsg>> = HashMap::new();
    while let Some(Ok(message)) = stream.next().await {
        let Message::Text(text) = message else {
            continue;
        };
        let msg = match serde_json::from_str::<ClientMsg>(text.as_str()) {
            Ok(msg) => msg,
            Err(error) => {
                let message = format!("无法解析消息：{error}");
                if send_error(&tx, None, message).await.is_err() {
                    break;
                }
                continue;
            }
        };
        let session = match &msg {
            ClientMsg::List => {
                tokio::spawn(list(app.clone(), tx.clone()));
                continue;
            }
            ClientMsg::Browse { device, path } => {
                let (device, path) = (device.clone(), path.clone());
                tokio::spawn(browse(app.clone(), device, path, tx.clone()));
                continue;
            }
            ClientMsg::Mount { device, path } => {
                let (device, path) = (device.clone(), path.clone());
                tokio::spawn(mount(app.clone(), device, path, tx.clone()));
                continue;
            }
            ClientMsg::TaskOutput { path } => {
                tokio::spawn(task_output(path.clone(), tx.clone()));
                continue;
            }
            ClientMsg::Usage { tz_offset } => {
                tokio::spawn(usage_stats(app.clone(), *tz_offset, tx.clone()));
                continue;
            }
            ClientMsg::Devices => {
                tokio::spawn(devices(app.clone(), tx.clone()));
                continue;
            }
            ClientMsg::Start { session, .. }
            | ClientMsg::Attach { session, .. }
            | ClientMsg::Input { session, .. }
            | ClientMsg::Archive { session, .. }
            | ClientMsg::Stop { session } => session.clone(),
        };
        if !valid_id(&session) {
            let message = "会话 ID 不合法".to_string();
            if send_error(&tx, None, message).await.is_err() {
                break;
            }
            continue;
        }
        // 建目录和写标题只碰本机磁盘，先做完，紧接着的列表请求才能看到这个会话。
        if let ClientMsg::Start { title, prompt, .. } = &msg {
            let (id, title) = (session.clone(), title.clone());
            let prompt = prompt.clone();
            let prepared = blocking(&app, move |app| {
                app.sessions.prepare(&id)?;
                // 从 `/resume` 回来或在别处继续：重新启动就不再算关闭。
                app.sessions.set_archived(&id, false)?;
                match &title {
                    Some(title) => app.sessions.set_title(&id, title),
                    None => Ok(()),
                }
            })
            .await;
            if let Err(message) = prepared {
                if send_error(&tx, Some(session), message).await.is_err() {
                    break;
                }
                continue;
            }
            if let Some(prompt) = prompt.filter(|prompt| !prompt.trim().is_empty()) {
                if !app.title_cmd.is_empty() {
                    spawn_blocking({
                        let (app, id) = (app.clone(), session.clone());
                        move || summarize_title(&app, &id, &prompt)
                    });
                }
            }
        }
        let worker = workers.entry(session.clone()).or_insert_with(|| {
            let (queue, messages) = mpsc::unbounded_channel();
            tokio::spawn(session_worker(
                app.clone(),
                session.clone(),
                messages,
                tx.clone(),
            ));
            queue
        });
        let _ = worker.send(msg);
    }

    // 队列关闭后各会话任务自己结束，并停掉各自的日志跟读。
    drop(workers);
    writer.abort();
}

async fn send_error(
    tx: &mpsc::Sender<Frame>,
    session: Option<String>,
    message: String,
) -> Result<(), ()> {
    let msg = ServerMsg::Error { message };
    tx.send(Frame { session, msg }).await.map_err(|_| ())
}

async fn session_worker(
    app: Arc<App>,
    session: String,
    mut messages: mpsc::UnboundedReceiver<ClientMsg>,
    tx: mpsc::Sender<Frame>,
) {
    let mut reader = None;
    // 启动失败后进程不在，紧跟着的输入会被回执 `not_running`，不会留在 FIFO 里。
    while let Some(msg) = messages.recv().await {
        let result = handle(&app, &session, msg, &tx, &mut reader).await;
        if let Err(message) = result {
            if send_error(&tx, Some(session.clone()), message)
                .await
                .is_err()
            {
                break;
            }
        }
    }
    if let Some(reader) = reader {
        reader.abort();
    }
}

async fn handle(
    app: &Arc<App>,
    session: &str,
    msg: ClientMsg,
    tx: &mpsc::Sender<Frame>,
    reader: &mut Option<JoinHandle<()>>,
) -> Result<(), String> {
    let id = session.to_string();
    match msg {
        ClientMsg::Start {
            resume, cwd, model, ..
        } => {
            let cwd = cwd.map(PathBuf::from);
            if cwd.as_ref().is_some_and(|cwd| !cwd.is_absolute()) {
                return Err("cwd 必须是绝对路径".to_string());
            }
            if resume.as_deref().is_some_and(|id| !valid_id(id)) {
                return Err("resume ID 不合法".to_string());
            }
            if model.as_deref().is_some_and(|model| !valid_model(model)) {
                return Err("模型名不合法".to_string());
            }
            blocking(app, move |app| {
                let dir = app.sessions.dir(&id);
                if app.host.is_running(&id, &dir) {
                    return Ok(());
                }
                let available = mem_available_mb();
                if !has_room(available, app.min_available_mb) {
                    return Err(std::io::Error::other(format!(
                        "服务器可用内存不足（{} MB，至少需要 {} MB），请先结束其他会话",
                        available.unwrap_or(0),
                        app.min_available_mb
                    )));
                }
                // 先记下目录：探测失败后重试时不带目录，也不能退回会话目录。
                if let Some(cwd) = &cwd {
                    app.sessions.set_cwd(&id, cwd)?;
                }
                let workdir = match app.sessions.cwd(&id) {
                    Some(workdir) => {
                        if workdir.starts_with("/mnt") {
                            workspace::ensure(&app.workspace_cmd, &workdir)
                                .map_err(std::io::Error::other)?;
                        }
                        // 在断开的挂载里启动进程不会报错，只会一直没有输出，所以先探测。
                        if !device::probe(&workdir) {
                            return Err(std::io::Error::other("设备离线，无法启动会话"));
                        }
                        workdir
                    }
                    None => dir.clone(),
                };
                let launch = Launch {
                    resume: resume.as_deref(),
                    model: model.as_deref(),
                };
                app.host.start(&id, &dir, &workdir, launch)
            })
            .await?;
        }
        ClientMsg::Attach { after, .. } => {
            if let Some(old) = reader.take() {
                old.abort();
            }
            *reader = Some(tokio::spawn(follow(app.clone(), id, after, tx.clone())));
        }
        ClientMsg::Input {
            id: input, line, ..
        } => {
            let host = app.clone();
            let session = id.clone();
            let written = spawn_blocking(move || {
                let app = host;
                let dir = app.sessions.dir(&session);
                let written =
                    app.sessions
                        .write_input(&session, &input, &line, app.input_timeout, || {
                            app.host.is_running(&session, &dir)
                        });
                // 用户发言才算活跃，侧边栏据此排序；审批回复等控制消息不算。
                if written == Ok(Written::Fresh) && is_user_message(&line) {
                    let _ = app.sessions.touch_active(&session);
                }
                (input, written)
            })
            .await;
            let Ok((input, written)) = written else {
                return Err("写入输入失败".to_string());
            };
            let msg = ServerMsg::Ack {
                id: input,
                error: written.err(),
            };
            let _ = tx
                .send(Frame {
                    session: Some(id),
                    msg,
                })
                .await;
        }
        ClientMsg::Stop { .. } => {
            blocking(app, move |app| {
                let result = app.host.stop(&id, &app.sessions.dir(&id));
                app.sessions.release(&id);
                result
            })
            .await?;
        }
        ClientMsg::Archive { archived, .. } => {
            blocking(app, move |app| {
                if archived {
                    let dir = app.sessions.dir(&id);
                    if app.host.is_running(&id, &dir) {
                        app.host.stop(&id, &dir)?;
                    }
                    app.sessions.release(&id);
                }
                app.sessions.set_archived(&id, archived)
            })
            .await?;
        }
        ClientMsg::List
        | ClientMsg::Browse { .. }
        | ClientMsg::Mount { .. }
        | ClientMsg::TaskOutput { .. }
        | ClientMsg::Usage { .. }
        | ClientMsg::Devices => {}
    }
    Ok(())
}

/// 设备状态在 hubd 内缓存这么久：多个连接、频繁刷新只跑一次命令。
const DEVICES_TTL: Duration = Duration::from_secs(15);

async fn devices(app: Arc<App>, tx: mpsc::Sender<Frame>) {
    // 持锁期间命令只跑一次，排队的请求拿到的是刚写好的缓存。失败不缓存。
    let result = {
        let mut cache = app.devices_cache.lock().await;
        match &*cache {
            Some((at, devices)) if at.elapsed() < DEVICES_TTL => Ok(devices.clone()),
            _ => {
                let from = app.clone();
                let fresh = spawn_blocking(move || workspace::status(&from.workspace_cmd))
                    .await
                    .unwrap_or_else(|error| Err(error.to_string()));
                if let Ok(devices) = &fresh {
                    *cache = Some((std::time::Instant::now(), devices.clone()));
                }
                fresh
            }
        }
    };
    let msg = match result {
        Ok(devices) => ServerMsg::Devices {
            devices,
            error: None,
        },
        Err(error) => ServerMsg::Devices {
            devices: Vec::new(),
            error: Some(error),
        },
    };
    let _ = tx.send(Frame { session: None, msg }).await;
}

async fn browse(
    app: Arc<App>,
    device: Option<String>,
    path: Option<String>,
    tx: mpsc::Sender<Frame>,
) {
    let (from_device, from_path) = (device.clone(), path.clone());
    let listing = spawn_blocking(move || {
        workspace::browse(
            &app.workspace_cmd,
            from_device.as_deref(),
            from_path.as_deref(),
        )
    })
    .await
    .unwrap_or_else(|error| Err(error.to_string()));
    let msg = match listing {
        Ok(listing) => ServerMsg::Browse {
            device,
            path: listing.path,
            parent: listing.parent,
            entries: listing.entries,
            error: None,
        },
        Err(error) => ServerMsg::Browse {
            device,
            path,
            parent: None,
            entries: Vec::new(),
            error: Some(error),
        },
    };
    let _ = tx.send(Frame { session: None, msg }).await;
}

async fn mount(app: Arc<App>, device: String, path: String, tx: mpsc::Sender<Frame>) {
    let (from_device, from_path) = (device.clone(), path.clone());
    let mounted =
        spawn_blocking(move || workspace::mount(&app.workspace_cmd, &from_device, &from_path))
            .await
            .unwrap_or_else(|error| Err(error.to_string()));
    let (cwd, error) = match mounted {
        Ok(cwd) => (Some(cwd), None),
        Err(error) => (None, Some(error)),
    };
    let msg = ServerMsg::Mounted {
        device,
        path,
        cwd,
        error,
    };
    let _ = tx.send(Frame { session: None, msg }).await;
}

async fn task_output(path: String, tx: mpsc::Sender<Frame>) {
    let from = path.clone();
    let output = spawn_blocking(move || workspace::read_task_output(&from))
        .await
        .unwrap_or_else(|error| Err(error.to_string()));
    let (text, error) = match output {
        Ok(text) => (Some(text), None),
        Err(error) => (None, Some(error)),
    };
    let msg = ServerMsg::TaskOutput { path, text, error };
    let _ = tx.send(Frame { session: None, msg }).await;
}

async fn usage_stats(app: Arc<App>, tz_offset: i32, tx: mpsc::Sender<Frame>) {
    // 同一时间只跑一个统计：命令自己也加了文件锁，排队的请求等前一个写好缓存后会很快。
    let _running = app.usage_lock.lock().await;
    let from = app.clone();
    let result =
        spawn_blocking(move || usage::stats(&from.usage_cmd, tz_offset, from.title_memory_mb))
            .await
            .unwrap_or_else(|error| Err(error.to_string()));
    let (stats, error) = match result {
        Ok(stats) => (Some(stats), None),
        Err(error) => (None, Some(error)),
    };
    let msg = ServerMsg::Usage { stats, error };
    let _ = tx.send(Frame { session: None, msg }).await;
}

async fn list(app: Arc<App>, tx: mpsc::Sender<Frame>) {
    let host = app.clone();
    let Ok(sessions) =
        spawn_blocking(move || host.sessions.list(|id, dir| host.host.is_running(id, dir))).await
    else {
        return;
    };
    let frame = Frame {
        session: None,
        msg: ServerMsg::Sessions {
            sessions,
            mem_available_mb: mem_available_mb(),
        },
    };
    let _ = tx.send(frame).await;
}

/// 后台生成标题，失败时保留客户端给的截断标题。客户端下次 `List` 时看到新标题。
fn summarize_title(app: &App, session: &str, prompt: &str) {
    if !has_room(mem_available_mb(), app.min_available_mb) {
        return;
    }
    let dir = app.sessions.dir(session);
    let summary = title::generate(
        &app.title_cmd,
        &dir,
        app.title_memory_mb,
        prompt,
        TITLE_TIMEOUT,
    );
    if let Some(summary) = summary {
        let _ = app.sessions.set_title(session, &summary);
    }
}

fn mem_available_mb() -> Option<u64> {
    let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
    let line = meminfo.lines().find(|l| l.starts_with("MemAvailable:"))?;
    let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb / 1024)
}

/// 读不到内存信息时放行：检查只是保护，不应挡住正常使用。
fn has_room(available_mb: Option<u64>, min_mb: u64) -> bool {
    available_mb.is_none_or(|available| available >= min_mb)
}

async fn blocking(
    app: &Arc<App>,
    f: impl FnOnce(&App) -> std::io::Result<()> + Send + 'static,
) -> Result<(), String> {
    let app = app.clone();
    spawn_blocking(move || f(&app))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// 从偏移开始跟读日志。积压时 `Outbound` 跳过逐字片段或暂停读取，内存有上限。
/// 日志有变化才读，空闲时只有定时的状态检查。
async fn follow(app: Arc<App>, session: String, after: u64, tx: mpsc::Sender<Frame>) {
    let frame = |msg| Frame {
        session: Some(session.clone()),
        msg,
    };
    let path = app.sessions.out_path(&session);
    // 先建监听再读，订阅期间写入的内容不会漏。
    let (mut changes, replay_until) = match watch(&path, after).await {
        Ok(watching) => watching,
        Err(message) => {
            let _ = tx.send(frame(ServerMsg::Error { message })).await;
            return;
        }
    };

    // 先于这次订阅的任何事件：告诉客户端历史到哪里为止。
    let attached = ServerMsg::Attached { live: replay_until };
    if tx.send(frame(attached)).await.is_err() {
        return;
    }

    let mut splitter = LineSplitter::new(after);
    let mut queue = Outbound::new(OutboundLimits::default());
    // 订阅时已有的内容是回放：写完整的消息不再需要它的逐字片段。
    queue.set_replay_until(replay_until);
    let mut buffer = vec![0; READ_CHUNK];
    let mut status = tokio::time::interval(STATUS_EVERY);
    let mut last_running = None;
    let mut device: Option<(PathBuf, Subscription)> = None;

    if let Err(message) = fill(&path, &mut splitter, &mut queue, &mut buffer).await {
        let _ = tx.send(frame(ServerMsg::Error { message })).await;
        return;
    }

    loop {
        let filled = tokio::select! {
            permit = tx.reserve(), if !queue.is_empty() => {
                let Ok(permit) = permit else { return };
                let was_full = !queue.wants_more();
                if let Some(msg) = queue.pop() {
                    permit.send(frame(msg));
                }
                // 之前因为队列满暂停了读取，腾出空间后要接着读。
                if was_full && queue.wants_more() {
                    fill(&path, &mut splitter, &mut queue, &mut buffer).await
                } else {
                    Ok(())
                }
            }
            change = changes.next() => {
                if !matches!(change, Some(Ok(_))) {
                    let message = "监听日志失败".to_string();
                    let _ = tx.send(frame(ServerMsg::Error { message })).await;
                    return;
                }
                fill(&path, &mut splitter, &mut queue, &mut buffer).await
            }
            online = async { device.as_mut().expect("条件已保证").1.changed().await }, if device.is_some() => {
                if let Some(online) = online {
                    if tx.send(frame(ServerMsg::Device { online })).await.is_err() {
                        return;
                    }
                }
                Ok(())
            }
            _ = status.tick() => {
                let (host, id) = (app.clone(), session.clone());
                let running = spawn_blocking(move || host.host.is_running(&id, &host.sessions.dir(&id)))
                    .await
                    .unwrap_or(false);
                if last_running != Some(running) {
                    last_running = Some(running);
                    if tx.send(frame(ServerMsg::Status { running })).await.is_err() {
                        return;
                    }
                }
                // 项目目录可能在订阅后才记下或变化：每次检查，变了就换订阅。
                if let Some(cwd) = app.sessions.cwd(&session) {
                    if device.as_ref().is_none_or(|(current, _)| *current != cwd) {
                        let mut subscription = app.probes.subscribe(&cwd);
                        let known = subscription.current();
                        device = Some((cwd, subscription));
                        if let Some(online) = known {
                            if tx.send(frame(ServerMsg::Device { online })).await.is_err() {
                                return;
                            }
                        }
                    }
                }
                Ok(())
            }
        };
        if let Err(message) = filled {
            let _ = tx.send(frame(ServerMsg::Error { message })).await;
            return;
        }
    }
}

/// 返回日志的变化流和订阅时日志的长度（回放边界）。
async fn watch(
    path: &std::path::Path,
    after: u64,
) -> Result<(inotify::EventStream<[u8; 1024]>, u64), String> {
    let length = tokio::fs::metadata(path)
        .await
        .map_err(|error| format!("读取日志失败：{error}"))?
        .len();
    if after > length {
        return Err("日志已被清理，无法从该位置继续".to_string());
    }
    let failed = |error: std::io::Error| format!("监听日志失败：{error}");
    let inotify = Inotify::init().map_err(failed)?;
    inotify
        .watches()
        .add(path, WatchMask::MODIFY)
        .map_err(failed)?;
    let changes = inotify.into_event_stream([0; 1024]).map_err(failed)?;
    Ok((changes, length))
}

async fn fill(
    path: &std::path::Path,
    splitter: &mut LineSplitter,
    queue: &mut Outbound,
    buffer: &mut [u8],
) -> Result<(), String> {
    while queue.wants_more() {
        let count = read_at(path, splitter.read_offset(), buffer)
            .await
            .map_err(|error| format!("读取日志失败：{error}"))?;
        if count == 0 {
            break;
        }
        for (seq, next, line) in splitter.feed(&buffer[..count]) {
            queue.push(seq, next, line);
        }
    }
    Ok(())
}

async fn read_at(path: &std::path::Path, offset: u64, buffer: &mut [u8]) -> std::io::Result<usize> {
    let mut file = tokio::fs::File::open(path).await?;
    file.seek(SeekFrom::Start(offset)).await?;
    file.read(buffer).await
}

#[cfg(test)]
mod tests {
    use super::{has_room, version_mismatch};
    use cchub_protocol::PROTOCOL_VERSION;

    #[test]
    fn only_the_current_protocol_is_served() {
        assert_eq!(version_mismatch(Some(PROTOCOL_VERSION)), None);
        assert!(version_mismatch(None).unwrap().contains("客户端"));
        assert!(version_mismatch(Some(0)).unwrap().contains("客户端"));
        assert!(version_mismatch(Some(PROTOCOL_VERSION + 1))
            .unwrap()
            .contains("服务器"));
    }

    #[test]
    fn rejects_only_when_known_to_be_short() {
        assert!(has_room(Some(300), 300));
        assert!(!has_room(Some(299), 300));
        assert!(has_room(None, 300));
        assert!(has_room(Some(0), 0));
    }
}
