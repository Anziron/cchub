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

pub fn is_allowed(peer: SocketAddr, allowed_users: &[String]) -> bool {
    is_allowed_with(peer, allowed_users, tailscale_login)
}

fn is_allowed_with(
    peer: SocketAddr,
    allowed_users: &[String],
    lookup: impl FnOnce(SocketAddr) -> Option<String>,
) -> bool {
    if peer.ip().is_loopback() {
        return true;
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

    #[test]
    fn fails_closed() {
        let allowed = vec!["me@example".to_string()];
        let peer = addr("100.64.0.2:1000");
        let found = |name: &'static str| move |_| Some(name.to_string());

        assert!(is_allowed_with(addr("127.0.0.1:1"), &[], |_| None));
        assert!(is_allowed_with(peer, &allowed, found("me@example")));
        assert!(!is_allowed_with(peer, &allowed, found("other@example")));
        assert!(!is_allowed_with(peer, &allowed, |_| None));
        assert!(!is_allowed_with(peer, &[], found("me@example")));
        assert!(!is_allowed_with(
            addr("8.8.8.8:1"),
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
