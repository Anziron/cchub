use cchub_protocol::{ConnectionState, EventClass};
use tauri::AppHandle;
use tauri_plugin_cchub_bridge::{Background, BridgeExt};

use crate::{hub_connect, hub_send, notification_body, Hub};

/// 调 Kotlin 要等主线程回复，不能挡住连接循环和界面命令。
fn in_background(app: &AppHandle, job: impl FnOnce(&AppHandle) + Send + 'static) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || job(&app));
}

pub(crate) fn start_service(app: &AppHandle) {
    in_background(app, |app| {
        let _ = app.bridge().start_service();
    });
}

pub(crate) fn connection_changed(app: &AppHandle, state: ConnectionState) {
    let text = match state {
        ConnectionState::Connected => "已连接，需要你决定时会通知",
        ConnectionState::Connecting => "正在连接服务器",
        ConnectionState::Disconnected => "连接已断开，任务仍在服务器上运行，暂时收不到通知",
    };
    in_background(app, move |app| {
        let _ = app.bridge().set_status(text);
    });
}

pub(crate) fn notify(app: &AppHandle, session: &str, class: EventClass) {
    let session = session.to_owned();
    in_background(app, move |app| {
        let _ = app.bridge().notify(&session, notification_body(class));
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
            hub_connect,
            hub_send,
            take_opened_session,
            background_status,
            request_battery_unrestricted
        ])
        .run(tauri::generate_context!())
        .expect("failed to run cchub");
}
