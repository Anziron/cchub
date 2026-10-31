//! 探测项目目录所在设备是否在线。
//!
//! sshfs 缓存文件属性，查已有文件可能在断网后仍然成功，所以每次查一个新的、不存在的文件名，
//! 请求一定会到达设备。设备答复“不存在”就说明在线。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::runner;

pub const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const FAILURES_BEFORE_OFFLINE: u32 = 2;

/// 探测子进程的入口。放在子进程里，是因为断开的挂载可能让系统调用卡住几十秒。
pub fn probe_main(dir: &Path) -> bool {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    let name = format!(".cchub-probe-{}-{nonce}", std::process::id());
    match std::fs::symlink_metadata(dir.join(name)) {
        Ok(_) => true,
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    }
}

/// 还没退出的探测。卡在断开挂载上的子进程杀不掉，要等连接恢复；
/// 上一个没退出就不再启动新的，否则断网期间进程和线程会越积越多。
static IN_FLIGHT: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

fn begin_probe(dir: &Path) -> bool {
    let mut in_flight = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    in_flight.get_or_insert_default().insert(dir.to_path_buf())
}

fn end_probe(dir: &Path) {
    let mut in_flight = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(in_flight) = in_flight.as_mut() {
        in_flight.remove(dir);
    }
}

pub fn probe(dir: &Path) -> bool {
    probe_with(dir, Path::new("/proc/self/exe"), &["--probe"])
}

fn probe_with(dir: &Path, program: &Path, args: &[&str]) -> bool {
    if !begin_probe(dir) {
        return false;
    }
    let mut command = Command::new(program);
    command.args(args).arg(dir);
    let finished = dir.to_path_buf();
    runner::run_then(command, PROBE_TIMEOUT, move || end_probe(&finished))
        .is_some_and(|(success, _)| success)
}

/// 网络偶尔抖动不算离线：连续失败才判定离线，一次成功就恢复。
#[derive(Debug, Default)]
pub struct DeviceMonitor {
    failures: u32,
    online: Option<bool>,
}

impl DeviceMonitor {
    /// 状态变化时返回新状态。
    pub fn observe(&mut self, success: bool) -> Option<bool> {
        self.failures = if success { 0 } else { self.failures + 1 };
        let next = if success {
            true
        } else if self.failures >= FAILURES_BEFORE_OFFLINE {
            false
        } else {
            return None;
        };
        (self.online != Some(next)).then(|| {
            self.online = Some(next);
            next
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_failure_is_not_offline_and_one_success_recovers() {
        let mut monitor = DeviceMonitor::default();
        assert_eq!(monitor.observe(true), Some(true));
        assert_eq!(monitor.observe(true), None);
        assert_eq!(monitor.observe(false), None);
        assert_eq!(monitor.observe(false), Some(false));
        assert_eq!(monitor.observe(false), None);
        assert_eq!(monitor.observe(true), Some(true));
    }

    #[test]
    fn does_not_start_a_second_probe_while_one_is_stuck() {
        let dir = PathBuf::from(format!("/nonexistent/hubd-probe-{}", std::process::id()));
        assert!(begin_probe(&dir));
        assert!(!probe_with(&dir, Path::new("/bin/true"), &[]));
        end_probe(&dir);
        assert!(probe_with(&dir, Path::new("/bin/true"), &[]));
    }

    #[test]
    fn missing_name_counts_as_online_but_other_errors_do_not() {
        let dir = std::env::temp_dir();
        assert!(probe_main(&dir));
        // 路径的一段是普通文件：不是“不存在”，属于其他错误。
        let file = dir.join(format!("hubd-probe-test-{}", std::process::id()));
        std::fs::write(&file, "").unwrap();
        assert!(!probe_main(&file));
        std::fs::remove_file(&file).unwrap();
    }
}
