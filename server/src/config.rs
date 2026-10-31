use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;

const DEFAULT_LISTEN: &str = "127.0.0.1:7878";
const DEFAULT_STATE_DIR: &str = "/var/lib/hubd";
const DEFAULT_CLAUDE_CMD: &str = "claude -p --input-format stream-json \
    --output-format stream-json --verbose --permission-prompt-tool stdio \
    --include-partial-messages";

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
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let var = |name: &str, default: &str| env::var(name).unwrap_or_else(|_| default.into());

        let listen = var("HUBD_LISTEN", DEFAULT_LISTEN);
        let listen: SocketAddr = listen
            .parse()
            .map_err(|_| format!("HUBD_LISTEN 不是合法地址：{listen}"))?;
        // 设备身份校验实现之前不能对外监听：连上 hubd 就等于能在服务器上执行命令。
        if !listen.ip().is_loopback() {
            return Err(format!("暂不支持非回环监听地址：{listen}"));
        }

        let host = match var("HUBD_HOST", "systemd").as_str() {
            "systemd" => HostKind::Systemd,
            "direct" => HostKind::Direct,
            other => return Err(format!("HUBD_HOST 只能是 systemd 或 direct：{other}")),
        };

        Ok(Self {
            listen,
            state_dir: var("HUBD_STATE_DIR", DEFAULT_STATE_DIR).into(),
            host,
            claude_cmd: var("HUBD_CLAUDE_CMD", DEFAULT_CLAUDE_CMD),
        })
    }
}
