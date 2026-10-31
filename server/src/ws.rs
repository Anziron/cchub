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
use cchub_protocol::{ClientMsg, Frame, LineSplitter, Outbound, OutboundLimits, ServerMsg};
use futures_util::{SinkExt, StreamExt};
use inotify::{Inotify, WatchMask};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::mpsc;
use tokio::task::{spawn_blocking, JoinHandle};

use crate::auth;
use crate::device::{self, DeviceMonitor};
use crate::host::ProcessHost;
use crate::session::{valid_id, Sessions};

const HEARTBEAT: Duration = Duration::from_secs(15);
const STATUS_EVERY: Duration = Duration::from_secs(5);
const PROBE_EVERY_STATUS: u32 = 2;
const READ_CHUNK: usize = 64 * 1024;
const CHANNEL_FRAMES: usize = 16;

pub struct App {
    pub sessions: Sessions,
    pub host: Box<dyn ProcessHost>,
    pub allowed_users: Vec<String>,
    pub min_available_mb: u64,
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

    let mut readers: HashMap<String, JoinHandle<()>> = HashMap::new();
    while let Some(Ok(message)) = stream.next().await {
        let Message::Text(text) = message else {
            continue;
        };
        let result = match serde_json::from_str::<ClientMsg>(text.as_str()) {
            Ok(msg) => handle(&app, msg, &tx, &mut readers).await,
            Err(error) => Err((None, format!("无法解析消息：{error}"))),
        };
        if let Err((session, message)) = result {
            let frame = Frame {
                session,
                msg: ServerMsg::Error { message },
            };
            if tx.send(frame).await.is_err() {
                break;
            }
        }
    }

    for reader in readers.into_values() {
        reader.abort();
    }
    writer.abort();
}

type HandleError = (Option<String>, String);

async fn handle(
    app: &Arc<App>,
    msg: ClientMsg,
    tx: &mpsc::Sender<Frame>,
    readers: &mut HashMap<String, JoinHandle<()>>,
) -> Result<(), HandleError> {
    let session = match &msg {
        ClientMsg::List => return list(app, tx).await,
        ClientMsg::Start { session, .. }
        | ClientMsg::Attach { session, .. }
        | ClientMsg::Input { session, .. }
        | ClientMsg::Stop { session } => session.clone(),
    };
    if !valid_id(&session) {
        return Err((None, "会话 ID 不合法".to_string()));
    }
    let fail = |error: String| (Some(session.clone()), error);

    match msg {
        ClientMsg::Start {
            resume, cwd, title, ..
        } => {
            let cwd = cwd.map(PathBuf::from);
            if cwd.as_ref().is_some_and(|cwd| !cwd.is_absolute()) {
                return Err(fail("cwd 必须是绝对路径".to_string()));
            }
            if resume.as_deref().is_some_and(|id| !valid_id(id)) {
                return Err(fail("resume ID 不合法".to_string()));
            }
            let id = session.clone();
            blocking(app, move |app| {
                app.sessions.prepare(&id)?;
                if let Some(title) = &title {
                    app.sessions.set_title(&id, title)?;
                }
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
                // 在断开的挂载里启动进程不会报错，只会一直没有输出，所以先探测。
                if let Some(cwd) = &cwd {
                    if !device::probe(cwd) {
                        return Err(std::io::Error::other("设备离线，无法启动会话"));
                    }
                    app.sessions.set_cwd(&id, cwd)?;
                }
                let workdir = app.sessions.cwd(&id).unwrap_or_else(|| dir.clone());
                app.host.start(&id, &dir, &workdir, resume.as_deref())
            })
            .await
            .map_err(fail)?;
        }
        ClientMsg::Attach { after, .. } => {
            if let Some(old) = readers.remove(&session) {
                old.abort();
            }
            let reader = tokio::spawn(follow(app.clone(), session.clone(), after, tx.clone()));
            readers.insert(session.clone(), reader);
        }
        ClientMsg::Input { line, .. } => {
            let id = session.clone();
            blocking(app, move |app| app.sessions.write_line(&id, &line))
                .await
                .map_err(fail)?;
        }
        ClientMsg::List => {}
        ClientMsg::Stop { .. } => {
            let id = session.clone();
            blocking(app, move |app| {
                let result = app.host.stop(&id, &app.sessions.dir(&id));
                app.sessions.release(&id);
                result
            })
            .await
            .map_err(fail)?;
        }
    }
    Ok(())
}

async fn list(app: &Arc<App>, tx: &mpsc::Sender<Frame>) -> Result<(), HandleError> {
    let host = app.clone();
    let sessions =
        spawn_blocking(move || host.sessions.list(|id, dir| host.host.is_running(id, dir)))
            .await
            .map_err(|error| (None, error.to_string()))?;
    let frame = Frame {
        session: None,
        msg: ServerMsg::Sessions {
            sessions,
            mem_available_mb: mem_available_mb(),
        },
    };
    tx.send(frame)
        .await
        .map_err(|_| (None, "连接已关闭".to_string()))
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
    let mut changes = match watch(&path, after).await {
        Ok(changes) => changes,
        Err(message) => {
            let _ = tx.send(frame(ServerMsg::Error { message })).await;
            return;
        }
    };

    let mut splitter = LineSplitter::new(after);
    let mut queue = Outbound::new(OutboundLimits::default());
    let mut buffer = vec![0; READ_CHUNK];
    let mut status = tokio::time::interval(STATUS_EVERY);
    let mut ticks: u32 = 0;
    let mut last_running = None;
    let mut monitor = DeviceMonitor::default();
    let mut probing: Option<JoinHandle<bool>> = None;

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
            result = async { probing.as_mut().expect("条件已保证").await }, if probing.is_some() => {
                probing = None;
                if let Some(online) = monitor.observe(result.unwrap_or(false)) {
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
                if ticks.is_multiple_of(PROBE_EVERY_STATUS) && probing.is_none() {
                    if let Some(cwd) = app.sessions.cwd(&session) {
                        probing = Some(spawn_blocking(move || device::probe(&cwd)));
                    }
                }
                ticks = ticks.wrapping_add(1);
                Ok(())
            }
        };
        if let Err(message) = filled {
            let _ = tx.send(frame(ServerMsg::Error { message })).await;
            return;
        }
    }
}

async fn watch(
    path: &std::path::Path,
    after: u64,
) -> Result<inotify::EventStream<[u8; 1024]>, String> {
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
    inotify.into_event_stream([0; 1024]).map_err(failed)
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
