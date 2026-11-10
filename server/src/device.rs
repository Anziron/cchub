//! 探测项目目录所在设备是否在线。
//!
//! sshfs 缓存文件属性，查已有文件可能在断网后仍然成功，所以每次查一个新的、不存在的文件名，
//! 请求一定会到达设备。设备答复“不存在”就说明在线。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::watch;
use tokio::task::{spawn_blocking, JoinHandle};

pub const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// 在线时的探测周期。
const PROBE_EVERY: Duration = Duration::from_secs(30);
/// 刚失败时缩短间隔，尽快确认是否真的离线。
const PROBE_RETRY: Duration = Duration::from_secs(5);
const FAILURES_BEFORE_OFFLINE: u32 = 2;

/// 在线则返回 `true`。查一个新的、不存在的文件名，请求一定会到达设备。
fn probe_main(dir: &Path) -> bool {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    let name = format!(".cchub-probe-{}-{nonce}", std::process::id());
    match std::fs::symlink_metadata(dir.join(name)) {
        Ok(_) => true,
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    }
}

/// 还没退出的探测线程。断开的挂载可能让系统调用卡在内核里（D 状态），线程不能等也杀不掉；
/// 上一个没退出就不再启动新的，否则断网期间线程会越积越多。
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

/// 在独立线程里探测，最多等 [`PROBE_TIMEOUT`]；超时、线程起不来、上一次还卡着都算离线。
/// 超时后线程不回收也不等待，它自己结束时才从 `IN_FLIGHT` 移除。
pub fn probe(dir: &Path) -> bool {
    if !begin_probe(dir) {
        return false;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let target = dir.to_path_buf();
    let spawned = std::thread::Builder::new()
        .name("probe".into())
        .stack_size(128 * 1024)
        .spawn(move || {
            let online = probe_main(&target);
            end_probe(&target);
            let _ = tx.send(online);
        });
    if spawned.is_err() {
        end_probe(dir);
        return false;
    }
    rx.recv_timeout(PROBE_TIMEOUT).unwrap_or(false)
}

/// 每个项目目录一个共享探测：所有连接、所有会话订阅同一个结果，没有订阅者时任务自动结束。
#[derive(Default)]
pub struct Probes {
    shared: Mutex<HashMap<PathBuf, Weak<SharedProbe>>>,
}

struct SharedProbe {
    online: watch::Receiver<Option<bool>>,
    task: JoinHandle<()>,
}

impl Drop for SharedProbe {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// 订阅者。全部丢弃后探测任务随之结束。
pub struct Subscription {
    online: watch::Receiver<Option<bool>>,
    _shared: Arc<SharedProbe>,
}

impl Subscription {
    /// 当前已知状态；还没有结论（刚开始探测）时为 `None`。
    pub fn current(&mut self) -> Option<bool> {
        *self.online.borrow_and_update()
    }

    /// 等状态变化，返回新状态。
    pub async fn changed(&mut self) -> Option<bool> {
        if self.online.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
        self.current()
    }
}

impl Probes {
    /// 必须在 tokio 运行时里调用。
    pub fn subscribe(&self, dir: &Path) -> Subscription {
        let mut shared = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        shared.retain(|_, probe| probe.strong_count() > 0);
        let probe = match shared.get(dir).and_then(Weak::upgrade) {
            Some(probe) => probe,
            None => {
                let (tx, online) = watch::channel(None);
                let task = tokio::spawn(run_probe(dir.to_path_buf(), tx));
                let probe = Arc::new(SharedProbe { online, task });
                shared.insert(dir.to_path_buf(), Arc::downgrade(&probe));
                probe
            }
        };
        Subscription {
            online: probe.online.clone(),
            _shared: probe,
        }
    }
}

async fn run_probe(dir: PathBuf, state: watch::Sender<Option<bool>>) {
    let mut monitor = DeviceMonitor::default();
    loop {
        let target = dir.clone();
        let success = spawn_blocking(move || probe(&target))
            .await
            .unwrap_or(false);
        if let Some(online) = monitor.observe(success) {
            state.send_replace(Some(online));
        }
        tokio::time::sleep(if success { PROBE_EVERY } else { PROBE_RETRY }).await;
    }
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
        assert!(!probe(&dir));
        end_probe(&dir);
        assert!(probe(&dir));
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

    #[tokio::test(flavor = "current_thread")]
    async fn subscribers_share_one_probe_per_directory() {
        let probes = Probes::default();
        let dir = std::env::temp_dir();
        let mut first = probes.subscribe(&dir);
        let second = probes.subscribe(&dir);
        assert!(Arc::ptr_eq(&first._shared, &second._shared));
        assert_eq!(first.changed().await, Some(true));
        drop((first, second));
        let third = probes.subscribe(&dir);
        assert_eq!(probes.shared.lock().unwrap().len(), 1);
        drop(third);
    }
}
