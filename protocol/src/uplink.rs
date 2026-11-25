//! 上行（界面 → `hubd` → `claude`）的可靠性：客户端记下没收到回执的输入，重连后原样补发；
//! `hubd` 记下最近写入过的 `id`，补发的重复输入只回执、不再写，所以 `hubd` 不重启时每条输入最多写入一次。
//! 这张表在内存里，`hubd` 重启后补发可能再写一次，由 CLI 丢掉重复：用户消息按 uuid，审批回复按
//! `request_id`（实验见设计仓库 `experiments/k2-dup.py`），界面忽略重复的回显。

use std::collections::{HashSet, VecDeque};

use crate::wire::ClientMsg;

/// 客户端：已经发出、还没收到 `Ack` 的输入，按发出顺序排列。
#[derive(Debug, Default)]
pub struct Outbox {
    sent: VecDeque<ClientMsg>,
}

impl Outbox {
    /// 记下一条发出的消息。只记 `Input`，其他消息没有回执。
    pub fn sent(&mut self, msg: &ClientMsg) {
        if matches!(msg, ClientMsg::Input { .. }) {
            self.sent.push_back(msg.clone());
        }
    }

    /// 收到回执，移出这条输入。返回是否是这里等着的。
    pub fn ack(&mut self, session: &str, id: &str) -> bool {
        let found = self.sent.iter().position(|msg| {
            matches!(msg, ClientMsg::Input { session: s, id: i, .. } if s == session && i == id)
        });
        found.and_then(|at| self.sent.remove(at)).is_some()
    }

    /// 重连后要补发的输入，按原来的顺序。补发后仍留着，直到收到回执。
    pub fn unacked(&self) -> impl Iterator<Item = &ClientMsg> {
        self.sent.iter()
    }

    pub fn len(&self) -> usize {
        self.sent.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sent.is_empty()
    }
}

/// `hubd`：每个会话最近写入过的输入 `id`。只记成功写入的，被拒的重发时还能再试。
#[derive(Debug)]
pub struct Dedupe {
    order: VecDeque<String>,
    seen: HashSet<String>,
    capacity: usize,
}

/// 每个会话记住的 `id` 个数。补发只发生在断线重连时，数量远小于这个值。
pub const DEDUPE_IDS: usize = 256;

impl Default for Dedupe {
    fn default() -> Self {
        Self::with_capacity(DEDUPE_IDS)
    }
}

impl Dedupe {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            order: VecDeque::new(),
            seen: HashSet::new(),
            capacity: capacity.max(1),
        }
    }

    pub fn contains(&self, id: &str) -> bool {
        self.seen.contains(id)
    }

    /// 记下一个已写入的 `id`，超过容量时忘掉最早的。
    pub fn insert(&mut self, id: &str) {
        if !self.seen.insert(id.to_string()) {
            return;
        }
        self.order.push_back(id.to_string());
        while self.order.len() > self.capacity {
            if let Some(old) = self.order.pop_front() {
                self.seen.remove(&old);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(session: &str, id: &str) -> ClientMsg {
        ClientMsg::Input {
            session: session.into(),
            id: id.into(),
            line: format!("line-{id}"),
        }
    }

    #[test]
    fn outbox_keeps_unacked_inputs_in_order() {
        let mut outbox = Outbox::default();
        outbox.sent(&input("s", "a"));
        outbox.sent(&ClientMsg::List);
        outbox.sent(&input("s", "b"));
        outbox.sent(&input("t", "c"));
        assert_eq!(outbox.len(), 3, "只记输入");

        assert!(outbox.ack("s", "b"));
        assert!(!outbox.ack("s", "b"), "重复的回执忽略");
        assert!(!outbox.ack("s", "c"), "会话不对不算");
        let left: Vec<_> = outbox.unacked().cloned().collect();
        assert_eq!(left, [input("s", "a"), input("t", "c")]);
    }

    #[test]
    fn dedupe_remembers_recent_ids_only() {
        let mut dedupe = Dedupe::with_capacity(2);
        assert!(!dedupe.contains("a"));
        dedupe.insert("a");
        dedupe.insert("a");
        dedupe.insert("b");
        assert!(dedupe.contains("a") && dedupe.contains("b"));
        dedupe.insert("c");
        assert!(!dedupe.contains("a"), "最早的被淘汰");
        assert!(dedupe.contains("b") && dedupe.contains("c"));
    }
}
