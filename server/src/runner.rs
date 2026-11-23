//! 带超时运行子进程。挂载断开时子进程可能卡很久，不能让它拖住 `hubd`。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::os::fd::FromRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

#[derive(Debug)]
pub enum Outcome {
    Exited {
        success: bool,
        stdout: Vec<u8>,
        stderr: Vec<u8>,
    },
    /// 超时，整个进程组已被结束。
    TimedOut,
    /// 没能启动。
    Failed,
}

/// stderr 最多读这么多，只用来给用户看失败原因。
const STDERR_MAX: u64 = 64 * 1024;

/// stderr 写进匿名内存文件，进程退出后再读。不能用管道：sshfs 起的 ssh 会一直持有继承来的 stderr，
/// 读管道要等到卸载才结束。
fn stderr_file() -> Option<File> {
    // SAFETY: 名字是以 NUL 结尾的常量；返回的 fd 由 File 接管。
    let fd = unsafe { libc::memfd_create(c"hubd-stderr".as_ptr(), libc::MFD_CLOEXEC) };
    // SAFETY: fd 刚创建、有效，且只交给这一个 File。
    (fd >= 0).then(|| unsafe { File::from_raw_fd(fd) })
}

fn read_stderr(file: Option<File>) -> Vec<u8> {
    let mut stderr = Vec::new();
    if let Some(mut file) = file {
        if file.seek(SeekFrom::Start(0)).is_ok() {
            let _ = file.take(STDERR_MAX).read_to_end(&mut stderr);
        }
    }
    stderr
}

/// 子进程放进自己的进程组，超时连同它起的孙进程（如挂载脚本里的 ssh、sshfs）一起结束，
/// 不会留在后台过一会儿才完成。已经 `setsid` 脱离的守护进程（挂载成功后的 sshfs）不受影响。
pub fn run_detailed(mut command: Command, timeout: Duration) -> Outcome {
    let stderr = stderr_file();
    let stderr_stdio = match stderr.as_ref().map(File::try_clone) {
        Some(Ok(file)) => Stdio::from(file),
        _ => Stdio::null(),
    };
    let Ok(child) = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(stderr_stdio)
        .process_group(0)
        .spawn()
    else {
        return Outcome::Failed;
    };
    let pid = child.id() as i32;
    let (tx, rx) = mpsc::channel();
    // 子进程可能卡在内核里，等待放到单独线程，结束后顺带回收。
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(output)) => Outcome::Exited {
            success: output.status.success(),
            stdout: output.stdout,
            stderr: read_stderr(stderr),
        },
        Ok(Err(_)) => Outcome::Failed,
        Err(_) => {
            // SAFETY: kill 只接收整数参数。线程还在等待组长进程，PID（即进程组号）没有被回收。
            unsafe { libc::kill(-pid, libc::SIGKILL) };
            Outcome::TimedOut
        }
    }
}

/// 返回 `(是否成功, stdout)`；启动失败或超时返回 `None`，超时的子进程会被结束。
pub fn run(command: Command, timeout: Duration) -> Option<(bool, Vec<u8>)> {
    match run_detailed(command, timeout) {
        Outcome::Exited {
            success, stdout, ..
        } => Some((success, stdout)),
        Outcome::TimedOut | Outcome::Failed => None,
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
    fn keeps_stderr() {
        let mut command = Command::new("sh");
        command.args(["-c", "echo out; echo 挂载失败 >&2; exit 1"]);
        match run_detailed(command, Duration::from_secs(5)) {
            Outcome::Exited {
                success,
                stdout,
                stderr,
            } => {
                assert!(!success);
                assert_eq!(stdout, b"out\n");
                assert_eq!(String::from_utf8_lossy(&stderr), "挂载失败\n");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn background_process_holding_stderr_does_not_block() {
        // sshfs 起的 ssh 会一直持有继承来的 stderr：挂载脚本退出就该返回，不能等它。
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 3 >/dev/null & echo 原因 >&2"]);
        let start = Instant::now();
        match run_detailed(command, Duration::from_secs(1)) {
            Outcome::Exited {
                success, stderr, ..
            } => {
                assert!(success);
                assert_eq!(String::from_utf8_lossy(&stderr), "原因\n");
            }
            other => panic!("{other:?}"),
        }
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn timeout_kills_grandchildren_too() {
        // 挂载脚本超时后，它起的 ssh / sshfs 不能留在后台接着跑。
        let pid_file = std::env::temp_dir().join(format!("hubd-runner-{}", std::process::id()));
        let mut command = Command::new("sh");
        command.arg("-c").arg(format!(
            "sleep 300 & echo $! > {}; wait",
            pid_file.display()
        ));
        let start = Instant::now();
        assert!(matches!(
            run_detailed(command, Duration::from_millis(300)),
            Outcome::TimedOut
        ));
        assert!(start.elapsed() < Duration::from_secs(5));
        let pid = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .to_string();
        std::fs::remove_file(&pid_file).unwrap();
        let alive = || {
            std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
                stat.rsplit(") ")
                    .next()
                    .is_some_and(|rest| !rest.starts_with('Z'))
            })
        };
        let deadline = Instant::now() + Duration::from_secs(2);
        while alive() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!alive(), "孙进程 {pid} 还活着");
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
