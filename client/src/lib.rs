//! 桌面端的连接逻辑，放在 Rust 进程里，窗口关闭后也能维持连接和通知。
//! 不依赖 Tauri，所以 Linux 上也能测试。

use std::collections::HashMap;
use std::future::Future;
use std::time::Duration;

use cchub_protocol::{
    ClientMsg, ConnectionState, Frame, Inbound, InboundAction, ServerMsg, UiEvent,
};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};

const IDLE_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct HubClient {
    tx: mpsc::UnboundedSender<ClientMsg>,
}

impl HubClient {
    /// 返回句柄和要交给运行时执行的连接循环。循环一直运行到所有句柄都被丢弃。
    pub fn new(
        url: String,
        backoff: Duration,
        on_event: impl Fn(UiEvent) + Send + Sync + 'static,
    ) -> (Self, impl Future<Output = ()> + Send) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Self { tx }, run(url, backoff, rx, on_event))
    }

    pub fn send(&self, msg: ClientMsg) -> Result<(), String> {
        self.tx.send(msg).map_err(|_| "连接已关闭".to_string())
    }
}

enum Ended {
    Lost,
    Closed,
}

async fn run(
    url: String,
    initial_backoff: Duration,
    mut rx: mpsc::UnboundedReceiver<ClientMsg>,
    on_event: impl Fn(UiEvent),
) {
    let mut sessions: HashMap<String, Inbound> = HashMap::new();
    let mut pending: Vec<ClientMsg> = Vec::new();
    let mut backoff = initial_backoff;

    loop {
        on_event(UiEvent::Connection {
            state: ConnectionState::Connecting,
        });
        if let Ok((socket, _)) = connect_async(url.as_str()).await {
            backoff = initial_backoff;
            on_event(UiEvent::Connection {
                state: ConnectionState::Connected,
            });
            match connected(socket, &mut rx, &mut sessions, &mut pending, &on_event).await {
                Ended::Closed => return,
                Ended::Lost => {}
            }
        }
        on_event(UiEvent::Connection {
            state: ConnectionState::Disconnected,
        });

        // 断线期间用户发的消息先留着，重连后再发。
        let wait = tokio::time::sleep(backoff);
        tokio::pin!(wait);
        loop {
            tokio::select! {
                _ = &mut wait => break,
                msg = rx.recv() => match msg {
                    Some(msg) => pending.push(msg),
                    None => return,
                },
            }
        }
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

async fn connected<S>(
    mut socket: S,
    rx: &mut mpsc::UnboundedReceiver<ClientMsg>,
    sessions: &mut HashMap<String, Inbound>,
    pending: &mut Vec<ClientMsg>,
    on_event: &impl Fn(UiEvent),
) -> Ended
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + SinkExt<Message>
        + Unpin,
{
    for (session, inbound) in sessions.iter() {
        let attach = ClientMsg::Attach {
            session: session.clone(),
            after: inbound.expected(),
        };
        if send(&mut socket, &attach).await.is_err() {
            return Ended::Lost;
        }
    }
    while !pending.is_empty() {
        let msg = pending[0].clone();
        track_attach(&msg, sessions);
        if send(&mut socket, &msg).await.is_err() {
            return Ended::Lost;
        }
        pending.remove(0);
    }

    loop {
        tokio::select! {
            msg = rx.recv() => {
                let Some(msg) = msg else { return Ended::Closed };
                track_attach(&msg, sessions);
                if send(&mut socket, &msg).await.is_err() {
                    pending.push(msg);
                    return Ended::Lost;
                }
            }
            // hubd 约 15 秒发一次心跳，这么久没有任何数据就当断线。
            incoming = tokio::time::timeout(IDLE_TIMEOUT, socket.next()) => {
                let Ok(Some(Ok(message))) = incoming else { return Ended::Lost };
                let Message::Text(text) = message else { continue };
                let Ok(frame) = serde_json::from_str::<Frame>(text.as_str()) else { continue };
                if let Some(attach) = on_frame(frame, sessions, on_event) {
                    if send(&mut socket, &attach).await.is_err() {
                        return Ended::Lost;
                    }
                }
            }
        }
    }
}

/// 第一次订阅某个会话时建立接收状态；已有状态时以它记录的偏移为准。
fn track_attach(msg: &ClientMsg, sessions: &mut HashMap<String, Inbound>) {
    if let ClientMsg::Attach { session, after } = msg {
        sessions
            .entry(session.clone())
            .or_insert_with(|| Inbound::new(*after));
    }
}

fn on_frame(
    frame: Frame,
    sessions: &mut HashMap<String, Inbound>,
    on_event: &impl Fn(UiEvent),
) -> Option<ClientMsg> {
    let session = frame.session;
    match frame.msg {
        ServerMsg::Status { running } => {
            on_event(UiEvent::Status {
                session: session?,
                running,
            });
            None
        }
        ServerMsg::Error { message } => {
            on_event(UiEvent::Error { session, message });
            None
        }
        msg => {
            let id = session?;
            match sessions.get_mut(&id)?.on_message(msg)? {
                InboundAction::Apply {
                    class,
                    seq,
                    payload,
                } => {
                    on_event(UiEvent::Event {
                        session: id,
                        class,
                        seq,
                        payload,
                    });
                    None
                }
                InboundAction::Resync { after } => Some(ClientMsg::Attach { session: id, after }),
                InboundAction::Skipped | InboundAction::Duplicate => None,
            }
        }
    }
}

async fn send<S: SinkExt<Message> + Unpin>(socket: &mut S, msg: &ClientMsg) -> Result<(), ()> {
    let text = serde_json::to_string(msg).map_err(|_| ())?;
    socket
        .send(Message::Text(text.into()))
        .await
        .map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cchub_protocol::EventClass;
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;

    fn event(seq: u64, next: u64, payload: &str) -> String {
        serde_json::to_string(&Frame {
            session: Some("s1".into()),
            msg: ServerMsg::Event {
                seq,
                next,
                class: EventClass::Durable,
                payload: payload.into(),
            },
        })
        .unwrap()
    }

    async fn next_client_msg<S>(socket: &mut S) -> ClientMsg
    where
        S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
    {
        loop {
            if let Message::Text(text) = socket.next().await.unwrap().unwrap() {
                return serde_json::from_str(text.as_str()).unwrap();
            }
        }
    }

    #[tokio::test]
    async fn reattaches_after_gap_and_after_reconnect() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let (events_tx, mut events) = mpsc::unbounded_channel();
        let (client, task) = HubClient::new(url, Duration::from_millis(10), move |event| {
            let _ = events_tx.send(event);
        });
        tokio::spawn(task);
        client
            .send(ClientMsg::Attach {
                session: "s1".into(),
                after: 0,
            })
            .unwrap();

        let mut next_payload = async || loop {
            let received = tokio::time::timeout(Duration::from_secs(5), events.recv());
            if let UiEvent::Event { payload, .. } = received.await.unwrap().unwrap() {
                return payload;
            }
        };

        // 第一条连接：发一条，再发一条有缺口的，客户端要从缺口处重新订阅。
        let (stream, _) = listener.accept().await.unwrap();
        let mut server = accept_async(stream).await.unwrap();
        assert!(matches!(
            next_client_msg(&mut server).await,
            ClientMsg::Attach { after: 0, .. }
        ));
        server
            .send(Message::Text(event(0, 5, "first").into()))
            .await
            .unwrap();
        assert_eq!(next_payload().await, "first");
        server
            .send(Message::Text(event(9, 12, "gap").into()))
            .await
            .unwrap();
        assert!(matches!(
            next_client_msg(&mut server).await,
            ClientMsg::Attach { after: 5, .. }
        ));
        drop(server);

        // 断线重连：不用调用方操作，自动从收到的位置接着订阅。
        let (stream, _) = listener.accept().await.unwrap();
        let mut server = accept_async(stream).await.unwrap();
        assert!(matches!(
            next_client_msg(&mut server).await,
            ClientMsg::Attach { after: 5, .. }
        ));
        server
            .send(Message::Text(event(5, 9, "second").into()))
            .await
            .unwrap();
        assert_eq!(next_payload().await, "second");
    }
}
