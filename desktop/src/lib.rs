use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cchub_client::{HubClient, Notifier};
use cchub_protocol::{ClientMsg, ConnectionState, EventClass, UiEvent};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

const INITIAL_BACKOFF: Duration = Duration::from_secs(1);

struct Connection {
    url: String,
    client: HubClient,
}

#[derive(Default)]
struct Hub {
    connection: Mutex<Option<Connection>>,
    state: Arc<Mutex<Option<ConnectionState>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
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
    let handle = app.clone();
    let state = hub.state.clone();
    let notifications = Notifications::load(&app);
    let (client, task) = HubClient::new(url.clone(), INITIAL_BACKOFF, move |event| {
        match &event {
            UiEvent::Connection { state: current } => {
                *lock(&state) = Some(*current);
                #[cfg(mobile)]
                mobile::connection_changed(&handle, *current);
            }
            UiEvent::Event {
                session,
                class,
                seq,
                ..
            } if notifications.observe(session, *seq, *class) => {
                #[cfg(desktop)]
                desktop::notify(&handle, *class);
                #[cfg(mobile)]
                mobile::notify(&handle, session, *class);
            }
            _ => {}
        }
        // 窗口关闭后没有接收方，发送没有开销。
        let _ = handle.emit("hub", event);
    });
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
