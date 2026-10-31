//! 进程托管。`claude` 不能是 `hubd` 的管道子进程，否则 `hubd` 一死它也跟着退出。
//! 两种实现都把 stdin 接到 FIFO、stdout 接到文件，`hubd` 重启后靠这两个路径接回。

use std::fs;
use std::io;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};

/// 用 `<>` 打开 FIFO，进程自己持有写端，所以永远读不到 EOF。
fn shell_command(claude_cmd: &str, dir: &Path, resume: Option<&str>) -> String {
    let dir = shell_quote(&dir.to_string_lossy());
    let resume = resume.map_or(String::new(), |id| format!(" --resume {id}"));
    format!("exec {claude_cmd}{resume} <>{dir}/in >>{dir}/out 2>>{dir}/err")
}

fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

pub trait ProcessHost: Send + Sync {
    /// `cwd` 是进程的工作目录，`dir` 是会话目录。
    fn start(&self, session: &str, dir: &Path, cwd: &Path, resume: Option<&str>) -> io::Result<()>;
    fn is_running(&self, session: &str, dir: &Path) -> bool;
    fn stop(&self, session: &str, dir: &Path) -> io::Result<()>;
}

/// 放进独立的 systemd unit，和 `hubd` 分属不同 cgroup，`hubd` 的 `MemoryMax` 不影响它。
pub struct SystemdHost {
    pub claude_cmd: String,
}

fn unit_name(session: &str) -> String {
    format!("cchub-session-{session}")
}

impl ProcessHost for SystemdHost {
    fn start(&self, session: &str, dir: &Path, cwd: &Path, resume: Option<&str>) -> io::Result<()> {
        let mut command = Command::new("systemd-run");
        command
            .args(["-q", "--collect", "--unit"])
            .arg(unit_name(session))
            .arg("-p")
            .arg(format!("WorkingDirectory={}", cwd.display()));
        for name in ["PATH", "HOME"] {
            if let Ok(value) = std::env::var(name) {
                command.arg(format!("--setenv={name}={value}"));
            }
        }
        let status = command
            .args(["/bin/sh", "-c"])
            .arg(shell_command(&self.claude_cmd, dir, resume))
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(io::Error::other(format!("systemd-run 失败：{status}")))
        }
    }

    fn is_running(&self, session: &str, _dir: &Path) -> bool {
        Command::new("systemctl")
            .args(["is-active", "--quiet"])
            .arg(unit_name(session))
            .status()
            .is_ok_and(|status| status.success())
    }

    fn stop(&self, session: &str, _dir: &Path) -> io::Result<()> {
        Command::new("systemctl")
            .arg("stop")
            .arg(unit_name(session))
            .status()
            .map(|_| ())
    }
}

/// 不依赖 systemd：独立进程组，PID 写进会话目录。用于测试和没有 systemd 的环境。
pub struct DirectHost {
    pub claude_cmd: String,
}

fn read_pid(dir: &Path) -> Option<i32> {
    fs::read_to_string(dir.join("pid"))
        .ok()?
        .trim()
        .parse()
        .ok()
}

fn pid_alive(pid: i32) -> bool {
    // 已退出但没被回收的僵尸进程不算活着。
    fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
        stat.rsplit(')')
            .next()
            .and_then(|rest| rest.split_whitespace().next())
            != Some("Z")
    })
}

impl ProcessHost for DirectHost {
    fn start(
        &self,
        _session: &str,
        dir: &Path,
        cwd: &Path,
        resume: Option<&str>,
    ) -> io::Result<()> {
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg(shell_command(&self.claude_cmd, dir, resume))
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()?;
        fs::write(dir.join("pid"), child.id().to_string())?;
        // `hubd` 还在时替它回收；`hubd` 死后进程由 init 接管。
        std::thread::spawn(move || child.wait());
        Ok(())
    }

    fn is_running(&self, _session: &str, dir: &Path) -> bool {
        read_pid(dir).is_some_and(pid_alive)
    }

    fn stop(&self, _session: &str, dir: &Path) -> io::Result<()> {
        if let Some(pid) = read_pid(dir).filter(|pid| pid_alive(*pid)) {
            // SAFETY: kill 只接收整数参数，不涉及内存。
            if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_command_opens_fifo_read_write_and_appends_output() {
        let command = shell_command("claude -p", Path::new("/s/a"), Some("id1"));
        assert_eq!(
            command,
            "exec claude -p --resume id1 <>'/s/a'/in >>'/s/a'/out 2>>'/s/a'/err"
        );
    }
}
