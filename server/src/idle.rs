//! 空闲回收：这一轮已结束、没有后台任务、一段时间没有动静的会话，结束进程释放内存。
//! 下次发消息时客户端用 `--resume` 拉起，对话不丢。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::Duration;

use cchub_protocol::turn_finished;

use crate::ws::App;

/// 判定只看日志末尾，日志再大也不占内存。
const LOG_TAIL: u64 = 1024 * 1024;

/// 结束空闲会话的进程，返回被结束的会话 ID。`now` 是 Unix 秒。
pub fn reclaim(app: &App, idle: Duration, now: u64) -> Vec<String> {
    let mut stopped = Vec::new();
    for session in app.sessions.list(|id, dir| app.host.is_running(id, dir)) {
        if !session.running || !quiet_for(session.updated, session.active, now, idle) {
            continue;
        }
        let log = log_tail(&app.sessions.out_path(&session.id));
        if !log.is_some_and(|log| turn_finished(&log)) {
            continue;
        }
        if app
            .host
            .stop(&session.id, &app.sessions.dir(&session.id))
            .is_ok()
        {
            app.sessions.release(&session.id);
            stopped.push(session.id);
        }
    }
    stopped
}

/// 日志和用户发言都超过 `idle` 没有更新。日志时间未知时不回收。
fn quiet_for(updated: Option<u64>, active: Option<u64>, now: u64, idle: Duration) -> bool {
    let Some(updated) = updated else {
        return false;
    };
    let last = updated.max(active.unwrap_or(0));
    now.saturating_sub(last) >= idle.as_secs()
}

fn log_tail(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(length.saturating_sub(LOG_TAIL)))
        .ok()?;
    let mut bytes = Vec::new();
    file.take(LOG_TAIL).read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_only_when_log_and_user_both_idle() {
        let idle = Duration::from_secs(600);
        assert!(quiet_for(Some(1000), Some(900), 1600, idle));
        assert!(!quiet_for(Some(1000), Some(900), 1599, idle));
        assert!(!quiet_for(Some(1000), Some(1200), 1600, idle), "刚发过言");
        assert!(quiet_for(Some(1000), None, 1600, idle));
        assert!(!quiet_for(None, Some(0), 1600, idle), "日志时间未知");
    }

    #[test]
    fn reads_only_the_tail_of_the_log() {
        let dir = std::env::temp_dir().join(format!("hubd-idle-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out");
        let filler = "x".repeat(LOG_TAIL as usize);
        std::fs::write(&path, format!("{filler}\n{{\"type\":\"result\"}}\n")).unwrap();
        let log = log_tail(&path).unwrap();
        assert_eq!(log.len() as u64, LOG_TAIL);
        assert!(turn_finished(&log));
        assert!(log_tail(&dir.join("missing")).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
