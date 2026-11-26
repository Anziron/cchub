//! 每个会话的订阅：接收位置、提醒、本机缓存和“同步中”。只处理消息，不碰网络（连接循环在 `lib.rs`）。
//!
//! 一次订阅：界面要从头看（`after` 为 0）且本机有缓存时，先把缓存交给界面和提醒，再从缓存末尾向 `hubd` 续订。
//! `hubd` 回的 `Attached` 里日志身份和缓存的一致才接着用；不一致（会话目录被清理后重建、旧版 `hubd` 不报身份）
//! 或日志比已收到的还短，就删掉缓存、让界面清空（`Reset`）、从头重订。核对过以后收到的不可跳过的事件追加进缓存。
//!
//! 发出订阅后、收到它的 `Attached` 之前到的事件，属于同一连接上之前的跟读（`hubd` 每次订阅都先发 `Attached`，
//! 9da0edf 起就这样，早于协议 1），丢掉：它们没核对过身份，不能进缓存，也不能拿来判断提醒。
//! 追上 `Attached` 的 `live` 时发一次 `Synced`，界面据此解锁审批卡片。

use std::collections::{HashMap, HashSet};

use cchub_protocol::{
    ClientMsg, EventClass, Inbound, InboundAction, ServerMsg, SessionInfo, UiEvent,
};

use crate::attention::Attention;
use crate::cache::ServerCache;

#[derive(Default)]
pub(crate) struct Subs {
    subs: HashMap<String, Sub>,
    /// 这个服务器的本机缓存；为空时和没有缓存之前的行为完全一样。
    cache: Option<ServerCache>,
}

struct Sub {
    inbound: Inbound,
    alerts: Attention,
    /// 偏移属于哪一份日志：来自缓存，或这次订阅的第一个 `Attached`；旧版 `hubd` 不报时为空。
    origin: Option<String>,
    /// 发出订阅、还没收到它的 `Attached`。
    awaiting: bool,
    /// 因为偏移超出日志末尾而从头重订：`hubd` 紧接着会为上一次订阅报一条错，不转给界面。
    swallow_error: bool,
    /// 最近一次 `Attached` 的 `live`；追上后发 `Synced` 并清空。
    live: Option<u64>,
    /// 自动订阅、界面还没要的会话：事件只用来提醒，不进界面。
    watched: bool,
}

impl Sub {
    fn new(after: u64, watched: bool) -> Self {
        Self {
            inbound: Inbound::new(after),
            alerts: Attention::default(),
            origin: None,
            awaiting: true,
            swallow_error: false,
            live: None,
            watched,
        }
    }
}

impl Subs {
    pub(crate) fn new(cache: Option<ServerCache>) -> Self {
        Self {
            subs: HashMap::new(),
            cache,
        }
    }

    pub(crate) fn contains(&self, session: &str) -> bool {
        self.subs.contains_key(session)
    }

    /// 新订阅一个会话（界面要的，或手机端自动订阅的），返回要发给 `hubd` 的订阅。
    /// 从头订阅且有缓存时，缓存先交给界面（`watched` 时不交）和提醒，再从缓存末尾续订。
    pub(crate) fn subscribe(
        &mut self,
        session: &str,
        after: u64,
        watched: bool,
        on_event: &impl Fn(UiEvent),
        on_attention: &impl Fn(&str, u64, EventClass),
    ) -> ClientMsg {
        let mut sub = Sub::new(after, watched);
        if let (Some(cache), 0) = (&self.cache, after) {
            if let Some(opened) = cache.open(session) {
                // 历史边界先报缓存末尾，hubd 回了再报真的。
                if !watched {
                    on_event(UiEvent::Attached {
                        session: session.to_string(),
                        live: opened.end,
                    });
                }
                sub.alerts = Attention::from_cache();
                let end = cache.replay(session, &opened, |record| {
                    let alerts =
                        sub.alerts
                            .event(record.seq, record.class, record.payload, record.next);
                    for (seq, class) in alerts {
                        on_attention(session, seq, class);
                    }
                    if !watched {
                        on_event(UiEvent::Event {
                            session: session.to_string(),
                            class: record.class,
                            seq: record.seq,
                            payload: record.payload.to_string(),
                        });
                    }
                });
                sub.inbound = Inbound::new(end);
                sub.origin = Some(opened.origin);
            }
        }
        let after = sub.inbound.expected();
        self.subs.insert(session.to_string(), sub);
        ClientMsg::Attach {
            session: session.to_string(),
            after,
        }
    }

    /// 重连：每个会话从已收到的位置续订。
    pub(crate) fn reattach_all(&mut self) -> Vec<ClientMsg> {
        self.subs
            .iter_mut()
            .map(|(session, sub)| {
                sub.awaiting = true;
                sub.swallow_error = false;
                ClientMsg::Attach {
                    session: session.clone(),
                    after: sub.inbound.expected(),
                }
            })
            .collect()
    }

    /// `hubd` 回了 `Attached`。接不上时返回从头重订的消息。
    pub(crate) fn attached(
        &mut self,
        session: &str,
        live: u64,
        origin: Option<String>,
        on_event: &impl Fn(UiEvent),
        on_attention: &impl Fn(&str, u64, EventClass),
    ) -> Vec<ClientMsg> {
        let Some(sub) = self.subs.get_mut(session) else {
            return Vec::new();
        };
        let expected = sub.inbound.expected();
        let same_log = sub.origin.is_none() || sub.origin == origin;
        if live < expected || !same_log {
            return vec![self.reset(session, live < expected, on_event)];
        }
        sub.awaiting = false;
        if sub.origin.is_none() && origin.is_some() {
            // 从头订阅、第一次知道日志身份：从这里开始建缓存。中途才知道的接不上，不建。
            if let (Some(cache), Some(origin), 0) = (&self.cache, &origin, expected) {
                cache.create(session, origin);
            }
            sub.origin = origin;
        }
        sub.live = Some(live);
        if !sub.watched {
            on_event(UiEvent::Attached {
                session: session.to_string(),
                live,
            });
        }
        for (seq, class) in sub.alerts.attached(live, expected) {
            on_attention(session, seq, class);
        }
        caught_up(session, sub, on_event);
        Vec::new()
    }

    /// 已显示的内容接不上 `hubd` 的日志：删缓存、让界面清空、从头重订。
    fn reset(&mut self, session: &str, beyond_end: bool, on_event: &impl Fn(UiEvent)) -> ClientMsg {
        if let Some(cache) = &self.cache {
            cache.remove(session);
        }
        let watched = self.subs.get(session).is_some_and(|sub| sub.watched);
        if !watched {
            on_event(UiEvent::Reset {
                session: session.to_string(),
            });
        }
        let mut sub = Sub::new(0, watched);
        // 偏移超出日志末尾时，hubd 在 `Attached` 后面还会报一条“日志已被清理”。
        sub.swallow_error = beyond_end;
        self.subs.insert(session.to_string(), sub);
        ClientMsg::Attach {
            session: session.to_string(),
            after: 0,
        }
    }

    /// 收到 `Event` / `Skipped`。发现缺口时返回续订的消息。
    pub(crate) fn stream(
        &mut self,
        session: &str,
        msg: ServerMsg,
        on_event: &impl Fn(UiEvent),
        on_attention: &impl Fn(&str, u64, EventClass),
    ) -> Vec<ClientMsg> {
        let Some(sub) = self.subs.get_mut(session) else {
            return Vec::new();
        };
        if sub.awaiting {
            return Vec::new();
        }
        let from = sub.inbound.expected();
        let Some(action) = sub.inbound.on_message(msg) else {
            return Vec::new();
        };
        let expected = sub.inbound.expected();
        match action {
            InboundAction::Apply {
                class,
                seq,
                payload,
            } => {
                if let Some(cache) = &self.cache {
                    cache.push(session, seq, expected, class, &payload);
                }
                for (seq, class) in sub.alerts.event(seq, class, &payload, expected) {
                    on_attention(session, seq, class);
                }
                if !sub.watched {
                    on_event(UiEvent::Event {
                        session: session.to_string(),
                        class,
                        seq,
                        payload,
                    });
                }
            }
            InboundAction::Skipped => {
                if let Some(cache) = &self.cache {
                    cache.skip(session, from, expected);
                }
                for (seq, class) in sub.alerts.advanced(expected) {
                    on_attention(session, seq, class);
                }
            }
            InboundAction::Resync { after } => {
                sub.awaiting = true;
                return vec![ClientMsg::Attach {
                    session: session.to_string(),
                    after,
                }];
            }
            InboundAction::Duplicate => {}
        }
        caught_up(session, sub, on_event);
        Vec::new()
    }

    /// 这条会话的错误不转给界面：从头重订之前那次订阅的“日志已被清理”。只吞一条。
    pub(crate) fn swallow_error(&mut self, session: &str) -> bool {
        self.subs
            .get_mut(session)
            .is_some_and(|sub| std::mem::take(&mut sub.swallow_error))
    }

    /// 收到完整的会话列表：服务器已经清理掉的会话，本机缓存也删掉。
    /// 空列表不动：服务器读目录失败时也会是空的，缓存删了只能重下。
    pub(crate) fn listed(&self, sessions: &[SessionInfo]) {
        let Some(cache) = &self.cache else {
            return;
        };
        if sessions.is_empty() {
            return;
        }
        let ids: HashSet<&str> = sessions.iter().map(|s| s.id.as_str()).collect();
        cache.retain(|id| ids.contains(id));
    }

    /// 收完一批消息后把缓存落盘。
    pub(crate) fn flush(&self) {
        if let Some(cache) = &self.cache {
            cache.flush();
        }
    }
}

/// 追上了 `Attached` 时的日志长度：发一次 `Synced`。
fn caught_up(session: &str, sub: &mut Sub, on_event: &impl Fn(UiEvent)) {
    if sub.live.is_some_and(|live| sub.inbound.expected() >= live) {
        sub.live = None;
        if !sub.watched {
            on_event(UiEvent::Synced {
                session: session.to_string(),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::Cache;
    use std::cell::RefCell;
    use std::path::PathBuf;
    use EventClass::{Approval, Durable};

    const URL: &str = "ws://hub:7878/ws";
    const ASK: &str = r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_use_id":"t1"}}"#;
    const ANSWERED: &str =
        r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1"}]}}"#;

    struct Temp(PathBuf);

    impl Temp {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("cchub-subs-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        /// 重启后的新实例，指向同一个目录。
        fn cache(&self) -> ServerCache {
            Cache::new(self.0.clone()).server(URL)
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 发给界面的事件（简写）和提醒。
    #[derive(Default)]
    struct Seen {
        ui: RefCell<Vec<String>>,
        alerts: RefCell<Vec<(u64, EventClass)>>,
    }

    impl Seen {
        fn ui(&self) -> impl Fn(UiEvent) + '_ {
            move |event| {
                let brief = match event {
                    UiEvent::Attached { live, .. } => format!("attached {live}"),
                    UiEvent::Event { seq, payload, .. } => format!("event {seq} {payload}"),
                    UiEvent::Synced { .. } => "synced".to_string(),
                    UiEvent::Reset { .. } => "reset".to_string(),
                    other => format!("{other:?}"),
                };
                self.ui.borrow_mut().push(brief);
            }
        }

        fn alert(&self) -> impl Fn(&str, u64, EventClass) + '_ {
            move |_, seq, class| self.alerts.borrow_mut().push((seq, class))
        }

        fn take(&self) -> Vec<String> {
            self.ui.take()
        }
    }

    fn event(seq: u64, next: u64, payload: &str) -> ServerMsg {
        ServerMsg::Event {
            seq,
            next,
            class: cchub_protocol::classify(payload),
            payload: payload.into(),
        }
    }

    fn attach(after: u64) -> ClientMsg {
        ClientMsg::Attach {
            session: "s1".into(),
            after,
        }
    }

    /// 本机缓存里有 s1 的两条事件：0..5 first，5..9 second，属于身份为 `origin` 的日志。
    fn cached(temp: &Temp, origin: &str) {
        let cache = temp.cache();
        cache.create("s1", origin);
        cache.push("s1", 0, 5, Durable, "first");
        cache.push("s1", 5, 9, Durable, "second");
        cache.flush();
    }

    /// 缓存里有哪些事件（另开一个实例读，像重启后一样）。
    fn cached_rows(temp: &Temp) -> Option<(String, Vec<String>)> {
        let cache = temp.cache();
        let opened = cache.open("s1")?;
        let mut rows = Vec::new();
        cache.replay("s1", &opened, |r| {
            rows.push(format!("{} {}", r.seq, r.payload))
        });
        Some((opened.origin, rows))
    }

    #[test]
    fn cached_session_shows_before_hubd_answers_and_resumes_from_its_end() {
        let temp = Temp::new("hit");
        cached(&temp, "o1");
        let seen = Seen::default();
        let (ui, alert) = (seen.ui(), seen.alert());
        let mut subs = Subs::new(Some(temp.cache()));

        assert_eq!(subs.subscribe("s1", 0, false, &ui, &alert), attach(9));
        assert_eq!(
            seen.take(),
            ["attached 9", "event 0 first", "event 5 second"]
        );

        assert!(subs
            .attached("s1", 12, Some("o1".into()), &ui, &alert)
            .is_empty());
        assert!(subs
            .stream("s1", event(9, 12, "third"), &ui, &alert)
            .is_empty());
        assert_eq!(seen.take(), ["attached 12", "event 9 third", "synced"]);

        subs.flush();
        let rows = vec!["0 first".to_string(), "5 second".into(), "9 third".into()];
        assert_eq!(cached_rows(&temp), Some(("o1".to_string(), rows)));
    }

    #[test]
    fn cache_of_a_rebuilt_log_is_dropped_and_the_session_restarts_from_zero() {
        let temp = Temp::new("rebuilt");
        cached(&temp, "old");
        let seen = Seen::default();
        let (ui, alert) = (seen.ui(), seen.alert());
        let mut subs = Subs::new(Some(temp.cache()));
        subs.subscribe("s1", 0, false, &ui, &alert);
        seen.take();

        let again = subs.attached("s1", 20, Some("new".into()), &ui, &alert);
        assert_eq!(again, [attach(0)]);
        assert_eq!(seen.take(), ["reset"]);
        assert_eq!(cached_rows(&temp), None);

        subs.attached("s1", 4, Some("new".into()), &ui, &alert);
        subs.stream("s1", event(0, 4, "fresh"), &ui, &alert);
        assert_eq!(seen.take(), ["attached 4", "event 0 fresh", "synced"]);
        subs.flush();
        let rows = vec!["0 fresh".to_string()];
        assert_eq!(cached_rows(&temp), Some(("new".to_string(), rows)));
    }

    #[test]
    fn old_hubd_without_origin_drops_the_cache_once_and_writes_none() {
        let temp = Temp::new("old-hubd");
        cached(&temp, "o1");
        let seen = Seen::default();
        let (ui, alert) = (seen.ui(), seen.alert());
        let mut subs = Subs::new(Some(temp.cache()));
        subs.subscribe("s1", 0, false, &ui, &alert);
        seen.take();

        assert_eq!(subs.attached("s1", 9, None, &ui, &alert), [attach(0)]);
        assert!(subs.attached("s1", 9, None, &ui, &alert).is_empty());
        subs.stream("s1", event(0, 5, "first"), &ui, &alert);
        subs.stream("s1", event(5, 9, "second"), &ui, &alert);
        assert_eq!(
            seen.take(),
            [
                "reset",
                "attached 9",
                "event 0 first",
                "event 5 second",
                "synced"
            ]
        );
        subs.flush();
        assert_eq!(cached_rows(&temp), None);
    }

    #[test]
    fn log_shorter_than_received_restarts_from_zero_without_showing_the_error() {
        let temp = Temp::new("shorter");
        cached(&temp, "o1");
        let seen = Seen::default();
        let (ui, alert) = (seen.ui(), seen.alert());
        let mut subs = Subs::new(Some(temp.cache()));
        subs.subscribe("s1", 0, false, &ui, &alert);
        seen.take();

        // hubd 的日志只有 3 字节，比缓存的 9 短：先回 Attached，再报“日志已被清理”。
        assert_eq!(
            subs.attached("s1", 3, Some("o1".into()), &ui, &alert),
            [attach(0)]
        );
        assert_eq!(seen.take(), ["reset"]);
        assert!(subs.swallow_error("s1"), "紧跟着的那条错误不转给界面");
        assert!(!subs.swallow_error("s1"), "只吞一条");
    }

    #[test]
    fn synced_is_sent_once_when_history_is_caught_up() {
        let seen = Seen::default();
        let (ui, alert) = (seen.ui(), seen.alert());
        let mut subs = Subs::new(None);
        assert_eq!(subs.subscribe("s1", 0, false, &ui, &alert), attach(0));
        subs.attached("s1", 9, Some("o1".into()), &ui, &alert);
        subs.stream("s1", event(0, 5, "first"), &ui, &alert);
        subs.stream("s1", event(5, 9, "second"), &ui, &alert);
        subs.stream("s1", event(9, 12, "live"), &ui, &alert);
        assert_eq!(
            seen.take(),
            [
                "attached 9",
                "event 0 first",
                "event 5 second",
                "synced",
                "event 9 live"
            ]
        );

        // 日志是空的：一订阅就追上了。
        subs.subscribe("s2", 0, false, &ui, &alert);
        subs.attached("s2", 0, Some("o2".into()), &ui, &alert);
        assert_eq!(seen.take(), ["attached 0", "synced"]);
    }

    #[test]
    fn events_before_attached_belong_to_the_previous_follow_and_are_dropped() {
        let temp = Temp::new("stale");
        let seen = Seen::default();
        let (ui, alert) = (seen.ui(), seen.alert());
        let mut subs = Subs::new(Some(temp.cache()));
        subs.subscribe("s1", 0, false, &ui, &alert);
        assert!(subs
            .stream("s1", event(0, 5, "stale"), &ui, &alert)
            .is_empty());
        assert_eq!(seen.take(), Vec::<String>::new());

        subs.attached("s1", 5, Some("o1".into()), &ui, &alert);
        subs.stream("s1", event(0, 5, "first"), &ui, &alert);
        assert_eq!(seen.take(), ["attached 5", "event 0 first", "synced"]);
        subs.flush();
        let rows = vec!["0 first".to_string()];
        assert_eq!(cached_rows(&temp), Some(("o1".to_string(), rows)));
    }

    #[test]
    fn reconnect_resumes_from_the_received_position() {
        let seen = Seen::default();
        let (ui, alert) = (seen.ui(), seen.alert());
        let mut subs = Subs::new(None);
        subs.subscribe("s1", 0, false, &ui, &alert);
        subs.attached("s1", 5, Some("o1".into()), &ui, &alert);
        subs.stream("s1", event(0, 5, "first"), &ui, &alert);
        seen.take();

        assert_eq!(subs.reattach_all(), [attach(5)]);
        subs.attached("s1", 9, Some("o1".into()), &ui, &alert);
        subs.stream("s1", event(5, 9, "second"), &ui, &alert);
        assert_eq!(seen.take(), ["attached 9", "event 5 second", "synced"]);
    }

    #[test]
    fn pruned_sessions_lose_their_cache_when_the_list_arrives() {
        let temp = Temp::new("listed");
        let cache = temp.cache();
        for session in ["s1", "s2"] {
            cache.create(session, "o1");
            cache.push(session, 0, 5, Durable, "first");
        }
        cache.flush();
        let info = |id: &str| SessionInfo {
            id: id.into(),
            title: None,
            cwd: None,
            running: false,
            updated: None,
            archived: false,
            active: None,
        };
        let subs = Subs::new(Some(temp.cache()));
        // 空列表可能是服务器读目录失败，不动。
        subs.listed(&[]);
        assert!(temp.cache().open("s2").is_some());
        subs.listed(&[info("s1")]);
        assert!(temp.cache().open("s1").is_some());
        assert!(temp.cache().open("s2").is_none());
    }

    #[test]
    fn approval_left_open_in_the_cache_alerts_only_if_still_open_on_hubd() {
        let temp = Temp::new("alerts");
        let cache = temp.cache();
        cache.create("s1", "o1");
        cache.push("s1", 0, 10, Approval, ASK);
        cache.flush();
        let seen = Seen::default();
        let (ui, alert) = (seen.ui(), seen.alert());

        // 服务器上没有新内容：仍在等人回答。
        let mut subs = Subs::new(Some(temp.cache()));
        subs.subscribe("s1", 0, false, &ui, &alert);
        assert_eq!(seen.alerts.take(), [], "回放缓存时不提醒");
        subs.attached("s1", 10, Some("o1".into()), &ui, &alert);
        assert_eq!(seen.alerts.take(), [(0, Approval)]);

        // 关着的时候在别处回答了：hubd 补来的历史里有结果，不提醒。
        let mut subs = Subs::new(Some(temp.cache()));
        subs.subscribe("s1", 0, false, &ui, &alert);
        subs.attached("s1", 20, Some("o1".into()), &ui, &alert);
        subs.stream("s1", event(10, 20, ANSWERED), &ui, &alert);
        assert_eq!(seen.alerts.take(), []);
    }

    #[test]
    fn watched_sessions_use_the_cache_for_alerts_only() {
        let temp = Temp::new("watched");
        let cache = temp.cache();
        cache.create("s1", "o1");
        cache.push("s1", 0, 10, Approval, ASK);
        cache.flush();
        let seen = Seen::default();
        let (ui, alert) = (seen.ui(), seen.alert());
        let mut subs = Subs::new(Some(temp.cache()));

        assert_eq!(subs.subscribe("s1", 0, true, &ui, &alert), attach(10));
        subs.attached("s1", 10, Some("o1".into()), &ui, &alert);
        assert_eq!(seen.take(), Vec::<String>::new(), "界面没要，不发给界面");
        assert_eq!(seen.alerts.take(), [(0, Approval)]);
    }
}
