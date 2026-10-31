#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use std::time::Duration;

use cchub_client::HubClient;
use cchub_protocol::ClientMsg;
use tauri::{AppHandle, Emitter, Manager, State};

const INITIAL_BACKOFF: Duration = Duration::from_secs(1);

#[derive(Default)]
struct Hub(Mutex<Option<HubClient>>);

#[tauri::command]
fn hub_connect(app: AppHandle, hub: State<'_, Hub>, url: String) {
    let handle = app.clone();
    let (client, task) = HubClient::new(url, INITIAL_BACKOFF, move |event| {
        let _ = handle.emit("hub", event);
    });
    tauri::async_runtime::spawn(task);
    // 换掉旧句柄后，旧的连接循环会自己结束。
    *hub.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(client);
}

#[tauri::command]
fn hub_send(hub: State<'_, Hub>, msg: ClientMsg) -> Result<(), String> {
    let guard = hub.0.lock().unwrap_or_else(|e| e.into_inner());
    guard.as_ref().ok_or("尚未连接服务器")?.send(msg)
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(Hub::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![hub_connect, hub_send])
        .run(tauri::generate_context!())
        .expect("failed to run cchub desktop");
}
