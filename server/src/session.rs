//! 会话目录：`in` 是 FIFO，`out` 是事件日志，`err` 是 stderr。

use std::collections::HashMap;
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use cchub_protocol::{AckError, Dedupe, SessionInfo};

/// 把输入 FIFO 放大到这么大（Linux 普通用户的默认上限），能整行写入的输入更长。
const PIPE_SIZE: libc::c_int = 1024 * 1024;
/// 管道按页存放，读到一半和写到一半的页各占一整页：估算剩余空间时扣掉。
const PIPE_SLACK: usize = 2 * 4096;
/// 写不进去时多久再看一次。
const WRITE_POLL: Duration = Duration::from_millis(20);

/// 会话的输入 FIFO 已由 `Sessions` 打开并持有的凭证，只有 [`Sessions::hold`] 能造出来。
/// 启动进程（`ProcessHost::start`）要它：FIFO 的最后一个写端关闭时缓冲里的数据会丢，
/// 必须先打开并持有、再启动进程。这个顺序由类型保证，不靠代码的先后。
pub struct HeldInput(());

/// 一条输入的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Written {
    /// 这次完整写进了 FIFO。
    Fresh,
    /// 同一个 `id` 之前已经写过，这次没有再写。
    Duplicate,
}

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
    /// 每个会话最近写入过的输入 `id`。claude 进程结束（`release`）后仍保留，
    /// 免得重连补发时把已经交给旧进程的输入再写一遍；`hubd` 重启就清空（见 `uplink.rs` 开头）。
    written: Mutex<HashMap<String, Dedupe>>,
}

impl Sessions {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            inputs: Mutex::new(HashMap::new()),
            written: Mutex::new(HashMap::new()),
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

    /// 所有会话的 ID 和目录：目录名是合法 ID、建好了输入 FIFO 的。
    pub fn entries(&self) -> Vec<(String, PathBuf)> {
        let Ok(entries) = fs::read_dir(&self.root) else {
            return Vec::new();
        };
        entries
            .flatten()
            .filter_map(|entry| {
                let id = entry
                    .file_name()
                    .to_str()
                    .filter(|n| valid_id(n))?
                    .to_string();
                let dir = entry.path();
                dir.join("in").exists().then_some((id, dir))
            })
            .collect()
    }

    /// 列出自己建的会话目录，最近更新的在前。
    pub fn list(&self, is_running: impl Fn(&str, &Path) -> bool) -> Vec<SessionInfo> {
        let mut sessions: Vec<SessionInfo> = self
            .entries()
            .into_iter()
            .map(|(id, dir)| {
                let updated = mtime_secs(&dir.join("out"));
                // 没发过言（或旧会话）就用会话创建时间，即 `cwd` 文件的修改时间。
                let active =
                    mtime_secs(&dir.join("active")).or_else(|| mtime_secs(&dir.join("cwd")));
                SessionInfo {
                    title: fs::read_to_string(dir.join("title")).ok(),
                    cwd: fs::read_to_string(dir.join("cwd")).ok(),
                    running: is_running(&id, &dir),
                    updated,
                    active,
                    archived: dir.join("archived").exists(),
                    id,
                }
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
                self.lock_written().remove(session);
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
        self.hold(session)?;
        Ok(())
    }

    /// 打开（已打开就复用）并持有会话的输入 FIFO。启动进程前调用，凭证交给 `ProcessHost::start`。
    pub fn hold(&self, session: &str) -> io::Result<HeldInput> {
        self.input(session)?;
        Ok(HeldInput(()))
    }

    /// 写一行到进程的 stdin，每个 `id` 最多写一次。进程不在不写；FIFO 剩余空间放得下整行才写，
    /// 等 `timeout` 还放不下就放弃，所以不会留下半行。会等待，要放在阻塞线程池里调用。
    pub fn write_input(
        &self,
        session: &str,
        id: &str,
        line: &str,
        timeout: Duration,
        is_running: impl FnOnce() -> bool,
    ) -> Result<Written, AckError> {
        if line.contains('\n') {
            return Err(AckError::Invalid);
        }
        // 同一会话的写入都在这把锁里，查重、写入、记下 `id` 之间不会插进别的连接的同一条输入。
        let input = self.input(session).map_err(|_| AckError::NotRunning)?;
        let mut file = input.lock().unwrap_or_else(|e| e.into_inner());
        if self
            .lock_written()
            .get(session)
            .is_some_and(|ids| ids.contains(id))
        {
            return Ok(Written::Duplicate);
        }
        if !is_running() {
            return Err(AckError::NotRunning);
        }
        write_whole(&mut file, format!("{line}\n").as_bytes(), timeout)?;
        self.lock_written()
            .entry(session.to_string())
            .or_default()
            .insert(id);
        Ok(Written::Fresh)
    }

    pub fn release(&self, session: &str) {
        self.lock_inputs().remove(session);
    }

    fn input(&self, session: &str) -> io::Result<Arc<Mutex<File>>> {
        let mut inputs = self.lock_inputs();
        if let Some(input) = inputs.get(session) {
            return Ok(input.clone());
        }
        // 读写方式打开 FIFO 不会阻塞等对端。非阻塞只影响 hubd 这一端，进程有自己打开的文件描述。
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(self.dir(session).join("in"))?;
        // SAFETY: fd 在 file 存活期间有效；失败只是管道保持默认大小。
        unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETPIPE_SZ, PIPE_SIZE) };
        let input = Arc::new(Mutex::new(file));
        inputs.insert(session.to_string(), input.clone());
        Ok(input)
    }

    fn lock_written(&self) -> std::sync::MutexGuard<'_, HashMap<String, Dedupe>> {
        self.written.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock_inputs(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Mutex<File>>>> {
        self.inputs.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// 等管道剩余空间放得下整行再写。FIFO 只有 hubd 在写（同一把锁），空间只会被进程读走而变大，
/// 所以开始写之后一定能写完。
fn write_whole(file: &mut File, bytes: &[u8], timeout: Duration) -> Result<(), AckError> {
    let fd = file.as_raw_fd();
    // SAFETY: fd 有效；返回值小于 0 表示查询失败。
    let capacity = unsafe { libc::fcntl(fd, libc::F_GETPIPE_SZ) };
    let capacity = usize::try_from(capacity).unwrap_or(64 * 1024);
    let usable = capacity.saturating_sub(PIPE_SLACK);
    if bytes.len() > usable {
        return Err(AckError::Invalid);
    }
    let deadline = Instant::now() + timeout;
    loop {
        let mut queued: libc::c_int = 0;
        // SAFETY: FIONREAD 往 queued 里写一个 int。
        let queued = if unsafe { libc::ioctl(fd, libc::FIONREAD, &mut queued) } == 0 {
            usize::try_from(queued).unwrap_or(usable)
        } else {
            usable
        };
        if usable.saturating_sub(queued) >= bytes.len() {
            break;
        }
        if Instant::now() >= deadline {
            return Err(AckError::Stalled);
        }
        std::thread::sleep(WRITE_POLL);
    }
    let mut rest = bytes;
    while !rest.is_empty() {
        match file.write(rest) {
            Ok(count) => rest = &rest[count..],
            // 估算偏乐观时可能先写进一部分：已经开了头，就等进程读走后写完，不留半行。
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(WRITE_POLL)
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return Err(AckError::Stalled),
        }
    }
    Ok(())
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

    /// 读出 FIFO 里现有的全部内容（hubd 自己持有读写端，不会读到 EOF）。
    fn drain(root: &Path, session: &str) -> Vec<u8> {
        use std::io::Read;
        let mut fifo = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(root.join(session).join("in"))
            .unwrap();
        let mut data = Vec::new();
        let mut buffer = vec![0; 64 * 1024];
        loop {
            match fifo.read(&mut buffer) {
                Ok(0) => return data,
                Ok(count) => data.extend_from_slice(&buffer[..count]),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return data,
                Err(error) => panic!("{error}"),
            }
        }
    }

    #[test]
    fn write_input_writes_each_id_once_and_only_while_running() {
        let root = std::env::temp_dir().join(format!("hubd-input-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let sessions = Sessions::new(root.clone());
        sessions.prepare("a").unwrap();
        let wait = Duration::from_millis(50);
        let write = |id: &str, line: &str, running: bool| {
            sessions.write_input("a", id, line, wait, || running)
        };

        assert_eq!(write("1", "x", false), Err(AckError::NotRunning));
        assert_eq!(write("1", "x", true), Ok(Written::Fresh));
        assert_eq!(write("1", "x", true), Ok(Written::Duplicate));
        // 已经写过的重发，即使进程已结束也照常回执成功。
        assert_eq!(write("1", "x", false), Ok(Written::Duplicate));
        assert_eq!(write("2", "a\nb", true), Err(AckError::Invalid));
        assert_eq!(drain(&root, "a"), b"x\n");
        // 进程结束后输入句柄被释放，记录的 id 仍在。
        sessions.release("a");
        assert_eq!(write("1", "x", true), Ok(Written::Duplicate));
        assert_eq!(write("3", "y", true), Ok(Written::Fresh));
        assert_eq!(drain(&root, "a"), b"y\n");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn write_input_never_leaves_half_a_line() {
        let root = std::env::temp_dir().join(format!("hubd-stall-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let sessions = Sessions::new(root.clone());
        sessions.prepare("a").unwrap();
        let wait = Duration::from_millis(50);
        let line = "z".repeat(60 * 1024);
        // 没人读：写到放不下为止，之后的都回 `stalled`。
        let mut written = 0;
        let stalled = loop {
            match sessions.write_input("a", &written.to_string(), &line, wait, || true) {
                Ok(_) => written += 1,
                Err(error) => break error,
            }
            assert!(written < 1000, "管道没有上限");
        };
        assert_eq!(stalled, AckError::Stalled);
        assert!(written > 0);
        let huge = "z".repeat(4 * 1024 * 1024);
        assert_eq!(
            sessions.write_input("a", "huge", &huge, wait, || true),
            Err(AckError::Invalid)
        );

        let data = drain(&root, "a");
        assert_eq!(data.len(), written * (line.len() + 1), "只有完整的行");
        assert!(data.ends_with(b"z\n"));
        // 读走之后，被拒的那条可以用同一个 id 重新写入。
        let id = written.to_string();
        assert_eq!(
            sessions.write_input("a", &id, &line, wait, || true),
            Ok(Written::Fresh)
        );
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
