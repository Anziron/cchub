use std::sync::mpsc::{channel, Sender};
use std::sync::OnceLock;
use std::time::Duration;

use cchub_protocol::{ConnectionState, EventClass};
use tauri::{AppHandle, RunEvent};
use tauri_plugin_cchub_bridge::{Background, BridgeExt};

use crate::{notification_body, Hub};

/// 和 `hubd` 的心跳同频，网络本来就醒着，不额外耗电。
/// 这也是别处新开的会话最晚多久能发出第一条通知。
pub(crate) const WATCH_INTERVAL: Duration = Duration::from_secs(15);

type Job = Box<dyn FnOnce(&AppHandle) + Send>;

static JOBS: OnceLock<Sender<Job>> = OnceLock::new();

/// 调 Kotlin 要等主线程回复，不能挡住连接循环和界面命令。
/// 用同一个线程按顺序执行，否则旧的连接状态可能盖掉新的。
fn in_background(app: &AppHandle, job: impl FnOnce(&AppHandle) + Send + 'static) {
    let jobs = JOBS.get_or_init(|| {
        let (tx, rx) = channel::<Job>();
        let app = app.clone();
        std::thread::spawn(move || {
            for job in rx {
                job(&app);
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

pub(crate) fn start_service(app: &AppHandle) {
    in_background(app, |app| {
        report("startService", app.bridge().start_service());
    });
}

pub(crate) fn connection_changed(app: &AppHandle, state: ConnectionState) {
    let text = match state {
        ConnectionState::Connected => "已连接，需要你决定时会通知",
        ConnectionState::Connecting => "正在连接服务器",
        ConnectionState::Disconnected => "连接已断开，任务仍在服务器上运行，暂时收不到通知",
    };
    in_background(app, move |app| {
        report("setStatus", app.bridge().set_status(text));
    });
}

pub(crate) fn notify(app: &AppHandle, session: &str, class: EventClass) {
    let session = session.to_owned();
    in_background(app, move |app| {
        report(
            "notify",
            app.bridge().notify(&session, notification_body(class)),
        );
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
        .run(|_, event| {
            // 划掉任务只销毁界面，进程要留下来维持连接和通知；退出走常驻通知上的按钮。
            if let RunEvent::ExitRequested {
                api, code: None, ..
            } = event
            {
                api.prevent_exit();
            }
        });
}
