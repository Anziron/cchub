//! 哪些需要人决定的事件该提醒。
//!
//! 订阅时 `hubd` 先回 `Attached { live }`：偏移小于 `live` 的是日志里已有的历史。历史里的审批
//! 大多早就处理过了，第一次打开一个会话时不能逐条提醒；但断线期间新来、还没人回答的审批必须提醒。
//! 所以历史里的审批先记下，后面出现同一个 `tool_use_id` 的结果、撤销请求或一轮结束（`result`）就划掉，
//! 回放到 `live` 时还剩下的才提醒。旧版 `hubd` 不发 `Attached`，这时每条都当实时处理。

use cchub_protocol::EventClass;
use serde::de::IgnoredAny;
use serde::Deserialize;

/// `(seq, class)`：该提醒的事件。
pub type Alert = (u64, EventClass);

#[derive(Debug, Default)]
pub struct Attention {
    /// 最近一次订阅时的历史边界；`None` 表示 `hubd` 没说（旧版）。
    live: Option<u64>,
    /// 历史里还没看到结果的审批，按偏移排序。
    open: Vec<Open>,
}

#[derive(Debug)]
struct Open {
    seq: u64,
    class: EventClass,
    request_id: Option<String>,
    tool_use_id: Option<String>,
}

impl Attention {
    /// 收到 `Attached`。`expected` 是客户端当前的接收位置。
    pub fn attached(&mut self, live: u64, expected: u64) -> Vec<Alert> {
        self.live = Some(live);
        self.flush_if_live(expected)
    }

    /// 收到一条新事件；`expected` 是处理完这条之后的接收位置。
    pub fn event(
        &mut self,
        seq: u64,
        class: EventClass,
        payload: &str,
        expected: u64,
    ) -> Vec<Alert> {
        let in_history = self.live.is_some_and(|live| seq < live);
        if !in_history {
            return if class.needs_human() {
                vec![(seq, class)]
            } else {
                Vec::new()
            };
        }
        if class.needs_human() {
            let line = parse(payload);
            self.open.push(Open {
                seq,
                class,
                request_id: line.as_ref().and_then(|l| l.request_id.clone()),
                tool_use_id: line.and_then(|l| l.request?.tool_use_id),
            });
        } else if !self.open.is_empty() {
            self.resolve(payload);
        }
        self.flush_if_live(expected)
    }

    /// 接收位置因 `Skipped` 前进了。
    pub fn advanced(&mut self, expected: u64) -> Vec<Alert> {
        self.flush_if_live(expected)
    }

    /// 结果、撤销和一轮结束会让之前的审批作废，和界面上卡片消失的条件一致。
    fn resolve(&mut self, payload: &str) {
        let Some(line) = parse(payload) else { return };
        match line.kind.as_deref() {
            Some("result") => self.open.clear(),
            Some("control_cancel_request") => {
                let id = line.request_id;
                self.open
                    .retain(|open| id.is_none() || open.request_id != id);
            }
            Some("user") => {
                let Some(Content::Parts(parts)) = line.message.and_then(|m| m.content) else {
                    return;
                };
                for part in parts {
                    if part.tool_use_id.is_some() {
                        self.open
                            .retain(|open| open.tool_use_id != part.tool_use_id);
                    }
                }
            }
            _ => {}
        }
    }

    fn flush_if_live(&mut self, expected: u64) -> Vec<Alert> {
        if self.live.is_none_or(|live| expected < live) {
            return Vec::new();
        }
        self.open
            .drain(..)
            .map(|open| (open.seq, open.class))
            .collect()
    }
}

#[derive(Deserialize)]
struct Line {
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    request: Option<Request>,
    #[serde(default)]
    message: Option<Message>,
}

#[derive(Deserialize)]
struct Request {
    #[serde(default)]
    tool_use_id: Option<String>,
}

#[derive(Deserialize)]
struct Message {
    #[serde(default)]
    content: Option<Content>,
}

/// 用户消息的 `content` 可能是字符串，也可能是块数组；只有数组里有工具结果。
#[derive(Deserialize)]
#[serde(untagged)]
enum Content {
    Parts(Vec<Part>),
    Other(#[allow(dead_code)] IgnoredAny),
}

#[derive(Deserialize)]
struct Part {
    #[serde(default)]
    tool_use_id: Option<String>,
}

fn parse(payload: &str) -> Option<Line> {
    serde_json::from_str(payload).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use EventClass::{Approval, Durable, Question};

    const ASK: &str = r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","tool_use_id":"t1"}}"#;
    const ASK2: &str = r#"{"type":"control_request","request_id":"r2","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","tool_use_id":"t2","requires_user_interaction":true}}"#;
    const ANSWERED: &str = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#;
    const CANCELLED: &str = r#"{"type":"control_cancel_request","request_id":"r1"}"#;
    const TURN_END: &str = r#"{"type":"result","subtype":"success"}"#;
    const TEXT: &str =
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}"#;

    #[test]
    fn answered_approvals_in_history_are_not_alerted() {
        let mut a = Attention::default();
        assert_eq!(a.attached(300, 0), vec![]);
        assert_eq!(a.event(0, Approval, ASK, 100), vec![]);
        assert_eq!(a.event(100, Durable, ANSWERED, 200), vec![]);
        assert_eq!(a.event(200, Durable, TEXT, 300), vec![]);
    }

    #[test]
    fn turn_end_or_cancel_voids_history_approvals() {
        let mut a = Attention::default();
        a.attached(300, 0);
        a.event(0, Approval, ASK, 100);
        assert_eq!(a.event(100, Durable, TURN_END, 300), vec![]);

        let mut a = Attention::default();
        a.attached(300, 0);
        a.event(0, Approval, ASK, 100);
        assert_eq!(a.event(100, Durable, CANCELLED, 300), vec![]);
    }

    #[test]
    fn history_approval_still_open_at_the_boundary_is_alerted() {
        // 断线期间来的审批，重新订阅时它在历史里，但还没人回答。
        let mut a = Attention::default();
        a.attached(300, 0);
        assert_eq!(a.event(0, Approval, ASK, 100), vec![]);
        assert_eq!(a.event(100, Question, ASK2, 200), vec![]);
        assert_eq!(
            a.event(200, Durable, ANSWERED, 300),
            vec![(100, Question)],
            "t1 已回答，t2 还在等"
        );
    }

    #[test]
    fn skipped_range_reaching_the_boundary_flushes() {
        let mut a = Attention::default();
        a.attached(300, 0);
        a.event(0, Approval, ASK, 100);
        assert_eq!(a.advanced(200), vec![]);
        assert_eq!(a.advanced(300), vec![(0, Approval)]);
    }

    #[test]
    fn reattach_with_nothing_new_flushes_what_was_open() {
        // 回放到一半断线，重连时日志没有新内容：之前记下的审批仍然没人回答。
        let mut a = Attention::default();
        a.attached(500, 0);
        a.event(0, Approval, ASK, 100);
        assert_eq!(a.attached(100, 100), vec![(0, Approval)]);
    }

    #[test]
    fn live_events_alert_immediately() {
        let mut a = Attention::default();
        a.attached(100, 0);
        a.event(0, Durable, TEXT, 100);
        assert_eq!(a.event(100, Approval, ASK, 200), vec![(100, Approval)]);
        assert_eq!(a.event(200, Durable, TEXT, 300), vec![]);
    }

    #[test]
    fn without_attached_every_event_counts_as_live() {
        // 旧版 hubd。
        let mut a = Attention::default();
        assert_eq!(a.event(0, Approval, ASK, 100), vec![(0, Approval)]);
    }
}
