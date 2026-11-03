use std::io::Write;
use std::os::android::net::SocketAddrExt;
use std::os::unix::net::{SocketAddr, UnixStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::OnceLock;
use std::time::Duration;

use cchub_protocol::{ConnectionState, EventClass};
use tauri::{AppHandle, RunEvent, WindowEvent};
use tauri_plugin_cchub_bridge::{Background, BridgeExt};

use crate::{notification_body, Hub};

/// 和 `hubd` 的心跳同频，网络本来就醒着，不额外耗电。
/// 这也是别处新开的会话最晚多久能发出第一条通知。
pub(crate) const WATCH_INTERVAL: Duration = Duration::from_secs(15);

/// 和 `KeepAliveService` 里的一致。
const SOCKET_NAME: &[u8] = b"dev.anziron.cchub.bridge";
/// 服务刚启动时 socket 可能还没建好。
const CONNECT_ATTEMPTS: u32 = 50;

static UI_ALIVE: AtomicBool = AtomicBool::new(true);

type Job = Box<dyn FnOnce() + Send>;

static JOBS: OnceLock<Sender<Job>> = OnceLock::new();

/// 不能挡住连接循环和界面命令。用同一个线程按顺序执行，否则旧的连接状态可能盖掉新的。
fn in_background(job: impl FnOnce() + Send + 'static) {
    let jobs = JOBS.get_or_init(|| {
        let (tx, rx) = channel::<Job>();
        std::thread::spawn(move || {
            for job in rx {
                job();
            }
        });
        tx
    });
    let _ = jobs.send(Box::new(job));
}

/// 通知发不出去用户看不到，至少留下日志（logcat 的 RustStdoutStderr）。
fn report(command: &str, result: Result<(), String>) {
    match result {
        Ok(()) => eprintln!("cchub-bridge: {command} ok"),
        Err(error) => eprintln!("cchub-bridge: {command} failed: {error}"),
    }
}

/// 发给前台服务。不走 Tauri 插件，这样界面销毁后也能用。
fn send_to_service(message: &serde_json::Value) -> Result<(), String> {
    let address = SocketAddr::from_abstract_name(SOCKET_NAME).map_err(|e| e.to_string())?;
    let mut last_error = String::new();
    for _ in 0..CONNECT_ATTEMPTS {
        match UnixStream::connect_addr(&address) {
            Ok(mut stream) => return writeln!(stream, "{message}").map_err(|e| e.to_string()),
            Err(error) => last_error = error.to_string(),
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(last_error)
}

pub(crate) fn start_service(app: &AppHandle) {
    let app = app.clone();
    in_background(move || {
        report("startService", app.bridge().start_service());
    });
}

/// 界面销毁后就不再有页面可以接收事件。
pub(crate) fn ui_alive() -> bool {
    UI_ALIVE.load(Ordering::Relaxed)
}

pub(crate) fn connection_changed(state: ConnectionState) {
    let text = match state {
        ConnectionState::Connected => "已连接，需要你决定时会通知",
        ConnectionState::Connecting => "正在连接服务器",
        ConnectionState::Disconnected => "连接已断开，任务仍在服务器上运行，暂时收不到通知",
    };
    in_background(move || {
        let message = serde_json::json!({ "cmd": "status", "text": text });
        report("status", send_to_service(&message));
    });
}

pub(crate) fn notify(session: &str, class: EventClass) {
    let session = session.to_owned();
    in_background(move || {
        let body = notification_body(class);
        let message = serde_json::json!({ "cmd": "notify", "session": session, "body": body });
        report("notify", send_to_service(&message));
    });
}

#[tauri::command]
async fn take_opened_session(app: AppHandle) -> Result<Option<String>, String> {
    app.bridge().take_opened_session()
}

#[tauri::command]
async fn background_status(app: AppHandle) -> Result<Background, String> {
    app.bridge().background()
}

#[tauri::command]
async fn request_battery_unrestricted(app: AppHandle) -> Result<(), String> {
    app.bridge().request_battery_unrestricted()
}

pub(crate) fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_cchub_bridge::init())
        .manage(Hub::default())
        .invoke_handler(tauri::generate_handler![
            crate::hub_connect,
            crate::hub_send,
            take_opened_session,
            background_status,
            request_battery_unrestricted
        ])
        .build(tauri::generate_context!())
        .expect("failed to build cchub")
        .run(|_, event| match event {
            // 划掉任务只销毁界面，进程要留下来维持连接和通知；退出走常驻通知上的按钮。
            RunEvent::ExitRequested {
                api, code: None, ..
            } => api.prevent_exit(),
            RunEvent::WindowEvent {
                event: WindowEvent::Destroyed,
                ..
            } => UI_ALIVE.store(false, Ordering::Relaxed),
            _ => {}
        });
}
