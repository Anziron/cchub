//! 本机缓存打开过的会话内容：重启、刷新网页、从托盘重开后，先显示本机已有的部分，再从缓存末尾向 `hubd` 续订。
//!
//! 布局：`<根>/<服务器地址转成的文件名>/<会话 ID>`，每会话一个文件。第一行是头 `cchub-cache\t<格式版本>\t<origin>`，
//! `origin` 是 `hubd` 报的日志身份（见 `ServerMsg::Attached`）。之后每行一条不可跳过的事件：
//! `<from>\t<seq>\t<next>\t<class>\t<原文>`。`[seq, next)` 是它在 `out` 里的位置；`from` 是上一条的 `next`
//! （第一条是 0），`[from, seq)` 里只有可跳过的逐字片段，没有存。
//!
//! 不能漏：续订的位置就是最后一条完整、接得上的行的 `next`，不另存“末尾偏移”。读到写了一半、解析不了或
//! `from` 接不上的行，就从那里截断，后面的由 `hubd` 重发。写入时逐条核对事件接着上一条（含没存的片段），
//! 对不上就不再写这个会话，已写的部分仍然有效。
//!
//! 写入方只有连接循环；设置里的清空、搬家经同一把锁，不会和写入交错。

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

use cchub_protocol::EventClass;

const MAGIC: &str = "cchub-cache";
/// 行格式的版本：改了格式就加一，不认识的旧文件整份删掉重下。
const FORMAT: &str = "1";
/// 默认的总量上限（设置里可改）：超了先删最久没打开的会话。
pub const DEFAULT_LIMIT: u64 = 2 << 30;
/// 选了非空文件夹时，缓存放进它下面的这个子文件夹，不和别的文件混在一起。
const SUBFOLDER: &str = "cchub-cache";

/// 缓存里的一条事件。
#[derive(Debug, Clone, Copy)]
pub struct Record<'a> {
    pub seq: u64,
    pub next: u64,
    pub class: EventClass,
    pub payload: &'a str,
}

/// 核对过的一个会话的缓存。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opened {
    /// 缓存属于哪一份日志，要和 `hubd` 的 `Attached.origin` 一致才接得上。
    pub origin: String,
    /// 续订位置：最后一条好行的 `next`。
    pub end: u64,
    /// 头加所有好行的字节数。
    len: u64,
}

/// 所有服务器共用的缓存根目录；克隆出来的是同一份。
#[derive(Clone)]
pub struct Cache(Arc<Mutex<Store>>);

struct Store {
    root: PathBuf,
    limit: u64,
    /// 正在写的会话：服务器目录名 → 会话 ID → 写入状态。
    writers: HashMap<String, HashMap<String, Writer>>,
}

struct Writer {
    file: File,
    /// `[0, covered)` 已经核对过：其中不可跳过的事件都在文件或 `pending` 里。
    covered: u64,
    /// 最后存下的一条的 `next`，也是下一条的 `from`。
    last: u64,
    /// 攒着、还没写进文件的行。
    pending: Vec<u8>,
}

impl Writer {
    fn new(file: File, end: u64) -> Self {
        Self {
            file,
            covered: end,
            last: end,
            pending: Vec::new(),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        if !self.pending.is_empty() {
            self.file.write_all(&self.pending)?;
            self.pending.clear();
        }
        Ok(())
    }
}

impl Cache {
    pub fn new(root: PathBuf) -> Self {
        Self::with_limit(root, DEFAULT_LIMIT)
    }

    fn with_limit(root: PathBuf, limit: u64) -> Self {
        Self(Arc::new(Mutex::new(Store {
            root,
            limit,
            writers: HashMap::new(),
        })))
    }

    /// 某个服务器的缓存（每个服务器一个子目录）。
    pub fn server(&self, url: &str) -> ServerCache {
        ServerCache {
            cache: self.clone(),
            dir: dir_name(url),
        }
    }

    pub fn root(&self) -> PathBuf {
        self.lock().root.clone()
    }

    pub fn limit(&self) -> u64 {
        self.lock().limit
    }

    /// 改总量上限，调低了马上按最久没打开的先删。
    pub fn set_limit(&self, limit: u64) {
        let mut store = self.lock();
        store.limit = limit;
        store.evict();
    }

    /// 占用的字节数。
    pub fn usage(&self) -> u64 {
        entries(&self.lock().root).iter().map(|e| e.len).sum()
    }

    /// 删掉全部缓存。正在写的会话也不再写，下次打开时从头下载。
    pub fn clear(&self) -> io::Result<()> {
        let mut store = self.lock();
        store.writers.clear();
        let mut failed = None;
        for entry in entries(&store.root) {
            if let Err(error) = fs::remove_file(&entry.path) {
                failed.get_or_insert(error);
            }
        }
        remove_empty_dirs(&store.root);
        failed.map_or(Ok(()), Err)
    }

    /// 搬到 `to`：先复制，再切换，最后删旧的；中途失败时原位置不动，新位置复制了一半的删掉。
    /// `to` 要么还不存在，要么是空文件夹：清空和淘汰会删根目录下的文件，不能和别人的文件混在一起。
    pub fn relocate(&self, to: &Path) -> Result<(), String> {
        self.relocate_with(to, |from, to| fs::copy(from, to).map(drop))
    }

    /// 搬到用户在文件夹选择框里选的 `chosen`：空的（或还不存在）直接用，里面有别的文件就放进
    /// 它下面的 `cchub-cache`。选的就是现在的位置时不动。
    pub fn relocate_into(&self, chosen: &Path) -> Result<(), String> {
        let empty = match fs::read_dir(chosen) {
            Ok(mut entries) => entries.next().is_none(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => true,
            Err(error) => return Err(format!("打不开这个文件夹：{error}")),
        };
        if empty || chosen == self.root() {
            self.relocate(chosen)
        } else {
            self.relocate(&chosen.join(SUBFOLDER))
        }
    }

    fn relocate_with(
        &self,
        to: &Path,
        copy: impl Fn(&Path, &Path) -> io::Result<()>,
    ) -> Result<(), String> {
        if !to.is_absolute() {
            return Err("请填完整的路径".to_string());
        }
        let mut store = self.lock();
        if to == store.root {
            return Ok(());
        }
        if to.starts_with(&store.root) {
            return Err("不能放在现在的缓存文件夹里面".to_string());
        }
        let existed = match fs::read_dir(to) {
            Ok(mut entries) => {
                if entries.next().is_some() {
                    return Err(
                        "新位置里已有别的文件，请换一个空文件夹或还不存在的路径".to_string()
                    );
                }
                true
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(error) => return Err(format!("打不开新位置：{error}")),
        };
        // 攒着的先落盘，复制过去的才是全的。
        store.flush_all();
        let old = store.root.clone();
        let files = entries(&old);
        let mut copied = Vec::new();
        let result = (|| {
            fs::create_dir_all(to)?;
            for entry in &files {
                let dir = to.join(&entry.dir);
                fs::create_dir_all(&dir)?;
                let target = dir.join(&entry.session);
                copy(&entry.path, &target)?;
                copied.push(target);
            }
            io::Result::Ok(())
        })();
        if let Err(error) = result {
            for path in &copied {
                let _ = fs::remove_file(path);
            }
            remove_empty_dirs(to);
            if !existed {
                let _ = fs::remove_dir(to);
            }
            return Err(format!("复制失败，缓存仍在原位置：{error}"));
        }
        store.root = to.to_path_buf();
        // 正在写的会话改到新位置接着写；打不开的就不再写。
        let root = store.root.clone();
        for (dir, writers) in store.writers.iter_mut() {
            writers.retain(|session, writer| {
                let reopened = OpenOptions::new()
                    .write(true)
                    .open(root.join(dir).join(session))
                    .and_then(|mut file| file.seek(SeekFrom::End(0)).map(|_| file));
                match reopened {
                    Ok(file) => {
                        writer.file = file;
                        true
                    }
                    Err(_) => false,
                }
            });
        }
        // 最后删旧的；删不掉的留在原处，不影响新位置。
        for entry in &files {
            let _ = fs::remove_file(&entry.path);
        }
        remove_empty_dirs(&old);
        let _ = fs::remove_dir(&old);
        Ok(())
    }

    fn lock(&self) -> MutexGuard<'_, Store> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Store {
    fn path(&self, dir: &str, session: &str) -> PathBuf {
        self.root.join(dir).join(session)
    }

    fn writer(&mut self, dir: &str, session: &str) -> Option<&mut Writer> {
        self.writers.get_mut(dir)?.get_mut(session)
    }

    fn take_writer(&mut self, dir: &str, session: &str) -> Option<Writer> {
        self.writers.get_mut(dir)?.remove(session)
    }

    fn put_writer(&mut self, dir: &str, session: &str, writer: Writer) {
        self.writers
            .entry(dir.to_string())
            .or_default()
            .insert(session.to_string(), writer);
    }

    /// 不再写这个会话：攒着的行是核对过的，先写进去；写不进去就整份删掉。
    fn stop(&mut self, dir: &str, session: &str) {
        if let Some(mut writer) = self.take_writer(dir, session) {
            if writer.flush().is_err() {
                let _ = fs::remove_file(self.path(dir, session));
            }
        }
    }

    fn flush_all(&mut self) {
        let dirs: Vec<String> = self.writers.keys().cloned().collect();
        for dir in dirs {
            self.flush_dir(&dir);
        }
    }

    /// 写失败（磁盘满、没权限）的会话删掉缓存、不再写它，显示不受影响。
    fn flush_dir(&mut self, dir: &str) {
        let Some(writers) = self.writers.get_mut(dir) else {
            return;
        };
        let mut failed = Vec::new();
        for (session, writer) in writers.iter_mut() {
            if writer.flush().is_err() {
                failed.push(session.clone());
            }
        }
        for session in failed {
            writers.remove(&session);
            let _ = fs::remove_file(self.root.join(dir).join(&session));
        }
    }

    /// 超过上限时先删最久没打开（也没写）的会话；正在打开、写入的不删。
    fn evict(&mut self) {
        let mut files = entries(&self.root);
        let mut total: u64 = files.iter().map(|e| e.len).sum();
        if total <= self.limit {
            return;
        }
        files.sort_by_key(|e| e.modified);
        for entry in files {
            if total <= self.limit {
                break;
            }
            let open = self
                .writers
                .get(&entry.dir)
                .is_some_and(|w| w.contains_key(&entry.session));
            if !open && fs::remove_file(&entry.path).is_ok() {
                total -= entry.len;
            }
        }
    }
}

/// 一个服务器的会话缓存。
#[derive(Clone)]
pub struct ServerCache {
    cache: Cache,
    dir: String,
}

impl ServerCache {
    /// 核对一个会话的缓存：没有、头不认识（格式版本变了、文件坏了）返回 `None`，不认识的整份删掉；
    /// 坏行处截断；记下打开时间（超额时先删最久没打开的）；准备好从末尾接着写，真正写要等调用方 `push`。
    pub fn open(&self, session: &str) -> Option<Opened> {
        if !valid_session(session) {
            return None;
        }
        let mut store = self.cache.lock();
        // 上一次订阅还在写：先落盘，核对的才是全的。
        store.stop(&self.dir, session);
        let path = store.path(&self.dir, session);
        let mut file = OpenOptions::new().read(true).write(true).open(&path).ok()?;
        let Some(opened) = scan(&file, |_| {}) else {
            drop(file);
            let _ = fs::remove_file(&path);
            return None;
        };
        // 从坏行处截断，之后接着写的才接得上；截不掉就不再写它，好的部分照样能用。
        let ready = file
            .set_len(opened.len)
            .and_then(|()| file.seek(SeekFrom::Start(opened.len)))
            .is_ok();
        let _ = file.set_modified(SystemTime::now());
        if ready {
            store.put_writer(&self.dir, session, Writer::new(file, opened.end));
        }
        store.evict();
        Some(opened)
    }

    /// 把 `open` 核对过的部分逐条交给 `on_record`（期间持有锁，回调里不能再调缓存）。返回回放到的位置：
    /// 一般就是 `opened.end`，中间被清空等情况下更小。
    pub fn replay(&self, session: &str, opened: &Opened, on_record: impl FnMut(Record<'_>)) -> u64 {
        let store = self.cache.lock();
        let Ok(file) = File::open(store.path(&self.dir, session)) else {
            return 0;
        };
        scan(file.take(opened.len), on_record).map_or(0, |read| read.end)
    }

    /// 从头建一个会话的缓存（已有的清掉），之后 `push` 的事件从偏移 0 起接着写。
    pub fn create(&self, session: &str, origin: &str) {
        if !valid_session(session) || origin.is_empty() || origin.contains(['\t', '\n']) {
            return;
        }
        let mut store = self.cache.lock();
        store.take_writer(&self.dir, session);
        let path = store.path(&self.dir, session);
        let created = path
            .parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|()| {
                let mut file = File::create(&path)?;
                file.write_all(format!("{MAGIC}\t{FORMAT}\t{origin}\n").as_bytes())?;
                Ok(file)
            });
        match created {
            Ok(file) => store.put_writer(&self.dir, session, Writer::new(file, 0)),
            Err(_) => {
                let _ = fs::remove_file(&path);
            }
        }
        store.evict();
    }

    /// 订阅里的一条事件，按到达顺序调用：不可跳过的存下来，逐字片段只推进位置。
    pub fn push(&self, session: &str, seq: u64, next: u64, class: EventClass, payload: &str) {
        let keep = (class != EventClass::Partial).then_some((class, payload));
        self.advance(session, seq, next, keep);
    }

    /// `hubd` 跳过了 `[seq, next)`（里面只有逐字片段）。
    pub fn skip(&self, session: &str, seq: u64, next: u64) {
        self.advance(session, seq, next, None);
    }

    fn advance(&self, session: &str, seq: u64, next: u64, keep: Option<(EventClass, &str)>) {
        let mut store = self.cache.lock();
        let Some(writer) = store.writer(&self.dir, session) else {
            return;
        };
        let storable =
            keep.is_none_or(|(_, payload)| !payload.is_empty() && !payload.contains('\n'));
        if seq != writer.covered || next <= seq || !storable {
            // 漏了一段或这行存不下（不该发生）：已写的仍然有效，只是不再接着写。
            store.stop(&self.dir, session);
            return;
        }
        writer.covered = next;
        if let Some((class, payload)) = keep {
            let from = writer.last;
            let class = class_name(class);
            let _ = writeln!(writer.pending, "{from}\t{seq}\t{next}\t{class}\t{payload}");
            writer.last = next;
        }
    }

    /// 攒着的写进磁盘，每收完一批消息调一次。写失败（磁盘满、没权限）就删掉那个会话的缓存、不再写它。
    pub fn flush(&self) {
        self.cache.lock().flush_dir(&self.dir);
    }

    /// 删掉一个会话的缓存（接不上服务器上的日志时）。
    pub fn remove(&self, session: &str) {
        if !valid_session(session) {
            return;
        }
        let mut store = self.cache.lock();
        store.take_writer(&self.dir, session);
        let _ = fs::remove_file(store.path(&self.dir, session));
    }

    /// 只留服务器会话列表里还有的（`listed` 为真）；正在打开、写入的也留着。其余的已被服务器清理，删掉。
    pub fn retain(&self, listed: impl Fn(&str) -> bool) {
        let store = self.cache.lock();
        let open = store.writers.get(&self.dir);
        let Ok(files) = fs::read_dir(store.root.join(&self.dir)) else {
            return;
        };
        for file in files.flatten() {
            let name = file.file_name();
            let Some(session) = name.to_str().filter(|n| valid_session(n)) else {
                continue;
            };
            if !listed(session) && !open.is_some_and(|w| w.contains_key(session)) {
                let _ = fs::remove_file(file.path());
            }
        }
    }
}

/// 逐行核对：先是头，再是一条条接得上的事件，遇到第一条坏行就停。头不认识返回 `None`。
fn scan(reader: impl Read, mut on_record: impl FnMut(Record<'_>)) -> Option<Opened> {
    let mut reader = BufReader::with_capacity(64 * 1024, reader);
    let mut line = Vec::new();
    reader.read_until(b'\n', &mut line).ok()?;
    let origin = header(&line)?.to_string();
    let mut opened = Opened {
        origin,
        end: 0,
        len: line.len() as u64,
    };
    loop {
        line.clear();
        if !matches!(reader.read_until(b'\n', &mut line), Ok(n) if n > 0) {
            break;
        }
        let Some(record) = record(&line, opened.end) else {
            break;
        };
        let next = record.next;
        on_record(record);
        opened.end = next;
        opened.len += line.len() as u64;
    }
    Some(opened)
}

fn header(line: &[u8]) -> Option<&str> {
    let text = std::str::from_utf8(line.strip_suffix(b"\n")?).ok()?;
    let mut fields = text.split('\t');
    let (magic, format, origin) = (fields.next()?, fields.next()?, fields.next()?);
    let known = magic == MAGIC && format == FORMAT && !origin.is_empty();
    (known && fields.next().is_none()).then_some(origin)
}

/// 一行事件，`from` 必须等于上一条的 `next`。写了一半（没有换行）、字段不对的返回 `None`。
fn record(line: &[u8], from: u64) -> Option<Record<'_>> {
    let text = std::str::from_utf8(line.strip_suffix(b"\n")?).ok()?;
    let mut fields = text.splitn(5, '\t');
    let start: u64 = fields.next()?.parse().ok()?;
    let seq: u64 = fields.next()?.parse().ok()?;
    let next: u64 = fields.next()?.parse().ok()?;
    let class = class_from(fields.next()?)?;
    let payload = fields.next()?;
    let fits = start == from && seq >= start && next > seq && !payload.is_empty();
    fits.then_some(Record {
        seq,
        next,
        class,
        payload,
    })
}

fn class_name(class: EventClass) -> &'static str {
    match class {
        EventClass::Partial => "partial",
        EventClass::Durable => "durable",
        EventClass::Approval => "approval",
        EventClass::Question => "question",
    }
}

/// 逐字片段从不存，读到就是坏行。
fn class_from(name: &str) -> Option<EventClass> {
    match name {
        "durable" => Some(EventClass::Durable),
        "approval" => Some(EventClass::Approval),
        "question" => Some(EventClass::Question),
        _ => None,
    }
}

/// 根目录下的会话文件 `<根>/<服务器>/<会话 ID>`；名字不像会话 ID 的不算，也不碰。
struct Entry {
    path: PathBuf,
    dir: String,
    session: String,
    len: u64,
    modified: SystemTime,
}

fn entries(root: &Path) -> Vec<Entry> {
    let mut found = Vec::new();
    let Ok(dirs) = fs::read_dir(root) else {
        return found;
    };
    for dir in dirs.flatten() {
        let Some(name) = dir.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Ok(files) = fs::read_dir(dir.path()) else {
            continue;
        };
        for file in files.flatten() {
            let file_name = file.file_name();
            let Some(session) = file_name.to_str().filter(|n| valid_session(n)) else {
                continue;
            };
            // 不用目录项里的大小：Windows 上文件还开着写入时它不更新（一直是 0）。
            let Ok(meta) = fs::metadata(file.path()) else {
                continue;
            };
            if meta.is_file() {
                found.push(Entry {
                    path: file.path(),
                    dir: name.clone(),
                    session: session.to_string(),
                    len: meta.len(),
                    modified: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                });
            }
        }
    }
    found
}

/// 删掉根目录下已经空了的服务器目录。
fn remove_empty_dirs(root: &Path) {
    let Ok(dirs) = fs::read_dir(root) else {
        return;
    };
    for dir in dirs.flatten() {
        let _ = fs::remove_dir(dir.path());
    }
}

/// 服务器地址转成目录名：字母、数字、`-`、`_`、`.` 原样保留，其他字节写成 `%XX`，不同地址不会撞名。
/// 不用哈希：`DefaultHasher` 换个 Rust 版本结果就会变，旧缓存就找不到了。
fn dir_name(url: &str) -> String {
    let mut name = String::with_capacity(url.len());
    for byte in url.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.') {
            name.push(char::from(byte));
        } else {
            name.push_str(&format!("%{byte:02X}"));
        }
    }
    // Windows 不许文件名以点结尾；空地址也要有个名字（`%` 本身会被转成 `%25`，不会撞）。
    if name.ends_with('.') {
        name.pop();
        name.push_str("%2E");
    }
    if name.is_empty() {
        name.push('%');
    }
    name
}

/// 会话 ID 当文件名用：规则和 `hubd` 的一样（1～64 个字母、数字、`-`、`_`），拼不出别的路径。
fn valid_session(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use cchub_protocol::EventClass::{Approval, Durable, Partial, Question};
    use std::time::{Duration, SystemTime};

    const URL: &str = "ws://100.64.0.1:7878/ws";
    const INIT: &str = r#"{"type":"system","subtype":"init"}"#;
    const ASK: &str = r#"{"type":"control_request","request":{"subtype":"can_use_tool"}}"#;
    const TEXT: &str = r#"{"type":"assistant","message":{"content":"你好	tab"}}"#;
    const PIECE: &str = r#"{"type":"stream_event"}"#;

    /// 测试用的临时目录，结束时删掉。
    struct Temp(PathBuf);

    impl Temp {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("cchub-cache-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    type Row = (u64, u64, EventClass, String);

    /// 像连接循环一样打开并回放，返回打开结果和回放出的事件。
    fn load(server: &ServerCache, session: &str) -> (Option<Opened>, Vec<Row>) {
        let Some(opened) = server.open(session) else {
            return (None, Vec::new());
        };
        let mut rows = Vec::new();
        let end = server.replay(session, &opened, |r| {
            rows.push((r.seq, r.next, r.class, r.payload.to_string()))
        });
        assert_eq!(end, opened.end, "回放到的位置和打开时核对的一致");
        (Some(opened), rows)
    }

    fn row(seq: u64, next: u64, class: EventClass, payload: &str) -> Row {
        (seq, next, class, payload.to_string())
    }

    fn file(root: &Path, session: &str) -> PathBuf {
        root.join(dir_name(URL)).join(session)
    }

    /// 三条事件：0..10 init，10..20 片段（不存），20..30 被跳过，30..45 审批。
    fn three(server: &ServerCache, session: &str) {
        server.create(session, "ino-1");
        server.push(session, 0, 10, Durable, INIT);
        server.push(session, 10, 20, Partial, PIECE);
        server.skip(session, 20, 30);
        server.push(session, 30, 45, Approval, ASK);
        server.flush();
    }

    /// s1、s2、s3 各写三条，写完释放实例（关掉文件），像上次运行留下的缓存。
    fn three_sessions(temp: &Temp) {
        let server = Cache::new(temp.0.clone()).server(URL);
        for session in ["s1", "s2", "s3"] {
            three(&server, session);
        }
    }

    #[test]
    fn round_trip_keeps_durable_events_and_resumes_after_the_last() {
        let temp = Temp::new("round");
        let server = Cache::new(temp.0.clone()).server(URL);
        three(&server, "s1");
        // 末尾的片段不存：续订位置停在最后一条存下的事件后面，片段由 hubd 重发。
        server.push("s1", 45, 50, Partial, PIECE);
        server.flush();

        let (opened, rows) = load(&server, "s1");
        let opened = opened.unwrap();
        assert_eq!((opened.origin.as_str(), opened.end), ("ino-1", 45));
        assert_eq!(
            rows,
            vec![row(0, 10, Durable, INIT), row(30, 45, Approval, ASK)]
        );
    }

    #[test]
    fn reopened_cache_keeps_appending_where_it_ended() {
        let temp = Temp::new("append");
        let cache = Cache::new(temp.0.clone());
        let server = cache.server(URL);
        three(&server, "s1");

        // 重启后：新的 Cache 打开旧文件，接着写。
        let server = Cache::new(temp.0.clone()).server(URL);
        let (opened, _) = load(&server, "s1");
        assert_eq!(opened.unwrap().end, 45);
        server.push("s1", 45, 60, Question, TEXT);
        server.flush();

        let (opened, rows) = load(&Cache::new(temp.0.clone()).server(URL), "s1");
        assert_eq!(opened.unwrap().end, 60);
        assert_eq!(
            rows,
            vec![
                row(0, 10, Durable, INIT),
                row(30, 45, Approval, ASK),
                row(45, 60, Question, TEXT)
            ]
        );
    }

    #[test]
    fn half_written_last_line_is_cut_off_and_refetched() {
        let temp = Temp::new("torn");
        let server = Cache::new(temp.0.clone()).server(URL);
        three(&server, "s1");
        let path = file(&temp.0, "s1");
        let whole = fs::metadata(&path).unwrap().len();
        // 写到一半进程没了：最后一行没有换行。
        let mut torn = OpenOptions::new().append(true).open(&path).unwrap();
        torn.write_all(b"45\t45\t60\tdurable\t{\"type\":\"assi")
            .unwrap();
        drop(torn);

        let server = Cache::new(temp.0.clone()).server(URL);
        let (opened, rows) = load(&server, "s1");
        assert_eq!(opened.unwrap().end, 45);
        assert_eq!(rows.len(), 2);
        assert_eq!(fs::metadata(&path).unwrap().len(), whole, "半行已截掉");

        // 接着写的落在截断处，不会接在半行后面。
        server.push("s1", 45, 60, Durable, TEXT);
        server.flush();
        let (opened, rows) = load(&Cache::new(temp.0.clone()).server(URL), "s1");
        assert_eq!(opened.unwrap().end, 60);
        assert_eq!(rows.last(), Some(&row(45, 60, Durable, TEXT)));
    }

    #[test]
    fn bad_or_missing_middle_line_truncates_from_there() {
        let temp = Temp::new("middle");
        let path = file(&temp.0, "s1");
        let write_three = || {
            let server = Cache::new(temp.0.clone()).server(URL);
            three(&server, "s1");
            server.push("s1", 45, 60, Durable, TEXT);
            server.flush();
            fs::read_to_string(&path).unwrap()
        };

        // 中间一行坏了。
        let text = write_three();
        let lines: Vec<&str> = text.lines().collect();
        let garbled = format!("{}\n{}\nxx\t30\t45\n{}\n", lines[0], lines[1], lines[3]);
        fs::write(&path, garbled).unwrap();
        let (opened, rows) = load(&Cache::new(temp.0.clone()).server(URL), "s1");
        assert_eq!(opened.unwrap().end, 10);
        assert_eq!(rows, vec![row(0, 10, Durable, INIT)]);

        // 中间少了一行：下一行的 from 接不上。
        let text = write_three();
        let lines: Vec<&str> = text.lines().collect();
        fs::write(&path, format!("{}\n{}\n{}\n", lines[0], lines[1], lines[3])).unwrap();
        let (opened, rows) = load(&Cache::new(temp.0.clone()).server(URL), "s1");
        assert_eq!(opened.unwrap().end, 10);
        assert_eq!(rows, vec![row(0, 10, Durable, INIT)]);
    }

    #[test]
    fn unknown_format_version_drops_the_whole_file() {
        let temp = Temp::new("version");
        let path = file(&temp.0, "s1");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "cchub-cache\t99\tino-1\n0\t0\t10\tdurable\t{}\n").unwrap();
        let (opened, rows) = load(&Cache::new(temp.0.clone()).server(URL), "s1");
        assert_eq!((opened, rows), (None, Vec::new()));
        assert!(!path.exists());
    }

    #[test]
    fn a_gap_in_pushed_events_stops_writing_but_keeps_what_was_written() {
        let temp = Temp::new("gap");
        let server = Cache::new(temp.0.clone()).server(URL);
        server.create("s1", "ino-1");
        server.push("s1", 0, 10, Durable, INIT);
        server.push("s1", 20, 30, Durable, TEXT);
        server.push("s1", 30, 40, Durable, TEXT);
        server.flush();
        let (opened, rows) = load(&server, "s1");
        assert_eq!(opened.unwrap().end, 10);
        assert_eq!(rows, vec![row(0, 10, Durable, INIT)]);
    }

    #[test]
    fn retain_deletes_sessions_the_server_no_longer_lists() {
        let temp = Temp::new("retain");
        // 旧实例用完就释放（Windows 上开着的文件删不干净）。
        three_sessions(&temp);
        // 重启后的新实例：s3 正在打开（有写入），即使不在列表里也不删。
        let server = Cache::new(temp.0.clone()).server(URL);
        load(&server, "s3");
        server.retain(|session| session == "s1");
        assert!(file(&temp.0, "s1").exists());
        assert!(!file(&temp.0, "s2").exists());
        assert!(file(&temp.0, "s3").exists());
    }

    #[test]
    fn over_the_limit_the_least_recently_opened_go_first() {
        let temp = Temp::new("evict");
        three_sessions(&temp);
        let size = fs::metadata(file(&temp.0, "s1")).unwrap().len();
        // s1 最久没打开，s3 最近。
        let now = SystemTime::now();
        for (session, ago) in [("s1", 300), ("s2", 200), ("s3", 100)] {
            let f = File::options()
                .write(true)
                .open(file(&temp.0, session))
                .unwrap();
            f.set_modified(now - Duration::from_secs(ago)).unwrap();
        }
        // 上限放得下两个：打开 s1 后它最新，最久没打开的就成了 s2。
        let server = Cache::with_limit(temp.0.clone(), size * 2 + size / 2).server(URL);
        load(&server, "s1");
        assert!(file(&temp.0, "s1").exists());
        assert!(!file(&temp.0, "s2").exists());
        assert!(file(&temp.0, "s3").exists());
    }

    #[test]
    fn lowering_the_limit_evicts_right_away() {
        let temp = Temp::new("limit");
        three_sessions(&temp);
        let size = fs::metadata(file(&temp.0, "s1")).unwrap().len();
        let now = SystemTime::now();
        for (session, ago) in [("s1", 300), ("s2", 200), ("s3", 100)] {
            let f = File::options()
                .write(true)
                .open(file(&temp.0, session))
                .unwrap();
            f.set_modified(now - Duration::from_secs(ago)).unwrap();
        }
        let cache = Cache::new(temp.0.clone());
        cache.set_limit(size * 2 + size / 2);
        assert_eq!(cache.limit(), size * 2 + size / 2);
        assert!(!file(&temp.0, "s1").exists());
        assert!(file(&temp.0, "s2").exists() && file(&temp.0, "s3").exists());
    }

    #[test]
    fn relocate_into_a_folder_with_other_files_uses_a_subfolder() {
        let temp = Temp::new("move-into");
        let cache = Cache::new(temp.0.join("old"));
        three(&cache.server(URL), "s1");
        let busy = temp.0.join("busy");
        fs::create_dir_all(&busy).unwrap();
        fs::write(busy.join("notes.txt"), "别的文件").unwrap();

        cache.relocate_into(&busy).unwrap();
        assert_eq!(cache.root(), busy.join("cchub-cache"));
        assert!(file(&busy.join("cchub-cache"), "s1").exists());
        assert!(busy.join("notes.txt").exists());

        // 空文件夹直接用。
        let empty = temp.0.join("empty");
        fs::create_dir_all(&empty).unwrap();
        cache.relocate_into(&empty).unwrap();
        assert_eq!(cache.root(), empty);

        // 选了现在的位置，或它里面的文件夹：不动。
        cache.relocate_into(&empty).unwrap();
        assert_eq!(cache.root(), empty);
        let inner = empty.join(dir_name(URL));
        assert!(cache.relocate_into(&inner).is_err());
        assert_eq!(cache.root(), empty);
        assert!(file(&empty, "s1").exists());
    }

    #[test]
    fn relocate_moves_everything_and_keeps_writing_there() {
        let temp = Temp::new("move");
        let (old, new) = (temp.0.join("old"), temp.0.join("new"));
        let cache = Cache::new(old.clone());
        let server = cache.server(URL);
        three(&server, "s1");
        three(&server, "s2");

        cache.relocate(&new).unwrap();
        assert_eq!(cache.root(), new);
        assert!(!file(&old, "s1").exists() && !file(&old, "s2").exists());
        // 正在写的会话在新位置接着写。
        server.push("s1", 45, 60, Durable, TEXT);
        server.flush();
        let (opened, rows) = load(&Cache::new(new.clone()).server(URL), "s1");
        assert_eq!(opened.unwrap().end, 60);
        assert_eq!(rows.len(), 3);
        assert_eq!(load(&Cache::new(new).server(URL), "s2").1.len(), 2);
    }

    #[test]
    fn failed_relocate_leaves_the_old_location_whole() {
        let temp = Temp::new("move-fail");
        let (old, new) = (temp.0.join("old"), temp.0.join("new"));
        let cache = Cache::new(old.clone());
        let server = cache.server(URL);
        three(&server, "s1");
        three(&server, "s2");
        let before = (
            fs::read(file(&old, "s1")).unwrap(),
            fs::read(file(&old, "s2")).unwrap(),
        );

        // 复制到第二个文件时失败（比如新位置满了）。
        let copies = std::cell::Cell::new(0);
        let result = cache.relocate_with(&new, |from, to| {
            copies.set(copies.get() + 1);
            if copies.get() == 2 {
                return Err(io::Error::other("磁盘满了"));
            }
            fs::copy(from, to).map(drop)
        });
        assert!(result.unwrap_err().contains("磁盘满了"));
        assert_eq!(cache.root(), old);
        let after = (
            fs::read(file(&old, "s1")).unwrap(),
            fs::read(file(&old, "s2")).unwrap(),
        );
        assert_eq!(after, before);
        assert!(!file(&new, "s1").exists() && !file(&new, "s2").exists());
        // 原位置照常写。
        server.push("s1", 45, 60, Durable, TEXT);
        server.flush();
        assert_eq!(load(&Cache::new(old).server(URL), "s1").1.len(), 3);
    }

    #[test]
    fn relocate_refuses_a_folder_with_other_files_and_relative_paths() {
        let temp = Temp::new("move-busy");
        let cache = Cache::new(temp.0.join("old"));
        three(&cache.server(URL), "s1");
        let busy = temp.0.join("busy");
        fs::create_dir_all(&busy).unwrap();
        fs::write(busy.join("notes.txt"), "别的文件").unwrap();
        assert!(cache.relocate(&busy).is_err());
        assert!(cache.relocate(Path::new("relative/dir")).is_err());
        assert_eq!(cache.root(), temp.0.join("old"));
        assert!(busy.join("notes.txt").exists());
    }

    #[test]
    fn clear_removes_everything_and_stops_writing() {
        let temp = Temp::new("clear");
        let cache = Cache::new(temp.0.clone());
        let server = cache.server(URL);
        three(&server, "s1");
        assert!(cache.usage() > 0);
        cache.clear().unwrap();
        assert_eq!(cache.usage(), 0);
        // 之前开着的写入不会把文件再写出来（没有头的文件读不了）。
        server.push("s1", 45, 60, Durable, TEXT);
        server.flush();
        assert!(!file(&temp.0, "s1").exists());
        assert_eq!(load(&server, "s1").0, None);
    }

    #[test]
    fn session_ids_that_are_not_safe_file_names_are_not_cached() {
        let temp = Temp::new("unsafe");
        let server = Cache::new(temp.0.clone()).server(URL);
        server.create("../x", "ino-1");
        server.push("../x", 0, 10, Durable, INIT);
        server.flush();
        assert!(!temp.0.join("x").exists());
        assert_eq!(load(&server, "../x").0, None);
    }

    #[test]
    fn server_dir_name_is_stable_and_safe_on_windows() {
        assert_eq!(dir_name(URL), "ws%3A%2F%2F100.64.0.1%3A7878%2Fws");
        assert_eq!(dir_name("host."), "host%2E");
        assert_eq!(dir_name(""), "%");
    }
}
