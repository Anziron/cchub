//! 确定性模拟：服务端和客户端之间的链路会丢消息、重复投递、断线（旧连接上的消息可能晚到），
//! 服务端也会重启；故障期间日志继续增长，每次订阅都像 hubd 一样把订阅时已有的内容当回放。
//!
//! 不变量：跳过的区间是整行，而且只有逐字片段；发来的事件和文件里那一行一致；故障结束后客户端
//! 走到文件末尾，不能丢的事件一条不少、顺序不变。哪些行能跳过由生成器自己记着，不用 `classify`
//! 判断，所以把不能丢的类型错标成可跳也会被抓到。
//! 失败时 proptest 打印缩小后的输入（各行类型、故障序列、分块大小、队列上限），并记进
//! `proptest-regressions/`，下次运行先重放它；也可以照着写成单独的测试。

use cchub_protocol::{Inbound, InboundAction, LineSplitter, Outbound, OutboundLimits, ServerMsg};
use proptest::prelude::*;

const PARTIAL: &str = r#"{"type":"stream_event","event":"xxxxxxxxxxxxxxxx"}"#;

/// 第 `index` 行的内容和能不能跳过：逐字片段能跳；完整消息、审批请求、CLI 新加的类型不能丢。
fn line(kind: u8, index: usize) -> (String, bool) {
    match kind % 8 {
        0..=3 => (PARTIAL.to_string(), true),
        4 | 5 => (format!(r#"{{"type":"assistant","index":{index}}}"#), false),
        6 => (
            format!(
                r#"{{"type":"control_request","request":{{"subtype":"can_use_tool"}},"index":{index}}}"#
            ),
            false,
        ),
        _ => (format!(r#"{{"type":"brand_new","index":{index}}}"#), false),
    }
}

#[derive(Debug, Clone)]
enum Fault {
    Deliver,
    /// 丢掉下一条消息。
    Drop,
    /// 下一条消息送到两次。
    Duplicate,
    /// 断线重连：服务端队列作废，客户端从自己的偏移重新订阅；旧连接上还在路上的一条消息可能晚到。
    Reconnect,
    /// 旧连接晚到的那条消息现在才送到（顺序乱了）。
    Late,
    /// `hubd` 重启：内存状态全丢，只剩文件。
    RestartServer,
    /// claude 又往日志里写了一些字节（可能停在一行中间）。
    Write(u8),
}

fn fault() -> impl Strategy<Value = Fault> {
    prop_oneof![
        8 => Just(Fault::Deliver),
        2 => Just(Fault::Drop),
        1 => Just(Fault::Duplicate),
        1 => Just(Fault::Reconnect),
        1 => Just(Fault::Late),
        1 => Just(Fault::RestartServer),
        4 => any::<u8>().prop_map(Fault::Write),
    ]
}

struct Server {
    splitter: LineSplitter,
    queue: Outbound,
}

impl Server {
    /// 像 hubd 的 `follow`：从 `after` 开始读，订阅时文件里已有的内容（到 `live` 为止）是回放。
    fn attach(after: u64, limits: OutboundLimits, live: u64) -> Self {
        let mut queue = Outbound::new(limits);
        queue.set_replay_until(live);
        Self {
            splitter: LineSplitter::new(after),
            queue,
        }
    }

    /// 像真实的读循环一样，分块读文件里已写的部分（前 `written` 字节），队列满了就暂停。
    fn pump(&mut self, log: &[u8], written: usize, chunk: usize) {
        while self.queue.wants_more() {
            let start = self.splitter.read_offset() as usize;
            if start >= written {
                return;
            }
            let end = (start + chunk).min(written);
            for (seq, next, text) in self.splitter.feed(&log[start..end]) {
                self.queue.push(seq, next, text);
            }
        }
    }
}

struct Sim {
    log: Vec<u8>,
    /// 每行的 `[开始, 结束)`（结束含换行）和能不能跳过。
    spans: Vec<(u64, u64, bool)>,
    /// 文件现在写到了哪里。
    written: usize,
    chunk: usize,
    limits: OutboundLimits,
    server: Server,
    /// 旧连接上还在路上的一条消息。
    late: Option<ServerMsg>,
    client: Inbound,
    applied: Vec<String>,
}

impl Sim {
    fn attach(&mut self) {
        self.server = Server::attach(self.client.expected(), self.limits, self.written as u64);
    }

    fn pump(&mut self) {
        self.server.pump(&self.log, self.written, self.chunk);
    }

    fn deliver(&mut self, msg: ServerMsg) -> Result<(), TestCaseError> {
        match &msg {
            ServerMsg::Skipped { seq, next } => {
                let inside: Vec<_> = self
                    .spans
                    .iter()
                    .filter(|(start, end, _)| start >= seq && end <= next)
                    .collect();
                let covered: u64 = inside.iter().map(|(start, end, _)| end - start).sum();
                prop_assert_eq!(covered, next - seq, "跳过区间 [{}, {}) 不是整行", seq, next);
                prop_assert!(
                    inside.iter().all(|(_, _, skippable)| *skippable),
                    "跳过区间 [{}, {}) 里有不能丢的事件",
                    seq,
                    next
                );
            }
            ServerMsg::Event {
                seq, next, payload, ..
            } => {
                let text = String::from_utf8_lossy(&self.log[*seq as usize..*next as usize - 1]);
                prop_assert_eq!(
                    text.as_ref(),
                    payload.as_str(),
                    "事件 [{}, {}) 和文件里的那一行不一样",
                    seq,
                    next
                );
            }
            _ => {}
        }
        match self.client.on_message(msg) {
            Some(InboundAction::Apply { payload, .. }) => self.applied.push(payload),
            Some(InboundAction::Resync { .. }) => self.attach(),
            _ => {}
        }
        Ok(())
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(400))]

    #[test]
    fn nothing_durable_is_lost_under_faults(
        kinds in proptest::collection::vec(any::<u8>(), 1..200),
        initial in 0usize..400,
        faults in proptest::collection::vec(fault(), 1..400),
        chunk in 1usize..200,
        max_partial_bytes in 1usize..500,
        max_queued_bytes in 1usize..4000,
    ) {
        let lines: Vec<(String, bool)> = kinds.iter().enumerate().map(|(i, k)| line(*k, i)).collect();
        let mut log = Vec::new();
        let mut spans = Vec::new();
        for (text, skippable) in &lines {
            let start = log.len() as u64;
            log.extend_from_slice(text.as_bytes());
            log.push(b'\n');
            spans.push((start, log.len() as u64, *skippable));
        }
        let limits = OutboundLimits { max_partial_bytes, max_queued_bytes };
        let written = initial.min(log.len());
        let mut sim = Sim {
            server: Server::attach(0, limits, written as u64),
            log,
            spans,
            written,
            chunk,
            limits,
            late: None,
            client: Inbound::new(0),
            applied: Vec::new(),
        };

        for fault in faults {
            sim.pump();
            match fault {
                Fault::Deliver => {
                    if let Some(msg) = sim.server.queue.pop() {
                        sim.deliver(msg)?;
                    }
                }
                Fault::Drop => {
                    sim.server.queue.pop();
                }
                Fault::Duplicate => {
                    if let Some(msg) = sim.server.queue.pop() {
                        sim.deliver(msg.clone())?;
                        sim.deliver(msg)?;
                    }
                }
                Fault::Reconnect => {
                    let in_flight = sim.server.queue.pop();
                    sim.late = in_flight.or(sim.late.take());
                    sim.attach();
                }
                Fault::Late => {
                    if let Some(msg) = sim.late.take() {
                        sim.deliver(msg)?;
                    }
                }
                Fault::RestartServer => {
                    sim.late = None;
                    sim.attach();
                }
                Fault::Write(bytes) => {
                    sim.written = (sim.written + 1 + usize::from(bytes) % 120).min(sim.log.len());
                }
            }
        }

        // 故障结束后 claude 写完、链路恢复：客户端最终必须走到文件末尾。
        sim.written = sim.log.len();
        let mut steps = 0;
        while sim.client.expected() < sim.log.len() as u64 {
            sim.pump();
            match sim.server.queue.pop() {
                Some(msg) => sim.deliver(msg)?,
                None => sim.attach(),
            }
            steps += 1;
            prop_assert!(steps < 100_000, "没有收敛");
        }

        let expected: Vec<&String> = lines.iter().filter(|(_, skippable)| !skippable).map(|(text, _)| text).collect();
        let got: Vec<&String> = sim.applied.iter().filter(|text| text.as_str() != PARTIAL).collect();
        prop_assert_eq!(got, expected);
    }
}

/// 回放：已写完整的消息的片段被跳过，边界前未写完的片段保留，不能丢的事件一条不少，
/// 边界之后的实时事件不受影响。
#[test]
fn replay_skips_finished_message_partials_and_keeps_everything_else() {
    let stream = |index: usize| format!(r#"{{"type":"stream_event","index":{index}}}"#);
    let assistant = |index: usize| format!(r#"{{"type":"assistant","index":{index}}}"#);
    let history = vec![
        stream(0),
        stream(1),
        assistant(2),
        r#"{"type":"brand_new"}"#.to_string(),
        stream(4),
        r#"{"type":"result"}"#.to_string(),
        stream(6),
        stream(7),
    ];
    let live = vec![stream(8), assistant(9), stream(10)];
    let bytes = |lines: &[String]| -> Vec<u8> {
        lines
            .iter()
            .flat_map(|l| format!("{l}\n").into_bytes())
            .collect()
    };
    let replay_len = bytes(&history).len() as u64;
    let all: Vec<String> = history.iter().chain(&live).cloned().collect();
    let log = bytes(&all);

    let mut server = Server::attach(0, OutboundLimits::default(), replay_len);
    server.pump(&log, log.len(), 37);
    let mut client = Inbound::new(0);
    let mut applied = Vec::new();
    while let Some(msg) = server.queue.pop() {
        if let Some(InboundAction::Apply { payload, .. }) = client.on_message(msg) {
            applied.push(payload);
        }
    }

    assert_eq!(client.expected(), log.len() as u64);
    // 回放中被跳过的是 index 0、1、4；6、7 属于未写完的消息，8、10 是实时的。
    let skipped = [stream(0), stream(1), stream(4)];
    let expected: Vec<&String> = all.iter().filter(|l| !skipped.contains(l)).collect();
    assert_eq!(applied.iter().collect::<Vec<_>>(), expected);
}
