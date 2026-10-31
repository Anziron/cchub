#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cchub_client::{HubClient, Notifier};
use cchub_protocol::{ClientMsg, ConnectionState, EventClass, UiEvent};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;

const INITIAL_BACKOFF: Duration = Duration::from_secs(1);
const MAIN: &str = "main";
/// 只在回环上占用，用来保证单实例；连接它等于请求已有实例打开窗口。
const INSTANCE_ADDR: &str = "127.0.0.1:47878";

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

fn notify(app: &AppHandle, class: EventClass) {
    // 窗口在前台时界面上已经能看到，不再打扰。
    let focused = app
        .get_webview_window(MAIN)
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false);
    if focused {
        return;
    }
    let body = match class {
        EventClass::Question => "有个问题等你决定",
        _ => "有个操作等你批准",
    };
    let _ = app
        .notification()
        .builder()
        .title("cchub")
        .body(body)
        .show();
}

/// 窗口重建时前端会再调用一次：同一地址保持原连接，只返回当前状态。
#[tauri::command]
fn hub_connect(app: AppHandle, hub: State<'_, Hub>, url: String) -> ConnectionState {
    let mut connection = lock(&hub.connection);
    if connection.as_ref().is_some_and(|c| c.url == url) {
        return lock(&hub.state).unwrap_or(ConnectionState::Connecting);
    }
    let handle = app.clone();
    let state = hub.state.clone();
    let notifications = Notifications::load(&app);
    let (client, task) = HubClient::new(url.clone(), INITIAL_BACKOFF, move |event| {
        match &event {
            UiEvent::Connection { state: current } => *lock(&state) = Some(*current),
            UiEvent::Event {
                session,
                class,
                seq,
                ..
            } if notifications.observe(session, *seq, *class) => notify(&handle, *class),
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

/// 窗口关掉时 WebView 已销毁，要重新创建。
fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::default())
        .title("cchub")
        .inner_size(1100.0, 720.0)
        .min_inner_size(720.0, 480.0)
        .build();
}

/// 第二个实例会多一条连接和一份通知，所以只唤起已有实例的窗口后退出。
fn listen_for_reopen(app: &AppHandle, listener: TcpListener) {
    let app = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if stream.is_ok() {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || show_main(&handle));
            }
        }
    });
}

fn main() {
    let instance = match TcpListener::bind(INSTANCE_ADDR) {
        Ok(listener) => Some(listener),
        Err(e) if e.kind() == ErrorKind::AddrInUse => {
            let _ = TcpStream::connect(INSTANCE_ADDR);
            return;
        }
        // 端口不可用不应妨碍启动，只是失去单实例保护。
        Err(_) => None,
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(Hub::default())
        .invoke_handler(tauri::generate_handler![hub_connect, hub_send])
        .setup(move |app| {
            if let Some(listener) = instance {
                listen_for_reopen(app.handle(), listener);
            }
            let open = MenuItem::with_id(app, "open", "打开 cchub", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("cchub")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build cchub desktop")
        .run(|_, event| {
            // 关掉窗口只释放 WebView，进程留在托盘维持连接和通知；只有菜单里的退出才结束。
            if let RunEvent::ExitRequested {
                api, code: None, ..
            } = event
            {
                api.prevent_exit();
            }
        });
}
