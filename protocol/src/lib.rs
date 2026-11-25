//! `hubd` 和桌面端共用的线路消息与同步核心。
//!
//! 这里不碰网络和文件：输入事件，输出动作，所以两端都能在同一个测试里确定性地模拟。

#![forbid(unsafe_code)]

pub mod codec;
pub mod envelope;
pub mod sync;
pub mod uplink;
pub mod wire;

pub use codec::{
    wants_deflate, with_deflate_query, DecodeError, FrameDecoder, FrameEncoder, DEFLATE_QUERY,
};
pub use envelope::{
    classify, elide_base64, is_conversation_line, is_message_end, is_user_message, turn_finished,
    EventClass,
};
pub use sync::{Inbound, InboundAction, LineSplitter, Outbound, OutboundLimits};
pub use uplink::{Dedupe, Outbox};
pub use wire::{
    client_version, with_version_query, AckError, ClientMsg, ConnectionState, DeviceInfo, Frame,
    Health, HostLoad, ProcessLoad, ServerMsg, SessionInfo, SessionLoad, UiEvent, PROTOCOL_VERSION,
};
