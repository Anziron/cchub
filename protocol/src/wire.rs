//! `hubd` 和桌面端之间的消息。
//!
//! 序号就是事件在会话 `out` 文件里的字节偏移。`Event` 和 `Skipped` 各覆盖一段连续区间
//! `[seq, next)`，所以客户端能证明没有缺口，`hubd` 重启后也能从偏移接着读。

use serde::{Deserialize, Serialize};

use crate::envelope::EventClass;

pub const PROTOCOL_VERSION: u32 = 0;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Health {
    pub version: String,
    pub protocol_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    /// 启动会话对应的进程；已在运行时不做任何事。
    Start {
        session: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resume: Option<String>,
        /// 项目目录。省略时用会话目录。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        /// 显示在会话列表里的标题。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        /// 新会话第一条消息的原文。给出时 `hubd` 在后台概括成标题，替换 `title`。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
    },
    /// 列出服务器上的会话。
    List,
    /// 订阅会话，从 `after` 偏移开始接收。
    Attach {
        session: String,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        after: u64,
    },
    /// 一行发给 `claude` 的 stream-json。
    Input { session: String, line: String },
    /// 结束会话进程。
    Stop { session: String },
    /// 关闭会话：从侧边栏移走，进程在运行就一起结束；`archived: false` 时恢复。再次 `Start` 也会恢复。
    Archive { session: String, archived: bool },
    /// 浏览设备目录。省略 `device` 时列设备，省略 `path` 时从设备的起始位置开始。
    Browse {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        device: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    /// 挂载设备上的目录，作为工作区。
    Mount { device: String, path: String },
    /// 读取后台任务输出文件的末尾。
    TaskOutput { path: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct SessionInfo {
    pub id: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub running: bool,
    /// 日志最后更新时间，Unix 秒。
    #[cfg_attr(feature = "ts", ts(type = "number | null"))]
    pub updated: Option<u64>,
    /// 已关闭：不显示在侧边栏，可用 `/resume` 找回。
    #[serde(default)]
    pub archived: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    Event {
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        seq: u64,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        next: u64,
        class: EventClass,
        /// `claude` 输出的一行原文，`hubd` 不解析正文。
        payload: String,
    },
    /// `[seq, next)` 里只有逐字片段，因积压被有意跳过。
    Skipped {
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        seq: u64,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        next: u64,
    },
    /// 项目目录所在设备是否在线。
    Device {
        online: bool,
    },
    /// 会话进程状态。
    Status {
        running: bool,
    },
    /// 回复 `List`。
    Sessions {
        sessions: Vec<SessionInfo>,
        #[cfg_attr(feature = "ts", ts(type = "number | null"))]
        mem_available_mb: Option<u64>,
    },
    /// 回复 `Browse`。`entries` 是设备名或子目录的完整路径。
    Browse {
        device: Option<String>,
        path: Option<String>,
        parent: Option<String>,
        entries: Vec<String>,
        error: Option<String>,
    },
    /// 回复 `Mount`。成功时 `cwd` 是服务器上的路径。
    Mounted {
        device: String,
        path: String,
        cwd: Option<String>,
        error: Option<String>,
    },
    /// 回复 `TaskOutput`。
    TaskOutput {
        path: String,
        text: Option<String>,
        error: Option<String>,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    Connecting,
    Connected,
    Disconnected,
}

/// 桌面端 Rust 进程经 IPC 推给前端的事件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum UiEvent {
    Connection {
        state: ConnectionState,
    },
    Event {
        session: String,
        class: EventClass,
        #[cfg_attr(feature = "ts", ts(type = "number"))]
        seq: u64,
        payload: String,
    },
    Status {
        session: String,
        running: bool,
    },
    Device {
        session: String,
        online: bool,
    },
    Sessions {
        sessions: Vec<SessionInfo>,
        #[cfg_attr(feature = "ts", ts(type = "number | null"))]
        mem_available_mb: Option<u64>,
    },
    Browse {
        device: Option<String>,
        path: Option<String>,
        parent: Option<String>,
        entries: Vec<String>,
        error: Option<String>,
    },
    Mounted {
        device: String,
        path: String,
        cwd: Option<String>,
        error: Option<String>,
    },
    TaskOutput {
        path: String,
        text: Option<String>,
        error: Option<String>,
    },
    Error {
        session: Option<String>,
        message: String,
    },
}

/// 一条连接上可以同时订阅多个会话，每条消息标明属于哪个会话。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct Frame {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(flatten)]
    pub msg: ServerMsg,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_flattens_message_next_to_session() {
        let frame = Frame {
            session: Some("s1".into()),
            msg: ServerMsg::Skipped { seq: 1, next: 2 },
        };
        let json = serde_json::to_string(&frame).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&json).unwrap(),
            serde_json::json!({"session": "s1", "type": "skipped", "seq": 1, "next": 2})
        );
        assert_eq!(serde_json::from_str::<Frame>(&json).unwrap(), frame);
    }
}
