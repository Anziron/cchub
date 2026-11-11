//! 整体用量：交给外部命令统计 `~/.claude/projects` 下的会话记录，`hubd` 只转发它输出的 JSON，不解析。
//!
//! 命令约定（默认 `cchub-usage`，见 `tools/usage/`；可用 `HUBD_USAGE_CMD` 替换，为空时关闭）：
//! `<命令> --tz <分钟>`，成功时标准输出是一行 JSON，失败时退出码非 0。

use std::process::Command;
use std::time::Duration;

use crate::runner;

/// 首次统计约 200MB 记录要几秒；有缓存时不到 1 秒。
const TIMEOUT: Duration = Duration::from_secs(60);
/// 输出上限：命令出错时不把大量内容转给客户端。
const MAX_OUTPUT: usize = 4 * 1024 * 1024;
/// 时区偏移的合法范围（UTC−14 到 UTC+14）。
const MAX_TZ_MINUTES: i32 = 14 * 60;

/// `scope_memory_mb` 大于 0 时放进独立的 systemd scope：`hubd` 自己的 `MemoryMax` 很小。
fn command(program: &str, tz_offset: i32, scope_memory_mb: u64) -> Command {
    let mut command = if scope_memory_mb > 0 {
        let mut command = Command::new("systemd-run");
        command
            .args(["-q", "--scope", "--collect", "-p"])
            .arg(format!("MemoryMax={scope_memory_mb}M"))
            .arg(program);
        command
    } else {
        Command::new(program)
    };
    command.arg("--tz").arg(tz_offset.to_string());
    command
}

pub fn stats(program: &str, tz_offset: i32, scope_memory_mb: u64) -> Result<String, String> {
    if program.is_empty() {
        return Err("服务器没有配置用量统计命令".to_string());
    }
    let tz_offset = tz_offset.clamp(-MAX_TZ_MINUTES, MAX_TZ_MINUTES);
    match runner::run(command(program, tz_offset, scope_memory_mb), TIMEOUT) {
        Some((true, output)) if output.len() > MAX_OUTPUT => Err("统计结果过大".to_string()),
        Some((true, output)) => match String::from_utf8_lossy(&output).trim() {
            "" => Err("统计命令没有输出".to_string()),
            text => Ok(text.to_string()),
        },
        Some((false, _)) => Err("统计命令出错".to_string()),
        None => Err("统计命令没有安装，或运行超时".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_timezone_and_returns_trimmed_output() {
        // `echo` 把参数原样输出，正好用来检查传给命令的参数。
        assert_eq!(stats("echo", 480, 0), Ok("--tz 480".to_string()));
        assert_eq!(stats("echo", -300, 0), Ok("--tz -300".to_string()));
    }

    #[test]
    fn clamps_timezone() {
        assert_eq!(stats("echo", 99_999, 0), Ok("--tz 840".to_string()));
        assert_eq!(stats("echo", -99_999, 0), Ok("--tz -840".to_string()));
    }

    #[test]
    fn failures_are_errors() {
        assert!(stats("", 0, 0).is_err());
        assert!(stats("/bin/false", 0, 0).is_err());
        assert!(stats("/nonexistent/cchub-usage", 0, 0).is_err());
        assert!(stats("true", 0, 0).is_err());
    }
}
