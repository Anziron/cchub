//! 回放录制的 stream-json，用来不耗额度地跑完整链路。
//!
//! 用法：`fake-claude <录制文件> [每行延迟毫秒]`
//! 收到用户消息才开始输出，遇到审批请求就停下，等到对应的 `control_response` 才继续。

use std::io::{self, BufRead, Write};
use std::{env, fs, thread, time::Duration};

use serde_json::Value;

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// 读 stdin 直到某一行满足条件；EOF 时结束进程，和 `claude` 的行为一致。
fn wait_for(stdin: &mut impl BufRead, matches: impl Fn(&Value) -> bool) {
    let mut line = String::new();
    loop {
        line.clear();
        if stdin.read_line(&mut line).unwrap_or(0) == 0 {
            std::process::exit(0);
        }
        if serde_json::from_str::<Value>(&line).is_ok_and(|value| matches(&value)) {
            return;
        }
    }
}

fn main() {
    let mut args = env::args().skip(1);
    let path = args.next().expect("缺少录制文件路径");
    let delay = args
        .next()
        .map_or(0, |d| d.parse().expect("延迟必须是数字"));
    let script = fs::read_to_string(path).expect("读不到录制文件");

    let mut stdin = io::stdin().lock();
    let mut stdout = io::stdout().lock();
    let is_user = |value: &Value| field(value, "type") == Some("user");

    let mut waiting_for_user = true;
    for line in script.lines() {
        if waiting_for_user {
            wait_for(&mut stdin, is_user);
            waiting_for_user = false;
        }
        writeln!(stdout, "{line}").expect("写 stdout 失败");
        stdout.flush().expect("写 stdout 失败");
        thread::sleep(Duration::from_millis(delay));

        let event: Value = serde_json::from_str(line).expect("录制文件不是合法 JSON");
        match field(&event, "type") {
            Some("control_request") => {
                let id = field(&event, "request_id").unwrap_or_default().to_string();
                wait_for(&mut stdin, |value| {
                    field(value, "type") == Some("control_response")
                        && value
                            .pointer("/response/request_id")
                            .and_then(Value::as_str)
                            == Some(id.as_str())
                });
            }
            Some("result") => waiting_for_user = true,
            _ => {}
        }
    }

    // 脚本放完后和 claude 一样继续等输入，直到 EOF 或被结束。
    wait_for(&mut stdin, |_| false);
}
