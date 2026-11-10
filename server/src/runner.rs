//! 带超时运行子进程。挂载断开时子进程可能卡很久，不能让它拖住 `hubd`。

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

/// 返回 `(是否成功, stdout)`；启动失败或超时返回 `None`，超时的子进程会被结束。
pub fn run(mut command: Command, timeout: Duration) -> Option<(bool, Vec<u8>)> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let pid = child.id() as i32;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    // 子进程可能卡在内核里，等待放到单独线程，结束后顺带回收。
    std::thread::spawn(move || {
        let mut output = Vec::new();
        let _ = stdout.read_to_end(&mut output);
        let success = child.wait().is_ok_and(|status| status.success());
        let _ = tx.send((success, output));
    });
    match rx.recv_timeout(timeout) {
        Ok(result) => Some(result),
        Err(_) => {
            // SAFETY: kill 只接收整数参数。线程还在等待该进程，PID 没有被回收。
            unsafe { libc::kill(pid, libc::SIGKILL) };
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn returns_output_and_status() {
        let mut command = Command::new("sh");
        command.args(["-c", "echo hi; exit 3"]);
        let (success, output) = run(command, Duration::from_secs(5)).unwrap();
        assert!(!success);
        assert_eq!(output, b"hi\n");
    }

    #[test]
    fn kills_child_on_timeout() {
        let mut command = Command::new("sleep");
        command.arg("60");
        let start = Instant::now();
        assert!(run(command, Duration::from_millis(100)).is_none());
        assert!(start.elapsed() < Duration::from_secs(5));
    }
}
