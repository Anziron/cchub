//! 桌面端的连接逻辑，放在 Rust 进程里，窗口关闭后也能维持连接和通知。
//! 不依赖 Tauri，所以 Linux 上也能测试。

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::time::Duration;

use cchub_protocol::{
    is_user_message, ClientMsg, ConnectionState, EventClass, Frame, Inbound, InboundAction,
    ServerMsg, SessionInfo, UiEvent,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::time::Instant;
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
        (
            Self { tx },
            run(url, backoff, None, rx, on_event, |_, _, _| {}),
        )
    }

    /// 界面可能不在时用：定时取会话列表，自己订阅运行中的会话，这样别处新开的会话也能发通知。
    /// `hubd` 不主动推送列表，所以只能取。这些事件交给 `on_watched`，不进界面；
    /// 界面之后自己订阅时会从头重放，不会显示两遍。
    pub fn watching(
        url: String,
        backoff: Duration,
        interval: Duration,
        on_event: impl Fn(UiEvent) + Send + Sync + 'static,
        on_watched: impl Fn(&str, u64, EventClass) + Send + Sync + 'static,
    ) -> (Self, impl Future<Output = ()> + Send) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Self { tx },
            run(url, backoff, Some(interval), rx, on_event, on_watched),
        )
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
    watch: Option<Duration>,
    mut rx: mpsc::UnboundedReceiver<ClientMsg>,
    on_event: impl Fn(UiEvent),
    on_watched: impl Fn(&str, u64, EventClass),
) {
    let mut state = State {
        watch,
        ..State::default()
    };
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
            match connected(socket, &mut rx, &mut state, &on_event, &on_watched).await {
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
                    Some(msg) => state.pending.push(msg),
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
    state: &mut State,
    on_event: &impl Fn(UiEvent),
    on_watched: &impl Fn(&str, u64, EventClass),
) -> Ended
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + SinkExt<Message>
        + Unpin,
{
    for (session, inbound) in state.sessions.iter() {
        let attach = ClientMsg::Attach {
            session: session.clone(),
            after: inbound.expected(),
        };
        if send(&mut socket, &attach).await.is_err() {
            return Ended::Lost;
        }
    }
    while !state.pending.is_empty() {
        let msg = state.pending[0].clone();
        if state.deliver(&mut socket, msg).await.is_err() {
            return Ended::Lost;
        }
        state.pending.remove(0);
    }

    let mut ticker = state.watch.map(|period| {
        let mut ticker = tokio::time::interval(period);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        ticker
    });
    // 按截止时间算，不能每轮重新计时：定时发送的消息会让断线一直检测不出来。
    let mut deadline = Instant::now() + IDLE_TIMEOUT;

    loop {
        tokio::select! {
            _ = async { ticker.as_mut().expect("前置条件已检查").tick().await }, if ticker.is_some() => {
                if send(&mut socket, &ClientMsg::List).await.is_err() {
                    return Ended::Lost;
                }
            }
            msg = rx.recv() => {
                let Some(msg) = msg else { return Ended::Closed };
                if state.deliver(&mut socket, msg.clone()).await.is_err() {
                    state.pending.push(msg);
                    return Ended::Lost;
                }
            }
            // hubd 约 15 秒发一次心跳，这么久没有任何数据就当断线。
            incoming = tokio::time::timeout_at(deadline, socket.next()) => {
                let Ok(Some(Ok(message))) = incoming else { return Ended::Lost };
                deadline = Instant::now() + IDLE_TIMEOUT;
                let Message::Text(text) = message else { continue };
                let Ok(frame) = serde_json::from_str::<Frame>(text.as_str()) else { continue };
                for msg in state.on_frame(frame, on_event, on_watched) {
                    if send(&mut socket, &msg).await.is_err() {
                        state.pending.push(msg);
                        return Ended::Lost;
                    }
                }
            }
        }
    }
}

#[derive(Default)]
struct State {
    sessions: HashMap<String, Inbound>,
    /// 断线期间的消息，重连后再发。
    pending: Vec<ClientMsg>,
    offline: HashSet<String>,
    /// 设备离线期间的用户消息，恢复后再发。
    held: Vec<ClientMsg>,
    /// 取会话列表的间隔，`None` 表示订阅全由界面决定。
    watch: Option<Duration>,
    /// 自动订阅、界面还没要的会话。
    watched: HashSet<String>,
}

impl State {
    async fn deliver<S: SinkExt<Message> + Unpin>(
        &mut self,
        socket: &mut S,
        msg: ClientMsg,
    ) -> Result<(), ()> {
        if let ClientMsg::Attach { session, after } = &msg {
            // 窗口重建后要从头重放，所以这里按调用方给的偏移重置。
            // 重连和缺口补齐走 `send`，不经过这里，用的是 `Inbound` 记录的偏移。
            self.sessions.insert(session.clone(), Inbound::new(*after));
            self.watched.remove(session);
        }
        if let ClientMsg::Input { session, line } = &msg {
            if self.offline.contains(session) && is_user_message(line) {
                self.held.push(msg);
                return Ok(());
            }
        }
        send(socket, &msg).await
    }

    /// 返回要发回服务器的消息。
    fn on_frame(
        &mut self,
        frame: Frame,
        on_event: &impl Fn(UiEvent),
        on_watched: &impl Fn(&str, u64, EventClass),
    ) -> Vec<ClientMsg> {
        let session = frame.session;
        match frame.msg {
            ServerMsg::Status { running } => {
                if let Some(session) = session {
                    on_event(UiEvent::Status { session, running });
                }
                Vec::new()
            }
            ServerMsg::Device { online } => {
                let Some(session) = session else {
                    return Vec::new();
                };
                on_event(UiEvent::Device {
                    session: session.clone(),
                    online,
                });
                if !online {
                    self.offline.insert(session);
                    return Vec::new();
                }
                self.offline.remove(&session);
                let (ready, held) = std::mem::take(&mut self.held).into_iter().partition(
                    |msg| matches!(msg, ClientMsg::Input { session: id, .. } if *id == session),
                );
                self.held = held;
                ready
            }
            ServerMsg::Sessions {
                sessions,
                mem_available_mb,
            } => {
                let attach = self.watch_running(&sessions);
                on_event(UiEvent::Sessions {
                    sessions,
                    mem_available_mb,
                });
                attach
            }
            ServerMsg::Browse {
                device,
                path,
                parent,
                entries,
                error,
            } => {
                on_event(UiEvent::Browse {
                    device,
                    path,
                    parent,
                    entries,
                    error,
                });
                Vec::new()
            }
            ServerMsg::Mounted {
                device,
                path,
                cwd,
                error,
            } => {
                on_event(UiEvent::Mounted {
                    device,
                    path,
                    cwd,
                    error,
                });
                Vec::new()
            }
            ServerMsg::TaskOutput { path, text, error } => {
                on_event(UiEvent::TaskOutput { path, text, error });
                Vec::new()
            }
            ServerMsg::Error { message } => {
                on_event(UiEvent::Error { session, message });
                Vec::new()
            }
            msg => {
                let Some(id) = session else {
                    return Vec::new();
                };
                let Some(action) = self.sessions.get_mut(&id).and_then(|i| i.on_message(msg))
                else {
                    return Vec::new();
                };
                match action {
                    InboundAction::Apply {
                        class,
                        seq,
                        payload,
                    } => {
                        if self.watched.contains(&id) {
                            on_watched(&id, seq, class);
                            return Vec::new();
                        }
                        on_event(UiEvent::Event {
                            session: id,
                            class,
                            seq,
                            payload,
                        });
                        Vec::new()
                    }
                    InboundAction::Resync { after } => {
                        vec![ClientMsg::Attach { session: id, after }]
                    }
                    InboundAction::Skipped | InboundAction::Duplicate => Vec::new(),
                }
            }
        }
    }
}

impl State {
    /// 运行中但还没人订阅的会话，返回要发的订阅消息。
    fn watch_running(&mut self, sessions: &[SessionInfo]) -> Vec<ClientMsg> {
        if self.watch.is_none() {
            return Vec::new();
        }
        let mut attach = Vec::new();
        for session in sessions {
            if session.running && !self.sessions.contains_key(&session.id) {
                self.sessions.insert(session.id.clone(), Inbound::new(0));
                self.watched.insert(session.id.clone());
                attach.push(ClientMsg::Attach {
                    session: session.id.clone(),
                    after: 0,
                });
            }
        }
        attach
    }
}

/// 决定哪些待决定事件要发系统通知。窗口重建后事件会从头重放，靠水位保证每条只通知一次。
#[derive(Default, Serialize, Deserialize)]
pub struct Notifier {
    marks: HashMap<String, u64>,
}

impl Notifier {
    /// 返回是否该通知。水位变了就要由调用方保存。
    pub fn observe(&mut self, session: &str, seq: u64, class: EventClass) -> bool {
        if !class.needs_human() || self.marks.get(session).is_some_and(|mark| seq < *mark) {
            return false;
        }
        self.marks.insert(session.to_string(), seq + 1);
        true
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

    #[test]
    fn notifier_fires_once_per_event_even_after_replay() {
        let mut notifier = Notifier::default();
        assert!(!notifier.observe("s", 0, EventClass::Durable));
        assert!(notifier.observe("s", 10, EventClass::Approval));
        assert!(!notifier.observe("s", 10, EventClass::Approval));
        assert!(notifier.observe("s", 20, EventClass::Question));
        assert!(!notifier.observe("s", 10, EventClass::Approval));
        assert!(notifier.observe("other", 10, EventClass::Approval));

        let saved = serde_json::to_string(&notifier).unwrap();
        let mut restored: Notifier = serde_json::from_str(&saved).unwrap();
        assert!(!restored.observe("s", 20, EventClass::Question));
    }

    #[tokio::test]
    async fn attach_from_zero_replays_for_a_rebuilt_window() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let (events_tx, mut events) = mpsc::unbounded_channel();
        let (client, task) = HubClient::new(url, Duration::from_millis(10), move |event| {
            let _ = events_tx.send(event);
        });
        tokio::spawn(task);
        let attach = ClientMsg::Attach {
            session: "s1".into(),
            after: 0,
        };
        client.send(attach.clone()).unwrap();
        let (stream, _) = listener.accept().await.unwrap();
        let mut server = accept_async(stream).await.unwrap();
        next_client_msg(&mut server).await;

        let mut next_payload = async || loop {
            let received = tokio::time::timeout(Duration::from_secs(5), events.recv());
            if let UiEvent::Event { payload, .. } = received.await.unwrap().unwrap() {
                return payload;
            }
        };
        let first = Message::Text(event(0, 5, "first").into());
        server.send(first.clone()).await.unwrap();
        assert_eq!(next_payload().await, "first");

        // 窗口重建：再次从 0 订阅，同一条事件不能被当成重复丢掉。
        client.send(attach).unwrap();
        next_client_msg(&mut server).await;
        server.send(first).await.unwrap();
        assert_eq!(next_payload().await, "first");
    }

    #[tokio::test]
    async fn watching_attaches_running_sessions_without_touching_the_ui() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let (events_tx, mut events) = mpsc::unbounded_channel();
        let (watched_tx, mut watched) = mpsc::unbounded_channel();
        let (client, task) = HubClient::watching(
            url,
            Duration::from_millis(10),
            Duration::from_secs(3600),
            move |event| {
                let _ = events_tx.send(event);
            },
            move |session, seq, class| {
                let _ = watched_tx.send((session.to_string(), seq, class));
            },
        );
        tokio::spawn(task);
        let (stream, _) = listener.accept().await.unwrap();
        let mut server = accept_async(stream).await.unwrap();
        assert_eq!(next_client_msg(&mut server).await, ClientMsg::List);

        let info = |id: &str, running| SessionInfo {
            id: id.into(),
            title: None,
            cwd: None,
            running,
            updated: None,
            archived: false,
            active: None,
        };
        let list = Frame {
            session: None,
            msg: ServerMsg::Sessions {
                sessions: vec![info("s1", true), info("ended", false)],
                mem_available_mb: None,
            },
        };
        let list = Message::Text(serde_json::to_string(&list).unwrap().into());
        server.send(list.clone()).await.unwrap();
        let attach = ClientMsg::Attach {
            session: "s1".into(),
            after: 0,
        };
        // 只订阅运行中的，已结束的不订阅。
        assert_eq!(next_client_msg(&mut server).await, attach);

        let first = Message::Text(event(0, 5, "first").into());
        server.send(first.clone()).await.unwrap();
        let received = tokio::time::timeout(Duration::from_secs(5), watched.recv());
        assert_eq!(
            received.await.unwrap().unwrap(),
            ("s1".to_string(), 0, EventClass::Durable)
        );

        // 同一个会话不重复订阅：下一条客户端消息是界面发的，不是自动的。
        server.send(list).await.unwrap();
        client.send(attach.clone()).unwrap();
        assert_eq!(next_client_msg(&mut server).await, attach);

        // 界面订阅后，事件改走界面，从头重放。
        server.send(first).await.unwrap();
        loop {
            let received = tokio::time::timeout(Duration::from_secs(5), events.recv());
            if let UiEvent::Event { payload, .. } = received.await.unwrap().unwrap() {
                assert_eq!(payload, "first");
                break;
            }
        }
        assert!(watched.try_recv().is_err());
    }

    #[tokio::test]
    async fn holds_user_messages_while_device_is_offline() {
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
        let (stream, _) = listener.accept().await.unwrap();
        let mut server = accept_async(stream).await.unwrap();
        next_client_msg(&mut server).await;

        let device = |online| {
            serde_json::to_string(&Frame {
                session: Some("s1".into()),
                msg: ServerMsg::Device { online },
            })
            .unwrap()
        };
        let mut wait_device = async |expected: bool| loop {
            let received = tokio::time::timeout(Duration::from_secs(5), events.recv());
            if let UiEvent::Device { online, .. } = received.await.unwrap().unwrap() {
                assert_eq!(online, expected);
                return;
            }
        };
        server
            .send(Message::Text(device(false).into()))
            .await
            .unwrap();
        wait_device(false).await;

        let input = |line: &str| ClientMsg::Input {
            session: "s1".into(),
            line: line.into(),
        };
        let user = r#"{"type":"user"}"#;
        let reply = r#"{"type":"control_response"}"#;
        client.send(input(user)).unwrap();
        client.send(input(reply)).unwrap();

        // 审批回复照常送达，用户消息先留着。
        assert_eq!(next_client_msg(&mut server).await, input(reply));
        server
            .send(Message::Text(device(true).into()))
            .await
            .unwrap();
        wait_device(true).await;
        assert_eq!(next_client_msg(&mut server).await, input(user));
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
