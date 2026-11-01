//! 同步核心：服务端的发送队列和客户端的接收状态。

use std::collections::VecDeque;

use crate::envelope::{classify, EventClass};
use crate::wire::ServerMsg;

/// 把文件里读到的字节切成完整的行。最后没有换行的半行留到下次，进程崩溃时不会传出半条事件。
#[derive(Debug)]
pub struct LineSplitter {
    pending: Vec<u8>,
    pending_start: u64,
}

impl LineSplitter {
    pub fn new(offset: u64) -> Self {
        Self {
            pending: Vec::new(),
            pending_start: offset,
        }
    }

    /// 下一次应该从文件的哪个偏移接着读。
    pub fn read_offset(&self) -> u64 {
        self.pending_start + self.pending.len() as u64
    }

    /// 返回 `(seq, next, 行内容)`，内容不含换行。
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<(u64, u64, String)> {
        self.pending.extend_from_slice(bytes);
        let mut lines = Vec::new();
        let mut consumed = 0;
        while let Some(pos) = self.pending[consumed..].iter().position(|b| *b == b'\n') {
            let end = consumed + pos;
            let seq = self.pending_start + consumed as u64;
            let next = self.pending_start + end as u64 + 1;
            let line = String::from_utf8_lossy(&self.pending[consumed..end]);
            lines.push((seq, next, line.trim_end_matches('\r').to_string()));
            consumed = end + 1;
        }
        self.pending.drain(..consumed);
        self.pending_start += consumed as u64;
        lines
    }
}

#[derive(Debug, Clone, Copy)]
pub struct OutboundLimits {
    /// 排队的逐字片段超过这个字节数就跳过。
    pub max_partial_bytes: usize,
    /// 排队内容超过这个字节数就暂停读文件。不能丢的事件靠这个限制内存，而不是丢弃。
    pub max_queued_bytes: usize,
}

impl Default for OutboundLimits {
    fn default() -> Self {
        Self {
            max_partial_bytes: 64 * 1024,
            max_queued_bytes: 2 * 1024 * 1024,
        }
    }
}

/// 单个连接的发送队列。积压时把逐字片段合并成 `Skipped`，其他事件不丢。
#[derive(Debug)]
pub struct Outbound {
    limits: OutboundLimits,
    queue: VecDeque<ServerMsg>,
    queued_bytes: usize,
    partial_bytes: usize,
}

impl Outbound {
    pub fn new(limits: OutboundLimits) -> Self {
        Self {
            limits,
            queue: VecDeque::new(),
            queued_bytes: 0,
            partial_bytes: 0,
        }
    }

    /// 为假时调用方应暂停读文件，等队列发出去一部分。
    pub fn wants_more(&self) -> bool {
        self.queued_bytes < self.limits.max_queued_bytes
    }

    pub fn push(&mut self, seq: u64, next: u64, line: String) {
        let class = classify(&line);
        self.queued_bytes += line.len();
        if class == EventClass::Partial {
            self.partial_bytes += line.len();
        }
        self.queue.push_back(ServerMsg::Event {
            seq,
            next,
            class,
            payload: line,
        });
        if self.partial_bytes > self.limits.max_partial_bytes {
            self.skip_partials();
        }
    }

    pub fn pop(&mut self) -> Option<ServerMsg> {
        let msg = self.queue.pop_front()?;
        if let ServerMsg::Event { class, payload, .. } = &msg {
            self.queued_bytes -= payload.len();
            if *class == EventClass::Partial {
                self.partial_bytes -= payload.len();
            }
        }
        Some(msg)
    }

    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }

    fn skip_partials(&mut self) {
        let mut kept: VecDeque<ServerMsg> = VecDeque::with_capacity(self.queue.len());
        for msg in self.queue.drain(..) {
            match msg {
                ServerMsg::Event {
                    seq,
                    next,
                    class: EventClass::Partial,
                    payload,
                } => {
                    self.queued_bytes -= payload.len();
                    match kept.back_mut() {
                        Some(ServerMsg::Skipped { next: end, .. }) if *end == seq => *end = next,
                        _ => kept.push_back(ServerMsg::Skipped { seq, next }),
                    }
                }
                other => kept.push_back(other),
            }
        }
        self.queue = kept;
        self.partial_bytes = 0;
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum InboundAction {
    /// 新事件，交给界面。
    Apply {
        class: EventClass,
        seq: u64,
        payload: String,
    },
    /// 已知区间被跳过，界面什么都不用做。
    Skipped,
    /// 收到过的重复内容，忽略。
    Duplicate,
    /// 发现缺口，要从这个偏移重新订阅。
    Resync { after: u64 },
}

/// 客户端的接收状态。只要 `expected` 连续推进，就能证明没有缺一段。
#[derive(Debug)]
pub struct Inbound {
    expected: u64,
}

impl Inbound {
    pub fn new(after: u64) -> Self {
        Self { expected: after }
    }

    /// 重连时用这个偏移重新订阅。
    pub fn expected(&self) -> u64 {
        self.expected
    }

    /// 只接收 `Event` 和 `Skipped`；其他消息与序号无关，返回 `None`。
    pub fn on_message(&mut self, msg: ServerMsg) -> Option<InboundAction> {
        match msg {
            ServerMsg::Event {
                seq,
                next,
                class,
                payload,
            } => Some(self.advance(seq, next).unwrap_or(InboundAction::Apply {
                class,
                seq,
                payload,
            })),
            ServerMsg::Skipped { seq, next } => {
                Some(self.advance(seq, next).unwrap_or(InboundAction::Skipped))
            }
            ServerMsg::Status { .. }
            | ServerMsg::Device { .. }
            | ServerMsg::Sessions { .. }
            | ServerMsg::Browse { .. }
            | ServerMsg::Mounted { .. }
            | ServerMsg::TaskOutput { .. }
            | ServerMsg::Error { .. } => None,
        }
    }

    fn advance(&mut self, seq: u64, next: u64) -> Option<InboundAction> {
        if seq > self.expected {
            return Some(InboundAction::Resync {
                after: self.expected,
            });
        }
        if next <= self.expected {
            return Some(InboundAction::Duplicate);
        }
        if seq < self.expected {
            return Some(InboundAction::Resync {
                after: self.expected,
            });
        }
        self.expected = next;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splitter_keeps_half_line_until_newline_arrives() {
        let mut splitter = LineSplitter::new(10);
        assert_eq!(splitter.feed(b"ab\ncd"), vec![(10, 13, "ab".to_string())]);
        assert_eq!(splitter.read_offset(), 15);
        assert_eq!(splitter.feed(b"e\n"), vec![(13, 17, "cde".to_string())]);
        assert_eq!(splitter.read_offset(), 17);
    }

    #[test]
    fn splitter_counts_bytes_for_multibyte_text() {
        let mut splitter = LineSplitter::new(0);
        let lines = splitter.feed("你好\nx\n".as_bytes());
        assert_eq!(lines[0], (0, 7, "你好".to_string()));
        assert_eq!(lines[1], (7, 9, "x".to_string()));
    }

    #[test]
    fn partials_are_merged_into_one_skip_when_over_limit() {
        let mut out = Outbound::new(OutboundLimits {
            max_partial_bytes: 10,
            max_queued_bytes: 1000,
        });
        let partial = r#"{"type":"stream_event"}"#;
        let durable = r#"{"type":"assistant"}"#;
        out.push(0, 5, partial.to_string());
        out.push(5, 9, durable.to_string());
        out.push(9, 14, partial.to_string());

        assert_eq!(out.pop(), Some(ServerMsg::Skipped { seq: 0, next: 5 }));
        assert!(matches!(
            out.pop(),
            Some(ServerMsg::Event {
                class: EventClass::Durable,
                ..
            })
        ));
        assert_eq!(out.pop(), Some(ServerMsg::Skipped { seq: 9, next: 14 }));
        assert!(out.is_empty());
    }

    #[test]
    fn durable_events_stop_reading_instead_of_being_dropped() {
        let mut out = Outbound::new(OutboundLimits {
            max_partial_bytes: 10,
            max_queued_bytes: 30,
        });
        let durable = r#"{"type":"assistant"}"#;
        out.push(0, 21, durable.to_string());
        assert!(out.wants_more());
        out.push(21, 42, durable.to_string());
        assert!(!out.wants_more());
        assert!(out.pop().is_some());
        assert!(out.wants_more());
    }

    #[test]
    fn inbound_requests_resync_on_gap_and_ignores_duplicates() {
        let mut inbound = Inbound::new(0);
        let event = |seq, next| ServerMsg::Event {
            seq,
            next,
            class: EventClass::Durable,
            payload: String::new(),
        };
        assert!(matches!(
            inbound.on_message(event(0, 5)),
            Some(InboundAction::Apply { .. })
        ));
        assert_eq!(
            inbound.on_message(event(9, 12)),
            Some(InboundAction::Resync { after: 5 })
        );
        assert_eq!(
            inbound.on_message(event(0, 5)),
            Some(InboundAction::Duplicate)
        );
        assert_eq!(inbound.expected(), 5);
    }
}
