use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use crate::auth::is_tailscale_ip;

const DEFAULT_LISTEN: &str = "127.0.0.1:7878";
const DEFAULT_STATE_DIR: &str = "/var/lib/hubd";
const DEFAULT_CLAUDE_CMD: &str = "claude -p --input-format stream-json \
    --output-format stream-json --verbose --permission-prompt-tool stdio \
    --include-partial-messages --replay-user-messages";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKind {
    Systemd,
    Direct,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub listen: SocketAddr,
    pub state_dir: PathBuf,
    pub host: HostKind,
    /// 交给 `sh -c` 执行的命令，来自部署者自己的配置。
    pub claude_cmd: String,
    /// 允许连接的 Tailscale 账号。
    pub allowed_users: Vec<String>,
    /// 运行日志的保留时长。
    pub retention: Duration,
    /// 单个会话 unit 的 `MemoryMax`，0 表示不限制。
    pub session_memory_max_mb: u64,
    /// 可用内存低于此值时拒绝启动新进程，0 表示不检查。
    pub min_available_mb: u64,
    /// 浏览和挂载设备目录的外部命令，协议见 `workspace.rs`。
    pub workspace_cmd: String,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let var = |name: &str, default: &str| env::var(name).unwrap_or_else(|_| default.into());

        let listen = var("HUBD_LISTEN", DEFAULT_LISTEN);
        let listen: SocketAddr = listen
            .parse()
            .map_err(|_| format!("HUBD_LISTEN 不是合法地址：{listen}"))?;
        let allowed_users: Vec<String> = var("HUBD_ALLOWED_USERS", "")
            .split(',')
            .map(str::trim)
            .filter(|user| !user.is_empty())
            .map(str::to_string)
            .collect();
        // 连上 hubd 就等于能在服务器上执行命令，只能监听回环地址，或校验身份的 Tailscale 地址。
        if !listen.ip().is_loopback() {
            if !is_tailscale_ip(listen.ip()) {
                return Err(format!("只能监听回环或 Tailscale 地址：{listen}"));
            }
            if allowed_users.is_empty() {
                return Err("监听 Tailscale 地址时必须配置 HUBD_ALLOWED_USERS".to_string());
            }
        }

        let state_dir = PathBuf::from(var("HUBD_STATE_DIR", DEFAULT_STATE_DIR));
        if !state_dir.is_absolute() {
            return Err(format!(
                "HUBD_STATE_DIR 必须是绝对路径：{}",
                state_dir.display()
            ));
        }
        let retention_days = var("HUBD_RETENTION_DAYS", "7");
        let retention_days: u64 = retention_days
            .parse()
            .map_err(|_| format!("HUBD_RETENTION_DAYS 必须是数字：{retention_days}"))?;
        let megabytes = |name: &str, default: &str| {
            let value = var(name, default);
            value
                .parse::<u64>()
                .map_err(|_| format!("{name} 必须是数字：{value}"))
        };
        let session_memory_max_mb = megabytes("HUBD_SESSION_MEMORY_MAX_MB", "600")?;
        let min_available_mb = megabytes("HUBD_MIN_AVAILABLE_MB", "300")?;

        let host = match var("HUBD_HOST", "systemd").as_str() {
            "systemd" => HostKind::Systemd,
            "direct" => HostKind::Direct,
            other => return Err(format!("HUBD_HOST 只能是 systemd 或 direct：{other}")),
        };

        Ok(Self {
            listen,
            state_dir,
            host,
            claude_cmd: var("HUBD_CLAUDE_CMD", DEFAULT_CLAUDE_CMD),
            workspace_cmd: var("HUBD_WORKSPACE_CMD", "cc-workspace"),
            allowed_users,
            retention: Duration::from_secs(retention_days * 24 * 60 * 60),
            session_memory_max_mb,
            min_available_mb,
        })
    }
}
