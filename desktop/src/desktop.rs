use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream};

use cchub_protocol::EventClass;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;

use crate::{notification_body, Hub};

const MAIN: &str = "main";
/// 只在回环上占用，用来保证单实例；连接它等于请求已有实例打开窗口。
const INSTANCE_ADDR: &str = "127.0.0.1:47878";

pub(crate) fn notify(app: &AppHandle, class: EventClass) {
    // 窗口在前台时界面上已经能看到，不再打扰。
    let focused = app
        .get_webview_window(MAIN)
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false);
    if focused {
        return;
    }
    let _ = app
        .notification()
        .builder()
        .title("cchub")
        .body(notification_body(class))
        .show();
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

pub(crate) fn run() {
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
        .invoke_handler(tauri::generate_handler![crate::hub_connect, crate::hub_send])
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
