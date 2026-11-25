//! 线路兼容（宽松规则，2026-11-25 定）：`PROTOCOL_VERSION` 不变时，新代码要认得旧版发来的每种消息，
//! 旧版也要认得新代码发出的（只许多出字段）。样本在 `tests/wire-v<版本>/`：`client.jsonl` 是这个版本的
//! 客户端发给 hubd 的，`server.jsonl` 是 hubd 发给客户端的（`Frame`）。
//!
//! - 不用升版本：新增消息类型（旧 hubd 回 `Error`，旧客户端跳过），给已有消息加可选字段（`#[serde(default)]`）。
//!   新增类型要在样本里补一条，以后改它也有人看着。
//! - 要升版本：改名、删除、改类型、加必填字段、已有消息里的枚举加取值、改含义。升了就三端一起升级：
//!   把 `tests/wire-v<旧>` 复制成 `tests/wire-v<新>`，按新格式改好样本，删掉旧目录。
//! - 不要为了变绿去改已有的样本：样本就是已经发出去的客户端和 hubd 的样子。
//! - 测不出来、要自己注意的：改含义；必填字段改成可省略（旧版收到缺这个字段的消息会解析失败）。

use std::collections::BTreeSet;
use std::path::PathBuf;

use cchub_protocol::{AckError, ClientMsg, EventClass, Frame, ServerMsg, PROTOCOL_VERSION};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

const BREAKING: &str = "这是破坏性改动：改回兼容的写法（加字段用 #[serde(default)]），\
                        或升 PROTOCOL_VERSION（见本文件开头）";

fn samples(file: &str) -> Vec<Value> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join(format!("wire-v{PROTOCOL_VERSION}"));
    assert!(
        dir.is_dir(),
        "协议版本是 {PROTOCOL_VERSION}，没有 {}：升版本时把上一版的样本目录复制过来，按新格式改，再删掉旧目录",
        dir.display()
    );
    let path = dir.join(file);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("读不了 {}：{e}", path.display()))
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str(line).unwrap_or_else(|e| panic!("样本不是 JSON：{line}：{e}"))
        })
        .collect()
}

fn client_samples() -> Vec<Value> {
    samples("client.jsonl")
}

fn server_samples() -> Vec<Value> {
    samples("server.jsonl")
}

/// 枚举现在有哪些取值：serde 碰到不认识的取值时，报错里会列出全部取值。
fn variants<T: DeserializeOwned>(probe: Value) -> BTreeSet<String> {
    let error = serde_json::from_value::<T>(probe)
        .err()
        .expect("探针不该解析成功")
        .to_string();
    let list = error
        .split("expected one of ")
        .nth(1)
        .unwrap_or_else(|| panic!("serde 的报错格式变了，取不到取值列表：{error}"));
    list.split(", ")
        .map(|v| v.trim_matches('`').to_string())
        .collect()
}

fn tags(samples: &[Value]) -> BTreeSet<String> {
    samples
        .iter()
        .filter_map(|s| s["type"].as_str().map(str::to_string))
        .collect()
}

/// `new` 里缺了 `old` 的哪些内容。只许多出对象字段；值为 null 的字段省略也行（旧版的 `Option` 缺了就是 `None`）。
fn missing(old: &Value, new: &Value, path: &str) -> Vec<String> {
    match (old, new) {
        (Value::Object(old), Value::Object(new)) => old
            .iter()
            .flat_map(|(key, value)| match new.get(key) {
                Some(now) => missing(value, now, &format!("{path}.{key}")),
                None if value.is_null() => Vec::new(),
                None => vec![format!("{path}.{key} 没有了")],
            })
            .collect(),
        (Value::Array(old), Value::Array(new)) if old.len() == new.len() => old
            .iter()
            .zip(new)
            .enumerate()
            .flat_map(|(i, (a, b))| missing(a, b, &format!("{path}[{i}]")))
            .collect(),
        _ if old == new => Vec::new(),
        _ => vec![format!("{path}：原来是 {old}，现在是 {new}")],
    }
}

fn reencode<T: DeserializeOwned + Serialize>(sample: &Value) -> Result<Value, String> {
    let parsed: T = serde_json::from_value(sample.clone()).map_err(|e| e.to_string())?;
    Ok(serde_json::to_value(parsed).unwrap())
}

#[test]
fn old_messages_still_parse() {
    let mut broken = Vec::new();
    for sample in client_samples() {
        if let Err(e) = reencode::<ClientMsg>(&sample) {
            broken.push(format!("客户端发的 {sample}：{e}"));
        }
    }
    for sample in server_samples() {
        if let Err(e) = reencode::<Frame>(&sample) {
            broken.push(format!("hubd 发的 {sample}：{e}"));
        }
    }
    assert!(
        broken.is_empty(),
        "协议 {PROTOCOL_VERSION} 的旧版发来的消息，新代码解析不了：\n{}\n{BREAKING}",
        broken.join("\n")
    );
}

#[test]
fn new_messages_keep_every_old_field() {
    let mut broken = Vec::new();
    let both = client_samples()
        .into_iter()
        .map(|s| (reencode::<ClientMsg>(&s), s))
        .chain(
            server_samples()
                .into_iter()
                .map(|s| (reencode::<Frame>(&s), s)),
        );
    for (now, sample) in both {
        // 解析不了的由上一个测试报。
        let Ok(now) = now else { continue };
        for problem in missing(&sample, &now, "") {
            broken.push(format!("{sample}\n  → {problem}"));
        }
    }
    assert!(
        broken.is_empty(),
        "新代码发出的消息，协议 {PROTOCOL_VERSION} 的旧版读不懂：\n{}\n{BREAKING}",
        broken.join("\n")
    );
}

#[test]
fn every_message_type_has_a_sample() {
    let client: Vec<_> = variants::<ClientMsg>(json!({"type": "\u{1}"}))
        .difference(&tags(&client_samples()))
        .cloned()
        .collect();
    let server: Vec<_> = variants::<ServerMsg>(json!({"type": "\u{1}"}))
        .difference(&tags(&server_samples()))
        .cloned()
        .collect();
    assert!(
        client.is_empty() && server.is_empty(),
        "新增的消息类型没有样本（客户端发的 {client:?}，hubd 发的 {server:?}）：\
         在 tests/wire-v{PROTOCOL_VERSION}/client.jsonl 或 server.jsonl 各补一条。新增类型不用升版本"
    );
}

#[test]
fn nested_enums_gain_no_values() {
    let servers = server_samples();
    let used = |kind: &str, field: &str| -> BTreeSet<String> {
        servers
            .iter()
            .filter(|s| s["type"] == kind)
            .filter_map(|s| s[field].as_str().map(str::to_string))
            .collect()
    };
    let added = |now: BTreeSet<String>, before: BTreeSet<String>| -> Vec<String> {
        now.difference(&before).cloned().collect()
    };
    let ack = added(variants::<AckError>(json!("\u{1}")), used("ack", "error"));
    let class = added(
        variants::<EventClass>(json!("\u{1}")),
        used("event", "class"),
    );
    assert!(
        ack.is_empty() && class.is_empty(),
        "已有消息里的枚举多了取值（AckError {ack:?}，EventClass {class:?}）：旧版收到会整条解析失败、悄悄丢掉，\
         要升 PROTOCOL_VERSION。只补样本会让旧版客户端丢消息"
    );
}
