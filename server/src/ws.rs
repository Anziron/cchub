//! WebSocket 连接：每个订阅的会话一个读日志任务，经有界通道汇到一个发送任务。

use std::collections::HashMap;
use std::io::SeekFrom;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{ConnectInfo, State, WebSocketUpgrade};
use axum::http::{header::ORIGIN, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use cchub_protocol::{
    is_user_message, ClientMsg, Frame, LineSplitter, Outbound, OutboundLimits, ServerMsg,
};
use futures_util::{SinkExt, StreamExt};
use inotify::{Inotify, WatchMask};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::mpsc;
use tokio::task::{spawn_blocking, JoinHandle};

use crate::auth;
use crate::device::{self, Probes, Subscription};
use crate::host::ProcessHost;
use crate::session::{valid_id, Sessions};
use crate::title;
use crate::workspace;

const HEARTBEAT: Duration = Duration::from_secs(15);
const STATUS_EVERY: Duration = Duration::from_secs(5);
const READ_CHUNK: usize = 64 * 1024;
const CHANNEL_FRAMES: usize = 16;
const TITLE_TIMEOUT: Duration = Duration::from_secs(30);

pub struct App {
    pub sessions: Sessions,
    pub host: Box<dyn ProcessHost>,
    pub allowed_users: Vec<String>,
    pub min_available_mb: u64,
    pub workspace_cmd: String,
    pub title_cmd: String,
    pub title_memory_mb: u64,
    /// 设备探测按项目目录共享，所有连接订阅同一个结果。
    pub probes: Probes,
}

pub async fn upgrade(
    State(app): State<Arc<App>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    // 桌面端的连接在 Rust 进程里，不带 Origin。带 Origin 的只可能来自网页，一律拒绝，
    // 否则设备上任何网页都能连上来，在服务器上执行命令。
    if headers.contains_key(ORIGIN) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let users = app.clone();
    let allowed = spawn_blocking(move || auth::is_allowed(peer, &users.allowed_users))
        .await
        .unwrap_or(false);
    if !allowed {
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.on_upgrade(move |socket| serve(app, socket))
}

async fn serve(app: Arc<App>, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Frame>(CHANNEL_FRAMES);

    let writer = tokio::spawn(async move {
        let mut heartbeat = tokio::time::interval(HEARTBEAT);
        loop {
            let message = tokio::select! {
                frame = rx.recv() => match frame {
                    Some(frame) => match serde_json::to_string(&frame) {
                        Ok(text) => Message::Text(text.into()),
                        Err(_) => continue,
                    },
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
    let mut start_failed = false;
    while let Some(msg) = messages.recv().await {
        // 启动失败时，客户端已经因为同一个错误把消息标成没发出去。这里写进 FIFO
        // 会留到下次启动，和用户重发的消息一起被处理。
        if start_failed && matches!(msg, ClientMsg::Input { .. }) {
            continue;
        }
        let is_start = matches!(msg, ClientMsg::Start { .. });
        let result = handle(&app, &session, msg, &tx, &mut reader).await;
        if is_start {
            start_failed = result.is_err();
        }
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
        ClientMsg::Start { resume, cwd, .. } => {
            let cwd = cwd.map(PathBuf::from);
            if cwd.as_ref().is_some_and(|cwd| !cwd.is_absolute()) {
                return Err("cwd 必须是绝对路径".to_string());
            }
            if resume.as_deref().is_some_and(|id| !valid_id(id)) {
                return Err("resume ID 不合法".to_string());
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
                        // 在断开的挂载里启动进程不会报错，只会一直没有输出，所以先探测。
                        if !device::probe(&workdir) {
                            return Err(std::io::Error::other("设备离线，无法启动会话"));
                        }
                        workdir
                    }
                    None => dir.clone(),
                };
                app.host.start(&id, &dir, &workdir, resume.as_deref())
            })
            .await?;
        }
        ClientMsg::Attach { after, .. } => {
            if let Some(old) = reader.take() {
                old.abort();
            }
            *reader = Some(tokio::spawn(follow(app.clone(), id, after, tx.clone())));
        }
        ClientMsg::Input { line, .. } => {
            blocking(app, move |app| {
                app.sessions.write_line(&id, &line)?;
                // 用户发言才算活跃，侧边栏据此排序；审批回复等控制消息不算。
                if is_user_message(&line) {
                    app.sessions.touch_active(&id)?;
                }
                Ok(())
            })
            .await?;
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
        | ClientMsg::TaskOutput { .. } => {}
    }
    Ok(())
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
    use super::has_room;

    #[test]
    fn rejects_only_when_known_to_be_short() {
        assert!(has_room(Some(300), 300));
        assert!(!has_room(Some(299), 300));
        assert!(has_room(None, 300));
        assert!(has_room(Some(0), 0));
    }
}
