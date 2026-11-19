//! 来访身份校验。`hubd` 能间接在服务器上执行命令，来访者身份无法确认时一律拒绝。

use std::net::{IpAddr, SocketAddr};
use std::process::Command;
use std::time::Duration;

use crate::runner;

const WHOIS_TIMEOUT: Duration = Duration::from_secs(5);

/// Tailscale 的地址段：100.64.0.0/10 和 fd7a:115c:a1e0::/48。
pub fn is_tailscale_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, ..] = ip.octets();
            a == 100 && (64..128).contains(&b)
        }
        IpAddr::V6(ip) => matches!(ip.segments(), [0xfd7a, 0x115c, 0xa1e0, ..]),
    }
}

fn login_name(whois_json: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(whois_json).ok()?;
    let name = value.pointer("/UserProfile/LoginName")?.as_str()?;
    Some(name.to_string())
}

fn tailscale_login(peer: SocketAddr) -> Option<String> {
    let mut command = Command::new("tailscale");
    command.args(["whois", "--json"]).arg(peer.to_string());
    let (success, output) = runner::run(command, WHOIS_TIMEOUT)?;
    if success {
        login_name(&output)
    } else {
        None
    }
}

pub fn is_allowed(peer: SocketAddr, listen: SocketAddr, allowed_users: &[String]) -> bool {
    is_allowed_with(peer, listen, allowed_users, tailscale_login)
}

/// 只监听回环时，来访的只能是本机，放行（测试和临时实例用）。
/// 监听 Tailscale 地址时，本机进程（包括会话里模型跑的命令）连过来，源地址是回环或监听地址本身，
/// 而服务器节点和设备属于同一个账号，whois 会放行；它们能给自己批审批、开会话，所以一律拒绝。
fn is_allowed_with(
    peer: SocketAddr,
    listen: SocketAddr,
    allowed_users: &[String],
    lookup: impl FnOnce(SocketAddr) -> Option<String>,
) -> bool {
    if listen.ip().is_loopback() {
        return peer.ip().is_loopback();
    }
    if peer.ip().is_loopback() || peer.ip() == listen.ip() {
        return false;
    }
    if !is_tailscale_ip(peer.ip()) {
        return false;
    }
    lookup(peer).is_some_and(|login| allowed_users.contains(&login))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(text: &str) -> SocketAddr {
        text.parse().unwrap()
    }

    #[test]
    fn recognizes_tailscale_ranges() {
        for ip in ["100.64.0.1", "100.127.255.255", "fd7a:115c:a1e0::1"] {
            assert!(is_tailscale_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["100.63.0.1", "100.128.0.1", "10.0.0.1", "fd7a:115c:a1e1::1"] {
            assert!(!is_tailscale_ip(ip.parse().unwrap()), "{ip}");
        }
    }

    fn me(_: SocketAddr) -> Option<String> {
        Some("me@example".to_string())
    }

    #[test]
    fn loopback_listen_only_serves_this_host() {
        let listen = addr("127.0.0.1:7878");
        assert!(is_allowed_with(addr("127.0.0.1:1"), listen, &[], |_| None));
    }

    #[test]
    fn rejects_this_host_when_listening_on_tailscale() {
        // 服务器自己也是这个账号的节点：本机进程连监听地址时，源地址就是监听地址，whois 会放行。
        let allowed = vec!["me@example".to_string()];
        let listen = addr("100.90.0.1:7878");
        assert!(!is_allowed_with(
            addr("100.90.0.1:5555"),
            listen,
            &allowed,
            me
        ));
        assert!(!is_allowed_with(
            addr("127.0.0.1:5555"),
            listen,
            &allowed,
            me
        ));
        assert!(!is_allowed_with(addr("[::1]:5555"), listen, &allowed, me));
        assert!(is_allowed_with(
            addr("100.64.0.2:5555"),
            listen,
            &allowed,
            me
        ));
    }

    #[test]
    fn fails_closed() {
        let allowed = vec!["me@example".to_string()];
        let listen = addr("100.90.0.1:7878");
        let peer = addr("100.64.0.2:1000");
        let found = |name: &'static str| move |_| Some(name.to_string());

        assert!(is_allowed_with(peer, listen, &allowed, found("me@example")));
        assert!(!is_allowed_with(
            peer,
            listen,
            &allowed,
            found("other@example")
        ));
        assert!(!is_allowed_with(peer, listen, &allowed, |_| None));
        assert!(!is_allowed_with(peer, listen, &[], found("me@example")));
        assert!(!is_allowed_with(
            addr("8.8.8.8:1"),
            listen,
            &allowed,
            found("me@example")
        ));
    }

    #[test]
    fn parses_login_name() {
        let json = br#"{"Node":{"Name":"x"},"UserProfile":{"LoginName":"me@example"}}"#;
        assert_eq!(login_name(json).as_deref(), Some("me@example"));
        assert_eq!(login_name(b"{}"), None);
        assert_eq!(login_name(b"not json"), None);
    }
}
