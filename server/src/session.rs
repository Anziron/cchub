//! 会话目录：`in` 是 FIFO，`out` 是事件日志，`err` 是 stderr。

use std::collections::HashMap;
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

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
}
