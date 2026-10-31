//! 只解析事件信封，不解析正文。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum EventClass {
    /// 逐字片段等过程信息，积压时可以跳过。
    Partial,
    /// 不能丢。不认识的事件也归到这里，CLI 新增类型时只会多传，不会丢。
    Durable,
    /// 普通审批。
    Approval,
    /// 要人回答：提问、方案确认。
    Question,
}

impl EventClass {
    pub fn needs_human(self) -> bool {
        matches!(self, Self::Approval | Self::Question)
    }
}

#[derive(Deserialize)]
struct Envelope<'a> {
    #[serde(rename = "type", borrow, default)]
    kind: Option<&'a str>,
    #[serde(borrow, default)]
    subtype: Option<&'a str>,
    #[serde(borrow, default)]
    request: Option<Request<'a>>,
}

#[derive(Deserialize)]
struct Request<'a> {
    #[serde(borrow, default)]
    subtype: Option<&'a str>,
    #[serde(default)]
    requires_user_interaction: bool,
}

pub fn classify(line: &str) -> EventClass {
    let Ok(envelope) = serde_json::from_str::<Envelope>(line) else {
        return EventClass::Durable;
    };
    match (envelope.kind, envelope.subtype, envelope.request) {
        (Some("stream_event"), _, _) | (Some("system"), Some("thinking_tokens"), _) => {
            EventClass::Partial
        }
        (Some("control_request"), _, Some(request)) if request.subtype == Some("can_use_tool") => {
            if request.requires_user_interaction {
                EventClass::Question
            } else {
                EventClass::Approval
            }
        }
        _ => EventClass::Durable,
    }
}

/// 用户消息。设备离线时先暂存；审批回复等控制消息不算，要照常送达。
pub fn is_user_message(line: &str) -> bool {
    serde_json::from_str::<Envelope>(line).is_ok_and(|envelope| envelope.kind == Some("user"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_by_envelope() {
        let cases = [
            (r#"{"type":"stream_event","event":{}}"#, EventClass::Partial),
            (
                r#"{"type":"system","subtype":"thinking_tokens"}"#,
                EventClass::Partial,
            ),
            (r#"{"type":"system","subtype":"init"}"#, EventClass::Durable),
            (r#"{"type":"assistant"}"#, EventClass::Durable),
            (r#"{"type":"result"}"#, EventClass::Durable),
            (r#"{"type":"brand_new_event"}"#, EventClass::Durable),
            ("not json", EventClass::Durable),
            (
                r#"{"type":"control_request","request":{"subtype":"can_use_tool","tool_name":"Bash"}}"#,
                EventClass::Approval,
            ),
            (
                r#"{"type":"control_request","request":{"subtype":"can_use_tool","requires_user_interaction":true}}"#,
                EventClass::Question,
            ),
            (
                r#"{"type":"control_request","request":{"subtype":"something_new"}}"#,
                EventClass::Durable,
            ),
        ];
        for (line, expected) in cases {
            assert_eq!(classify(line), expected, "{line}");
        }
    }

    #[test]
    fn recognizes_user_messages() {
        assert!(is_user_message(r#"{"type":"user","message":{}}"#));
        assert!(!is_user_message(r#"{"type":"control_response"}"#));
        assert!(!is_user_message("not json"));
    }

    #[test]
    fn escaped_envelope_strings_are_decoded() {
        assert_eq!(classify(r#"{"type":"stream_event"}"#), EventClass::Partial);
        assert_eq!(
            classify(r#"{"type":"control_request","request":{"subtype":"can_use_tool"}}"#),
            EventClass::Approval
        );
    }
}
