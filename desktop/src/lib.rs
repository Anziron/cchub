use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use cchub_client::{Cache, HubClient, Notifier};
use cchub_protocol::{ClientMsg, ConnectionState, EventClass, UiEvent};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

const INITIAL_BACKOFF: Duration = Duration::from_secs(1);
/// 事件合批窗口：窗口内到达的事件一次发给前端，减少 IPC 次数。
const BATCH_WINDOW: Duration = Duration::from_millis(16);
/// 一批最多这么多条：重放大会话时不攒出一个巨大的 IPC 消息，界面也能分几帧处理。
const BATCH_MAX: usize = 512;

/// 启动合批线程：收到第一条后最多再等一个窗口，把期间的事件合成一批发出。
/// 空闲时线程阻塞在 `recv`，没有开销；发送端全部丢弃（旧连接结束）时线程退出。
fn spawn_batcher(handle: AppHandle) -> mpsc::Sender<UiEvent> {
    let (tx, rx) = mpsc::channel::<UiEvent>();
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut batch = vec![first];
            let deadline = Instant::now() + BATCH_WINDOW;
            while batch.len() < BATCH_MAX {
                let left = deadline.saturating_duration_since(Instant::now());
                match rx.recv_timeout(left) {
                    Ok(event) => batch.push(event),
                    Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => break,
                }
            }
            let _ = handle.emit("hub", batch);
        }
    });
    tx
}

struct Connection {
    url: String,
    client: HubClient,
}

#[derive(Default)]
struct Hub {
    connection: Mutex<Option<Connection>>,
    state: Arc<Mutex<Option<ConnectionState>>>,
    /// 本机缓存（见 `cchub_client::Cache`），第一次用到时建好；拿不到应用目录时为空。
    cache: OnceLock<Option<Cache>>,
}

impl Hub {
    fn cache(&self, app: &AppHandle) -> Option<Cache> {
        self.cache.get_or_init(|| open_cache(app)).clone()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// 设置里改过的缓存位置（`dir`）和上限（`limit`，字节）记在这里。
fn cache_config(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    Some(dir.join("cache.json"))
}

fn read_cache_config(path: Option<&PathBuf>) -> serde_json::Value {
    path.and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .filter(serde_json::Value::is_object)
        .unwrap_or_else(|| json!({}))
}

/// 改 `cache.json` 里的一项，别的项保留。
fn save_cache_config(
    path: Option<&PathBuf>,
    key: &str,
    value: serde_json::Value,
) -> Result<(), String> {
    let path = path.ok_or("找不到应用数据目录")?;
    let mut config = read_cache_config(Some(path));
    config[key] = value;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, config.to_string()).map_err(|e| e.to_string())
}

/// 缓存位置：设置里改过就用改过的，否则是应用本地数据目录下的 `cache`
/// （Windows 上是 `%LOCALAPPDATA%\dev.anziron.cchub\cache`，Android 上是应用私有目录）。
fn open_cache(app: &AppHandle) -> Option<Cache> {
    let config = read_cache_config(cache_config(app).as_ref());
    let custom = config["dir"].as_str().map(PathBuf::from);
    let fallback = || {
        app.path()
            .app_local_data_dir()
            .ok()
            .map(|dir| dir.join("cache"))
    };
    let cache = Cache::new(custom.or_else(fallback)?);
    if let Some(limit) = config["limit"].as_u64().filter(|&l| l >= MIN_CACHE_LIMIT) {
        cache.set_limit(limit);
    }
    Some(cache)
}

/// 上限不能低于这个，免得一打开会话就被删。
const MIN_CACHE_LIMIT: u64 = 100 << 20;

/// 设置里的“本机缓存”：`info` 查位置、占用和上限，`clear` 清空，`limit` 改上限，
/// `move` 弹出文件夹选择框、搬过去（只有桌面端；取消就不动）。
/// 返回 `{ path, bytes, limit, movable }`。放在阻塞线程里做：选文件夹要等用户，搬家要复制全部文件。
#[tauri::command]
async fn hub_cache(
    app: AppHandle,
    hub: State<'_, Hub>,
    op: String,
    limit: Option<u64>,
) -> Result<serde_json::Value, String> {
    let cache = hub.cache(&app).ok_or("这台设备上没有可用的缓存目录")?;
    let config = cache_config(&app);
    let work = move || -> Result<serde_json::Value, String> {
        match op.as_str() {
            "info" => {}
            "clear" => cache.clear().map_err(|e| format!("清空失败：{e}"))?,
            "limit" => {
                let limit = limit
                    .filter(|&l| l >= MIN_CACHE_LIMIT)
                    .ok_or("上限至少 100 MB")?;
                cache.set_limit(limit);
                save_cache_config(config.as_ref(), "limit", json!(limit)).map_err(|e| {
                    format!("上限已生效，但没能记住它（{e}），下次启动会回到默认值")
                })?;
            }
            #[cfg(mobile)]
            "move" => return Err("手机上不能改缓存位置".into()),
            #[cfg(desktop)]
            "move" => {
                if let Some(chosen) = desktop::pick_folder(&app, &cache.root()) {
                    cache.relocate_into(&chosen)?;
                    let dir = cache.root().to_string_lossy().into_owned();
                    save_cache_config(config.as_ref(), "dir", json!(dir)).map_err(|e| {
                        format!("已经搬到新位置，但没能记住它（{e}），下次启动会回到默认位置")
                    })?;
                }
            }
            other => return Err(format!("不认识的操作：{other}")),
        }
        Ok(json!({
            "path": cache.root().to_string_lossy(),
            "bytes": cache.usage(),
            "limit": cache.limit(),
            "movable": cfg!(desktop),
        }))
    };
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

/// 待决定事件的通知水位，存在磁盘上，重启后重放也不会重复通知。
struct Notifications {
    path: Option<PathBuf>,
    notifier: Mutex<Notifier>,
}

impl Notifications {
    fn load(app: &AppHandle) -> Self {
        let path = app
            .path()
            .app_data_dir()
            .ok()
            .map(|dir| dir.join("notified.json"));
        let notifier = path
            .as_ref()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        Self {
            path,
            notifier: Mutex::new(notifier),
        }
    }

    fn observe(&self, session: &str, seq: u64, class: EventClass) -> bool {
        let mut notifier = lock(&self.notifier);
        if !notifier.observe(session, seq, class) {
            return false;
        }
        if let (Some(path), Ok(text)) = (&self.path, serde_json::to_string(&*notifier)) {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(path, text);
        }
        true
    }
}

fn notification_body(class: EventClass) -> &'static str {
    match class {
        EventClass::Question => "有个问题等你决定",
        _ => "有个操作等你批准",
    }
}

/// 窗口重建时前端会再调用一次：同一地址保持原连接，只返回当前状态。
#[tauri::command]
fn hub_connect(app: AppHandle, hub: State<'_, Hub>, url: String) -> ConnectionState {
    let mut connection = lock(&hub.connection);
    if connection.as_ref().is_some_and(|c| c.url == url) {
        return lock(&hub.state).unwrap_or(ConnectionState::Connecting);
    }
    #[cfg(mobile)]
    mobile::start_service(&app);
    #[cfg(desktop)]
    let handle = app.clone();
    let state = hub.state.clone();
    // 提醒哪些事件由连接逻辑决定（历史里已经处理过的审批不提醒），这里只按水位去重后弹通知。
    let on_attention = {
        let notifications = Notifications::load(&app);
        #[cfg(desktop)]
        let handle = app.clone();
        move |session: &str, seq: u64, class: EventClass| {
            if notifications.observe(session, seq, class) {
                #[cfg(desktop)]
                desktop::notify(&handle, class);
                #[cfg(mobile)]
                mobile::notify(session, class);
            }
        }
    };
    let batcher = Mutex::new(spawn_batcher(app.clone()));
    let on_event = move |event: UiEvent| {
        if let UiEvent::Connection { state: current } = &event {
            *lock(&state) = Some(*current);
            #[cfg(mobile)]
            mobile::connection_changed(*current);
        }
        #[cfg(mobile)]
        if !mobile::ui_alive() {
            return;
        }
        // 窗口关到托盘后 WebView 已销毁，`emit` 仍会先序列化整批事件。没有界面就不送；
        // 重新打开窗口时界面会重新订阅，从本机缓存（没有就从头）重放，不会漏。
        #[cfg(desktop)]
        if !desktop::ui_alive(&handle) {
            return;
        }
        let _ = lock(&batcher).send(event);
    };
    let cache = hub.cache(&app);
    #[cfg(desktop)]
    let (client, task) =
        HubClient::new(url.clone(), INITIAL_BACKOFF, cache, on_event, on_attention);
    #[cfg(mobile)]
    let (client, task) = HubClient::watching(
        url.clone(),
        INITIAL_BACKOFF,
        mobile::WATCH_INTERVAL,
        cache,
        on_event,
        on_attention,
    );
    tauri::async_runtime::spawn(task);
    // 换掉旧句柄后，旧的连接循环会自己结束。
    *connection = Some(Connection { url, client });
    ConnectionState::Connecting
}

#[tauri::command]
fn hub_send(hub: State<'_, Hub>, msg: ClientMsg) -> Result<(), String> {
    let connection = lock(&hub.connection);
    connection
        .as_ref()
        .ok_or("尚未连接服务器")?
        .client
        .send(msg)
}

#[cfg(desktop)]
pub fn run() {
    desktop::run();
}

#[cfg(mobile)]
#[tauri::mobile_entry_point]
pub fn run() {
    mobile::run();
}
