//! 进程托管。`claude` 不能是 `hubd` 的管道子进程，否则 `hubd` 一死它也跟着退出。
//! 两种实现都把 stdin 接到 FIFO、stdout 接到文件，`hubd` 重启后靠这两个路径接回。

// 启动和结束会话进程是这个模块的本职；状态检查读 cgroup，只在没有 cgroup v2 时退回 systemctl。
#![allow(clippy::disallowed_methods)]

use std::fs;
use std::io;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};

use crate::load;
use crate::session::HeldInput;

/// 启动参数里的会话 ID、模型。会话 ID 已由 `valid_id` 校验。
#[derive(Debug, Clone, Copy, Default)]
pub struct Launch<'a> {
    pub resume: Option<&'a str>,
    /// 用 `--model` 启动，第一轮就是这个模型（启动后再发 `set_model` 偶尔没赶上第一轮）。
    pub model: Option<&'a str>,
}

/// 模型名只允许别名和模型 ID 里会出现的字符，如 `opus`、`claude-opus-5-5`、`sonnet[1m]`。
pub fn valid_model(model: &str) -> bool {
    (1..=64).contains(&model.len())
        && model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:[]".contains(&b))
}

/// 用 `<>` 打开 FIFO，进程自己持有写端，所以永远读不到 EOF。
fn shell_command(claude_cmd: &str, dir: &Path, launch: Launch) -> String {
    let dir = shell_quote(&dir.to_string_lossy());
    let resume = launch
        .resume
        .map_or(String::new(), |id| format!(" --resume {id}"));
    let model = launch.model.map_or(String::new(), |model| {
        format!(" --model {}", shell_quote(model))
    });
    format!("exec {claude_cmd}{resume}{model} <>{dir}/in >>{dir}/out 2>>{dir}/err")
}

fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// 会话进程（含子进程）的累计用量。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Usage {
    /// 累计用的 CPU 时间，微秒。
    pub cpu_usec: u64,
    /// 现在占的内存，字节。
    pub mem_bytes: u64,
    /// 会话的进程组号，组里的进程不算“其他进程”（见 `load.rs`）。放在 systemd unit 里时按 cgroup 认，为空。
    pub group: Option<u32>,
}

pub trait ProcessHost: Send + Sync {
    /// `cwd` 是进程的工作目录，`dir` 是会话目录。`input` 证明 FIFO 已经打开并持有（见 `HeldInput`）。
    fn start(
        &self,
        session: &str,
        dir: &Path,
        cwd: &Path,
        launch: Launch,
        input: &HeldInput,
    ) -> io::Result<()>;
    fn is_running(&self, session: &str, dir: &Path) -> bool;
    fn stop(&self, session: &str, dir: &Path) -> io::Result<()>;
    /// 没在运行或读不到时为空。
    fn usage(&self, session: &str, dir: &Path) -> Option<Usage>;
}

/// 放进独立的 systemd unit，和 `hubd` 分属不同 cgroup，`hubd` 的 `MemoryMax` 不影响它。
pub struct SystemdHost {
    pub claude_cmd: String,
    pub memory_max_mb: u64,
}

/// 会话 unit 名的前缀，`load.rs` 据此从进程的 cgroup 认出会话的进程。
pub const UNIT_PREFIX: &str = "cchub-session-";

fn unit_name(session: &str) -> String {
    format!("{UNIT_PREFIX}{session}")
}

/// systemd 把 system 服务放在这里（cgroup v2）。
const SYSTEM_SLICE: &str = "/sys/fs/cgroup/system.slice";

/// 读 unit 的 `cgroup.procs` 判断进程是否还在。列表和状态检查很频繁，每次起一个
/// `systemctl` 要约 6ms CPU，空闲时也会持续占用。返回 `None` 表示没有 cgroup v2，要退回 `systemctl`。
fn cgroup_running(slice: &Path, unit: &str) -> Option<bool> {
    if !slice.is_dir() {
        return None;
    }
    let procs = slice.join(format!("{unit}.service")).join("cgroup.procs");
    Some(fs::read_to_string(procs).is_ok_and(|procs| !procs.trim().is_empty()))
}

/// unit 的 cgroup 里的累计 CPU（含已退出的子进程）和当前内存。
fn cgroup_usage(slice: &Path, unit: &str) -> Option<Usage> {
    if cgroup_running(slice, unit) != Some(true) {
        return None;
    }
    let dir = slice.join(format!("{unit}.service"));
    let cpu = fs::read_to_string(dir.join("cpu.stat")).ok()?;
    let memory = fs::read_to_string(dir.join("memory.current")).ok()?;
    Some(Usage {
        cpu_usec: load::parse_usage_usec(&cpu)?,
        mem_bytes: memory.trim().parse().ok()?,
        group: None,
    })
}

impl ProcessHost for SystemdHost {
    fn start(
        &self,
        session: &str,
        dir: &Path,
        cwd: &Path,
        launch: Launch,
        _input: &HeldInput,
    ) -> io::Result<()> {
        let mut command = Command::new("systemd-run");
        command
            .args(["-q", "--collect", "--unit"])
            .arg(unit_name(session))
            .arg("-p")
            .arg(format!("WorkingDirectory={}", cwd.display()));
        // 超过上限先换出到 swap，换不动才被 OOM 杀掉，不会拖垮服务器上的其他服务。
        if self.memory_max_mb > 0 {
            command
                .arg("-p")
                .arg(format!("MemoryMax={}M", self.memory_max_mb));
        }
        for name in ["PATH", "HOME"] {
            if let Ok(value) = std::env::var(name) {
                command.arg(format!("--setenv={name}={value}"));
            }
        }
        let status = command
            .args(["/bin/sh", "-c"])
            .arg(shell_command(&self.claude_cmd, dir, launch))
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(io::Error::other(format!("systemd-run 失败：{status}")))
        }
    }

    fn is_running(&self, session: &str, _dir: &Path) -> bool {
        let unit = unit_name(session);
        if let Some(running) = cgroup_running(Path::new(SYSTEM_SLICE), &unit) {
            return running;
        }
        Command::new("systemctl")
            .args(["is-active", "--quiet"])
            .arg(unit)
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

    fn usage(&self, session: &str, _dir: &Path) -> Option<Usage> {
        cgroup_usage(Path::new(SYSTEM_SLICE), &unit_name(session))
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
        launch: Launch,
        _input: &HeldInput,
    ) -> io::Result<()> {
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg(shell_command(&self.claude_cmd, dir, launch))
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

    /// 只有主进程和它已回收的子进程：还在跑的子进程不算，没有 systemd 时只是近似。
    fn usage(&self, _session: &str, dir: &Path) -> Option<Usage> {
        let pid = read_pid(dir).filter(|pid| pid_alive(*pid))?;
        let stat = load::proc_stat(u32::try_from(pid).ok()?)?;
        Some(Usage {
            cpu_usec: (stat.ticks + stat.child_ticks) * 1_000_000 / load::clock_ticks(),
            mem_bytes: stat.rss_pages * load::page_size(),
            group: Some(stat.group),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_command_opens_fifo_read_write_and_appends_output() {
        let launch = Launch {
            resume: Some("id1"),
            model: None,
        };
        let command = shell_command("claude -p", Path::new("/s/a"), launch);
        assert_eq!(
            command,
            "exec claude -p --resume id1 <>'/s/a'/in >>'/s/a'/out 2>>'/s/a'/err"
        );
    }

    #[test]
    fn shell_command_passes_model() {
        let launch = Launch {
            resume: Some("id1"),
            model: Some("sonnet[1m]"),
        };
        let command = shell_command("claude -p", Path::new("/s/a"), launch);
        assert_eq!(
            command,
            "exec claude -p --resume id1 --model 'sonnet[1m]' <>'/s/a'/in >>'/s/a'/out 2>>'/s/a'/err"
        );
    }

    #[test]
    fn model_rejects_shell_characters() {
        for good in ["opus", "claude-opus-5-5", "sonnet[1m]", "us.anthropic.x:1"] {
            assert!(valid_model(good), "{good}");
        }
        for bad in ["", "a b", "x;rm", "$(x)", "a'b", &"x".repeat(65)] {
            assert!(!valid_model(bad), "{bad}");
        }
    }

    #[test]
    fn cgroup_running_reads_unit_procs() {
        let slice = std::env::temp_dir().join(format!("hubd-cgroup-{}", std::process::id()));
        let _ = fs::remove_dir_all(&slice);
        assert_eq!(
            cgroup_running(&slice, "cchub-session-a"),
            None,
            "没有 cgroup v2"
        );
        fs::create_dir_all(slice.join("cchub-session-a.service")).unwrap();
        fs::create_dir_all(slice.join("cchub-session-b.service")).unwrap();
        fs::write(slice.join("cchub-session-a.service/cgroup.procs"), "1234\n").unwrap();
        fs::write(slice.join("cchub-session-b.service/cgroup.procs"), "").unwrap();
        assert_eq!(cgroup_running(&slice, "cchub-session-a"), Some(true));
        assert_eq!(
            cgroup_running(&slice, "cchub-session-b"),
            Some(false),
            "进程都退出了"
        );
        assert_eq!(
            cgroup_running(&slice, "cchub-session-c"),
            Some(false),
            "unit 已回收"
        );
        fs::remove_dir_all(&slice).unwrap();
    }

    #[test]
    fn cgroup_usage_reads_cpu_and_memory() {
        let slice = std::env::temp_dir().join(format!("hubd-usage-{}", std::process::id()));
        let _ = fs::remove_dir_all(&slice);
        let unit = slice.join("cchub-session-a.service");
        fs::create_dir_all(&unit).unwrap();
        fs::write(unit.join("cgroup.procs"), "1234\n").unwrap();
        fs::write(
            unit.join("cpu.stat"),
            "usage_usec 2500000\nuser_usec 2000000\n",
        )
        .unwrap();
        fs::write(unit.join("memory.current"), "314572800\n").unwrap();
        assert_eq!(
            cgroup_usage(&slice, "cchub-session-a"),
            Some(Usage {
                cpu_usec: 2_500_000,
                mem_bytes: 314_572_800,
                group: None,
            })
        );
        assert_eq!(cgroup_usage(&slice, "cchub-session-b"), None, "unit 已回收");
        fs::write(unit.join("cgroup.procs"), "").unwrap();
        assert_eq!(
            cgroup_usage(&slice, "cchub-session-a"),
            None,
            "进程都退出了"
        );
        fs::remove_dir_all(&slice).unwrap();
    }
}
