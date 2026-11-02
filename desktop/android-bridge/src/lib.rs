//! Android 上维持连接和发通知要用系统接口，这里只转发给 `android/` 里的 Kotlin 代码。

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{Manager, Runtime};

pub struct Bridge<R: Runtime>(PluginHandle<R>);

#[derive(Serialize)]
struct Status<'a> {
    text: &'a str,
}

#[derive(Serialize)]
struct Notify<'a> {
    session: &'a str,
    body: &'a str,
}

#[derive(Deserialize)]
struct Opened {
    session: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Background {
    pub notifications_allowed: bool,
    pub battery_unrestricted: bool,
}

impl<R: Runtime> Bridge<R> {
    fn call(&self, command: &str, args: impl Serialize) -> Result<serde_json::Value, String> {
        self.0
            .run_mobile_plugin(command, args)
            .map_err(|e| e.to_string())
    }

    /// 启动前台服务，并在第一次时请求通知权限。
    pub fn start_service(&self) -> Result<(), String> {
        self.call("startService", ()).map(|_| ())
    }

    /// 常驻通知上显示的连接状态。
    pub fn set_status(&self, text: &str) -> Result<(), String> {
        self.call("setStatus", Status { text }).map(|_| ())
    }

    pub fn notify(&self, session: &str, body: &str) -> Result<(), String> {
        self.call("notify", Notify { session, body }).map(|_| ())
    }

    /// 从通知点进来时要打开的会话，取走后清空。
    pub fn take_opened_session(&self) -> Result<Option<String>, String> {
        let value = self.call("takeOpenedSession", ())?;
        let opened: Opened = serde_json::from_value(value).map_err(|e| e.to_string())?;
        Ok(opened.session)
    }

    pub fn background(&self) -> Result<Background, String> {
        let value = self.call("background", ())?;
        serde_json::from_value(value).map_err(|e| e.to_string())
    }

    /// 打开系统对话框，让用户把 App 设为不受电池优化限制。
    pub fn request_battery_unrestricted(&self) -> Result<(), String> {
        self.call("requestBatteryUnrestricted", ()).map(|_| ())
    }
}

pub trait BridgeExt<R: Runtime> {
    fn bridge(&self) -> &Bridge<R>;
}

impl<R: Runtime, T: Manager<R>> BridgeExt<R> for T {
    fn bridge(&self) -> &Bridge<R> {
        self.state::<Bridge<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("cchub-bridge")
        .setup(|app, api| {
            let handle = api.register_android_plugin("dev.anziron.cchub.bridge", "BridgePlugin")?;
            app.manage(Bridge(handle));
            Ok(())
        })
        .build()
}
