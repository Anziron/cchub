//! WebSocket 连接：每个订阅的会话一个读日志任务，经有界通道汇到一个发送任务。

use std::collections::HashMap;
use std::io::SeekFrom;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::http::{header::ORIGIN, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use cchub_protocol::{ClientMsg, Frame, LineSplitter, Outbound, OutboundLimits, ServerMsg};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::mpsc;
use tokio::task::{spawn_blocking, JoinHandle};

use crate::host::ProcessHost;
use crate::session::{valid_id, Sessions};

const HEARTBEAT: Duration = Duration::from_secs(15);
const POLL: Duration = Duration::from_millis(100);
const STATUS_EVERY_POLLS: u32 = 50;
const READ_CHUNK: usize = 64 * 1024;
const CHANNEL_FRAMES: usize = 16;

pub struct App {
    pub sessions: Sessions,
    pub host: Box<dyn ProcessHost>,
}

pub async fn upgrade(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    // 桌面端的连接在 Rust 进程里，不带 Origin。带 Origin 的只可能来自网页，一律拒绝，
    // 否则设备上任何网页都能连上来，在服务器上执行命令。
    if headers.contains_key(ORIGIN) {
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
        ClientMsg::Start { resume, .. } => {
            if resume.as_deref().is_some_and(|id| !valid_id(id)) {
                return Err(fail("resume ID 不合法".to_string()));
            }
            let id = session.clone();
            blocking(app, move |app| {
                app.sessions.prepare(&id)?;
                let dir = app.sessions.dir(&id);
                if app.host.is_running(&id, &dir) {
                    return Ok(());
                }
                app.host.start(&id, &dir, resume.as_deref())
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
async fn follow(app: Arc<App>, session: String, after: u64, tx: mpsc::Sender<Frame>) {
    let frame = |msg| Frame {
        session: Some(session.clone()),
        msg,
    };
    let path = app.sessions.out_path(&session);
    let mut splitter = LineSplitter::new(after);
    let mut queue = Outbound::new(OutboundLimits::default());
    let mut buffer = vec![0; READ_CHUNK];
    let mut tick = tokio::time::interval(POLL);
    let mut polls = 0;
    let mut last_running = None;

    loop {
        tokio::select! {
            permit = tx.reserve(), if !queue.is_empty() => {
                let Ok(permit) = permit else { return };
                if let Some(msg) = queue.pop() {
                    permit.send(frame(msg));
                }
            }
            _ = tick.tick() => {
                while queue.wants_more() {
                    let read = read_at(&path, splitter.read_offset(), &mut buffer).await;
                    let count = match read {
                        Ok(0) => break,
                        Ok(count) => count,
                        Err(error) => {
                            let _ = tx.send(frame(ServerMsg::Error { message: format!("读取日志失败：{error}") })).await;
                            return;
                        }
                    };
                    for (seq, next, line) in splitter.feed(&buffer[..count]) {
                        queue.push(seq, next, line);
                    }
                }

                if polls % STATUS_EVERY_POLLS == 0 {
                    let (app, id) = (app.clone(), session.clone());
                    let running = spawn_blocking(move || app.host.is_running(&id, &app.sessions.dir(&id)))
                        .await
                        .unwrap_or(false);
                    if last_running != Some(running) {
                        last_running = Some(running);
                        if tx.send(frame(ServerMsg::Status { running })).await.is_err() {
                            return;
                        }
                    }
                }
                polls = polls.wrapping_add(1);
            }
        }
    }
}

async fn read_at(path: &std::path::Path, offset: u64, buffer: &mut [u8]) -> std::io::Result<usize> {
    let mut file = tokio::fs::File::open(path).await?;
    file.seek(SeekFrom::Start(offset)).await?;
    file.read(buffer).await
}
