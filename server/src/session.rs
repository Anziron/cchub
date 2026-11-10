//! 会话目录：`in` 是 FIFO，`out` 是事件日志，`err` 是 stderr。

use std::collections::HashMap;
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use cchub_protocol::SessionInfo;

/// 会话 ID 会拼进路径、unit 名和 shell 命令，只允许安全字符。
pub fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub struct Sessions {
    root: PathBuf,
    /// FIFO 的最后一个 fd 关闭时缓冲数据会丢，所以先打开并持有，再启动进程。
    inputs: Mutex<HashMap<String, Arc<Mutex<File>>>>,
}

impl Sessions {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            inputs: Mutex::new(HashMap::new()),
        }
    }

    pub fn dir(&self, session: &str) -> PathBuf {
        self.root.join(session)
    }

    /// 项目目录，记在会话目录里，`hubd` 重启后还能继续探测。
    pub fn cwd(&self, session: &str) -> Option<PathBuf> {
        fs::read_to_string(self.dir(session).join("cwd"))
            .ok()
            .map(PathBuf::from)
    }

    pub fn set_cwd(&self, session: &str, cwd: &Path) -> io::Result<()> {
        fs::write(self.dir(session).join("cwd"), cwd.as_os_str().as_bytes())
    }

    /// 关闭标记是会话目录里的空文件，手机端和桌面端看到的一致。
    pub fn set_archived(&self, session: &str, archived: bool) -> io::Result<()> {
        let path = self.dir(session).join("archived");
        match (archived, fs::remove_file(&path)) {
            (true, _) => fs::write(path, ""),
            (false, Err(error)) if error.kind() != io::ErrorKind::NotFound => Err(error),
            (false, _) => Ok(()),
        }
    }

    /// 用户发了言：更新 `active` 的修改时间。文件不存在就创建。
    pub fn touch_active(&self, session: &str) -> io::Result<()> {
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(self.dir(session).join("active"))?;
        file.set_modified(SystemTime::now())
    }

    pub fn set_title(&self, session: &str, title: &str) -> io::Result<()> {
        fs::write(self.dir(session).join("title"), title)
    }

    /// 列出自己建的会话目录，最近更新的在前。
    pub fn list(&self, is_running: impl Fn(&str, &Path) -> bool) -> Vec<SessionInfo> {
        let Ok(entries) = fs::read_dir(&self.root) else {
            return Vec::new();
        };
        let mut sessions: Vec<SessionInfo> = entries
            .flatten()
            .filter_map(|entry| {
                let id = entry
                    .file_name()
                    .to_str()
                    .filter(|n| valid_id(n))?
                    .to_string();
                let dir = entry.path();
                if !dir.join("in").exists() {
                    return None;
                }
                let updated = mtime_secs(&dir.join("out"));
                // 没发过言（或旧会话）就用会话创建时间，即 `cwd` 文件的修改时间。
                let active =
                    mtime_secs(&dir.join("active")).or_else(|| mtime_secs(&dir.join("cwd")));
                Some(SessionInfo {
                    title: fs::read_to_string(dir.join("title")).ok(),
                    cwd: fs::read_to_string(dir.join("cwd")).ok(),
                    running: is_running(&id, &dir),
                    updated,
                    active,
                    archived: dir.join("archived").exists(),
                    id,
                })
            })
            .collect();
        sessions.sort_by_key(|session| std::cmp::Reverse(session.updated));
        sessions
    }

    /// 清理进程已结束、很久没有更新的会话目录。这里只有运行日志，对话历史在 `claude` 的 `.jsonl` 里。
    pub fn prune(&self, max_age: Duration, is_running: impl Fn(&str, &Path) -> bool) -> usize {
        let Ok(entries) = fs::read_dir(&self.root) else {
            return 0;
        };
        let mut removed = 0;
        for entry in entries.flatten() {
            let dir = entry.path();
            let name = entry.file_name();
            let Some(session) = name.to_str().filter(|name| valid_id(name)) else {
                continue;
            };
            // 只碰自己建的目录。
            let age = fs::metadata(dir.join("out"))
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|time| time.elapsed().ok());
            if !dir.join("in").exists() || age.is_none_or(|age| age < max_age) {
                continue;
            }
            if !is_running(session, &dir) && fs::remove_dir_all(&dir).is_ok() {
                self.release(session);
                removed += 1;
            }
        }
        removed
    }

    pub fn out_path(&self, session: &str) -> PathBuf {
        self.dir(session).join("out")
    }

    /// 建好目录、FIFO 和日志，并开始持有 FIFO。可以重复调用。
    pub fn prepare(&self, session: &str) -> io::Result<()> {
        let dir = self.dir(session);
        fs::create_dir_all(&dir)?;
        let fifo = dir.join("in");
        if !fifo.exists() {
            mkfifo(&fifo)?;
        }
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("out"))?;
        self.input(session)?;
        Ok(())
    }

    /// 写一行到进程的 stdin。FIFO 写满时会阻塞，要放在阻塞线程池里调用。
    pub fn write_line(&self, session: &str, line: &str) -> io::Result<()> {
        if line.contains('\n') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "输入不能包含换行",
            ));
        }
        let input = self.input(session)?;
        let mut file = input.lock().unwrap_or_else(|e| e.into_inner());
        // 一次写完整行，超过 PIPE_BUF 的内容也不会和别的连接交错。
        file.write_all(format!("{line}\n").as_bytes())
    }

    pub fn release(&self, session: &str) {
        self.lock_inputs().remove(session);
    }

    fn input(&self, session: &str) -> io::Result<Arc<Mutex<File>>> {
        let mut inputs = self.lock_inputs();
        if let Some(input) = inputs.get(session) {
            return Ok(input.clone());
        }
        // 读写方式打开 FIFO 不会阻塞等对端。
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(self.dir(session).join("in"))?;
        let input = Arc::new(Mutex::new(file));
        inputs.insert(session.to_string(), input.clone());
        Ok(input)
    }

    fn lock_inputs(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Mutex<File>>>> {
        self.inputs.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn mtime_secs(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|age| age.as_secs())
}

fn mkfifo(path: &Path) -> io::Result<()> {
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "路径包含空字符"))?;
    // SAFETY: path 是有效的 C 字符串，调用期间一直存活。
    if unsafe { libc::mkfifo(path.as_ptr(), 0o600) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_rejects_shell_and_path_characters() {
        for bad in ["", "a b", "../x", "a;rm", "a/b", "$(x)", &"x".repeat(65)] {
            assert!(!valid_id(bad), "{bad}");
        }
        assert!(valid_id("Session_01-a"));
    }

    #[test]
    fn list_reports_own_sessions_newest_first() {
        let root = std::env::temp_dir().join(format!("hubd-list-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("not-ours")).unwrap();
        let sessions = Sessions::new(root.clone());
        sessions.prepare("a").unwrap();
        sessions.set_title("a", "修登录").unwrap();
        sessions.set_cwd("a", Path::new("/work")).unwrap();

        let list = sessions.list(|id, _| id == "a");

        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "a");
        assert_eq!(list[0].title.as_deref(), Some("修登录"));
        assert_eq!(list[0].cwd.as_deref(), Some("/work"));
        assert!(list[0].running);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn active_follows_user_input_and_falls_back_to_cwd_file() {
        let root = std::env::temp_dir().join(format!("hubd-active-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let sessions = Sessions::new(root.clone());
        sessions.prepare("a").unwrap();
        assert_eq!(sessions.list(|_, _| false)[0].active, None);

        sessions.set_cwd("a", Path::new("/work")).unwrap();
        let created = mtime_secs(&root.join("a/cwd"));
        assert!(created.is_some());
        assert_eq!(sessions.list(|_, _| false)[0].active, created);

        let old = SystemTime::now() - Duration::from_secs(3600);
        let file = File::create(root.join("a/cwd")).unwrap();
        file.set_modified(old).unwrap();
        sessions.touch_active("a").unwrap();
        sessions.touch_active("a").unwrap();
        let active = sessions.list(|_, _| false)[0].active.unwrap();
        assert!(active > old.duration_since(UNIX_EPOCH).unwrap().as_secs() + 3000);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn archived_flag_round_trips() {
        let root = std::env::temp_dir().join(format!("hubd-archive-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let sessions = Sessions::new(root.clone());
        sessions.prepare("a").unwrap();
        assert!(!sessions.list(|_, _| false)[0].archived);
        sessions.set_archived("a", true).unwrap();
        sessions.set_archived("a", true).unwrap();
        assert!(sessions.list(|_, _| false)[0].archived);
        sessions.set_archived("a", false).unwrap();
        sessions.set_archived("a", false).unwrap();
        assert!(!sessions.list(|_, _| false)[0].archived);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn prune_only_removes_old_stopped_sessions_it_created() {
        let root = std::env::temp_dir().join(format!("hubd-prune-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("not-ours")).unwrap();
        fs::write(root.join("not-ours/out"), "").unwrap();
        let sessions = Sessions::new(root.clone());
        sessions.prepare("stopped").unwrap();
        sessions.prepare("running").unwrap();

        assert_eq!(sessions.prune(Duration::from_secs(3600), |_, _| false), 0);
        let removed = sessions.prune(Duration::ZERO, |id, _| id == "running");

        assert_eq!(removed, 1);
        assert!(!root.join("stopped").exists());
        assert!(root.join("running").exists());
        assert!(root.join("not-ours").exists());
        fs::remove_dir_all(&root).unwrap();
    }
}
