//! 确定性模拟：服务端和客户端之间的链路会丢消息、断线，服务端也会重启。
//! 失败时 proptest 会给出能复现的种子。

use cchub_protocol::{
    classify, EventClass, Inbound, InboundAction, LineSplitter, Outbound, OutboundLimits,
};
use proptest::prelude::*;

const PARTIAL: &str = r#"{"type":"stream_event","event":"xxxxxxxxxxxxxxxx"}"#;

fn line(kind: u8, index: usize) -> String {
    match kind % 8 {
        0..=3 => PARTIAL.to_string(),
        4 | 5 => format!(r#"{{"type":"assistant","index":{index}}}"#),
        6 => format!(
            r#"{{"type":"control_request","request":{{"subtype":"can_use_tool"}},"index":{index}}}"#
        ),
        _ => format!(r#"{{"type":"brand_new","index":{index}}}"#),
    }
}

#[derive(Debug, Clone)]
enum Fault {
    Deliver,
    /// 丢掉下一条消息。
    Drop,
    /// 断线：丢掉服务端队列，客户端从自己的偏移重新订阅。
    Reconnect,
    /// `hubd` 重启：内存状态全丢，只剩文件。
    RestartServer,
}

fn fault() -> impl Strategy<Value = Fault> {
    prop_oneof![
        8 => Just(Fault::Deliver),
        2 => Just(Fault::Drop),
        1 => Just(Fault::Reconnect),
        1 => Just(Fault::RestartServer),
    ]
}

struct Server {
    splitter: LineSplitter,
    queue: Outbound,
    limits: OutboundLimits,
}

impl Server {
    fn attach(after: u64, limits: OutboundLimits) -> Self {
        Self {
            splitter: LineSplitter::new(after),
            queue: Outbound::new(limits),
            limits,
        }
    }

    /// 像真实的读循环一样，分块读文件，队列满了就暂停。
    fn pump(&mut self, log: &[u8], chunk: usize) {
        while self.queue.wants_more() {
            let start = self.splitter.read_offset() as usize;
            if start >= log.len() {
                return;
            }
            let end = (start + chunk).min(log.len());
            for (seq, next, text) in self.splitter.feed(&log[start..end]) {
                self.queue.push(seq, next, text);
            }
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(400))]

    #[test]
    fn nothing_durable_is_lost_under_faults(
        kinds in proptest::collection::vec(any::<u8>(), 1..200),
        faults in proptest::collection::vec(fault(), 1..400),
        chunk in 1usize..200,
        max_partial_bytes in 1usize..500,
        max_queued_bytes in 1usize..4000,
    ) {
        let lines: Vec<String> = kinds.iter().enumerate().map(|(i, k)| line(*k, i)).collect();
        let log: Vec<u8> = lines.iter().flat_map(|l| format!("{l}\n").into_bytes()).collect();
        let limits = OutboundLimits { max_partial_bytes, max_queued_bytes };

        let mut server = Server::attach(0, limits);
        let mut client = Inbound::new(0);
        let mut applied: Vec<String> = Vec::new();

        let handle = |client: &mut Inbound, server: &mut Server, applied: &mut Vec<String>, msg| {
            match client.on_message(msg) {
                Some(InboundAction::Apply { payload, .. }) => applied.push(payload),
                Some(InboundAction::Resync { after }) => *server = Server::attach(after, server.limits),
                _ => {}
            }
        };

        for fault in faults {
            server.pump(&log, chunk);
            match fault {
                Fault::Deliver => {
                    if let Some(msg) = server.queue.pop() {
                        handle(&mut client, &mut server, &mut applied, msg);
                    }
                }
                Fault::Drop => {
                    server.queue.pop();
                }
                Fault::Reconnect | Fault::RestartServer => {
                    server = Server::attach(client.expected(), limits);
                }
            }
        }

        // 故障结束后链路恢复：最终必须走到文件末尾。
        let mut steps = 0;
        while client.expected() < log.len() as u64 {
            server.pump(&log, chunk);
            match server.queue.pop() {
                Some(msg) => handle(&mut client, &mut server, &mut applied, msg),
                None => server = Server::attach(client.expected(), limits),
            }
            steps += 1;
            prop_assert!(steps < 100_000, "没有收敛");
        }

        let expected: Vec<&String> = lines.iter().filter(|l| classify(l) != EventClass::Partial).collect();
        let got: Vec<&String> = applied.iter().filter(|l| classify(l) != EventClass::Partial).collect();
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

    let mut server = Server::attach(0, OutboundLimits::default());
    server.queue.set_replay_until(replay_len);
    server.pump(&log, 37);
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
