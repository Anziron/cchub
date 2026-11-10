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

/// 一条助手消息或一轮回复已经完整落盘：此前排队的逐字片段不会再被用到。
pub fn is_message_end(line: &str) -> bool {
    serde_json::from_str::<Envelope>(line)
        .is_ok_and(|envelope| matches!(envelope.kind, Some("assistant" | "result")))
}

/// 对话本身的一行（`user` / `assistant`），其余是 CLI 的内部记录。
pub fn is_conversation_line(line: &str) -> bool {
    serde_json::from_str::<Envelope>(line)
        .is_ok_and(|envelope| matches!(envelope.kind, Some("user" | "assistant")))
}

#[derive(Deserialize)]
struct TaskList {
    #[serde(default)]
    tasks: Vec<serde::de::IgnoredAny>,
}

/// 日志末尾这一轮已经结束，且没有后台任务在跑：结束进程不会打断任何事。
///
/// 从后往前扫：在 `assistant` / `control_request` 之前先遇到 `result` 才算结束；
/// 最近一条 `background_tasks_changed` 是后台任务的完整快照，必须为空，没出现视为没有。
/// 用户输入和 `set_model` 的回显是 `user`，不影响判定。
pub fn turn_finished(log: &str) -> bool {
    let mut ended = false;
    let mut tasks_known = false;
    for line in log.lines().rev() {
        let Ok(envelope) = serde_json::from_str::<Envelope>(line) else {
            continue;
        };
        match (envelope.kind, envelope.subtype) {
            (Some("system"), Some("background_tasks_changed")) if !tasks_known => {
                tasks_known = true;
                let empty =
                    serde_json::from_str::<TaskList>(line).is_ok_and(|list| list.tasks.is_empty());
                if !empty {
                    return false;
                }
            }
            (Some("assistant" | "control_request"), _) if !ended => return false,
            (Some("result"), _) => ended = true,
            _ => {}
        }
        if ended && tasks_known {
            return true;
        }
    }
    ended
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
    fn recognizes_message_ends() {
        assert!(is_message_end(r#"{"type":"assistant","message":{}}"#));
        assert!(is_message_end(r#"{"type":"result"}"#));
        assert!(!is_message_end(r#"{"type":"stream_event"}"#));
        assert!(!is_message_end(r#"{"type":"user"}"#));
        assert!(!is_message_end("not json"));
    }

    #[test]
    fn escaped_envelope_strings_are_decoded() {
        assert_eq!(classify(r#"{"type":"stream_event"}"#), EventClass::Partial);
        assert_eq!(
            classify(r#"{"type":"control_request","request":{"subtype":"can_use_tool"}}"#),
            EventClass::Approval
        );
    }

    #[test]
    fn conversation_lines_are_user_and_assistant() {
        assert!(is_conversation_line(r#"{"type":"user","message":{}}"#));
        assert!(is_conversation_line(r#"{"type":"assistant","message":{}}"#));
        assert!(!is_conversation_line(r#"{"type":"api-request-blob"}"#));
        assert!(!is_conversation_line(r#"{"type":"attachment"}"#));
        assert!(!is_conversation_line(r#"{"type":"user""#));
    }

    #[test]
    fn turn_finished_only_after_result_without_background_tasks() {
        let user = r#"{"type":"user","message":{}}"#;
        let assistant = r#"{"type":"assistant","message":{}}"#;
        let result = r#"{"type":"result","subtype":"success"}"#;
        let ask = r#"{"type":"control_request","request":{"subtype":"can_use_tool"}}"#;
        let none = r#"{"type":"system","subtype":"background_tasks_changed","tasks":[]}"#;
        let some =
            r#"{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"b1"}]}"#;
        let set_model = r#"{"type":"user","message":{"content":"<local-command-stdout>Set model to x</local-command-stdout>"}}"#;
        let log = |lines: &[&str]| lines.join("\n");

        assert!(!turn_finished(""));
        assert!(!turn_finished(&log(&[user, assistant])), "回复中");
        assert!(!turn_finished(&log(&[user, assistant, ask])), "等审批");
        assert!(turn_finished(&log(&[user, assistant, result])));
        assert!(
            turn_finished(&log(&[user, assistant, result, "{\"type\":\"res"])),
            "末尾半行"
        );
        assert!(turn_finished(&log(&[result, set_model])), "set_model 回显");
        assert!(!turn_finished(&log(&[result, user, assistant])), "新一轮");
        assert!(
            !turn_finished(&log(&[user, some, assistant, result])),
            "后台任务未完"
        );
        assert!(turn_finished(&log(&[
            some, assistant, result, none, user, assistant, result
        ])));
        assert!(
            !turn_finished(&log(&[none, assistant, result, some])),
            "结束后又转入后台"
        );
    }
}
