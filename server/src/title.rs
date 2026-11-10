//! 新会话的标题：后台运行一次外部命令（默认是 haiku），把第一条消息概括成短标题。
//!
//! 命令从标准输入读提示词，标准输出的第一行是标题。失败、超时或输出不合格时保留原标题。

use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

/// 不加载用户配置、技能和工具，一次约 650 token、3～4 秒。
pub const DEFAULT_TITLE_CMD: &str = "claude -p --model haiku --no-session-persistence \
    --setting-sources project --tools '' --strict-mcp-config \
    --system-prompt '你只负责给会话起简短标题。'";

/// 标题最多这么多个字符。
const MAX_CHARS: usize = 20;
/// 提示词里只放第一条消息的前这么多个字符，长文本不必全给。
const MAX_PROMPT_CHARS: usize = 2000;
const POLL: Duration = Duration::from_millis(100);

pub fn prompt(text: &str) -> String {
    let text: String = text.chars().take(MAX_PROMPT_CHARS).collect();
    format!(
        "给下面这条用户请求起一个会话标题：一个短语，最多 12 个字，\
         例如“修复额度不刷新”“侧边栏改版”。和请求用同一种语言。\
         只输出标题本身，不要标点、引号和解释。\n\n请求：{text}"
    )
}

/// 取第一行非空内容，去掉常见的包装（引号、书名号、“标题：”、末尾标点），截到 `MAX_CHARS`。
pub fn clean(output: &str) -> Option<String> {
    let line = output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let line = line
        .strip_prefix("标题：")
        .or_else(|| line.strip_prefix("标题:"))
        .or_else(|| line.strip_prefix("Title:"))
        .unwrap_or(line)
        .trim();
    const WRAP: &[char] = &[
        '"', '\'', '“', '”', '‘', '’', '「', '」', '《', '》', '【', '】', '`', '*', '#',
    ];
    const END: &[char] = &[
        '。', '.', '！', '!', '？', '?', '，', ',', '；', ';', '：', ':',
    ];
    let line = line.trim_matches(WRAP).trim().trim_end_matches(END).trim();
    // 模型不总守字数：太长时取第一个分隔符前的部分，通常就是主题。
    const SPLIT: &[char] = &['：', ':', '，', ',', '；', ';', '—', '（', '('];
    let line = match line.split_once(SPLIT) {
        Some((head, _)) if line.chars().count() > MAX_CHARS && !head.trim().is_empty() => {
            head.trim()
        }
        _ => line,
    };
    if line.is_empty() {
        return None;
    }
    Some(line.chars().take(MAX_CHARS).collect())
}

/// 运行 `cmd`（交给 `sh -c`），超时就结束它。`scope_memory_mb` 大于 0 时放进独立的
/// systemd scope：`hubd` 自己的 `MemoryMax` 很小，装不下一个 `claude` 进程。
pub fn generate(
    cmd: &str,
    cwd: &Path,
    scope_memory_mb: u64,
    text: &str,
    timeout: Duration,
) -> Option<String> {
    let mut command = if scope_memory_mb > 0 {
        let mut command = Command::new("systemd-run");
        command
            .args(["-q", "--scope", "--collect", "-p"])
            .arg(format!("MemoryMax={scope_memory_mb}M"))
            .arg("/bin/sh");
        command
    } else {
        Command::new("/bin/sh")
    };
    let mut child = command
        .arg("-c")
        .arg(cmd)
        .current_dir(cwd)
        // 单独的进程组：超时时连同 `sh` 启动的子进程一起结束。
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // 提示词很短，一次写完再关掉标准输入，命令才知道输入结束了。
    let written = child
        .stdin
        .take()
        .is_some_and(|mut stdin| stdin.write_all(prompt(text).as_bytes()).is_ok());
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => sleep(POLL),
            _ => {
                // SAFETY: 只向刚启动的子进程所在的进程组发信号。
                unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
                let _ = child.wait();
                break None;
            }
        }
    };
    if !written || !status?.success() {
        return None;
    }
    // 输出只有一行，不会写满管道缓冲，所以可以等进程结束再读。
    let mut output = String::new();
    child.stdout.take()?.read_to_string(&mut output).ok()?;
    clean(&output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_takes_first_line_and_strips_wrapping() {
        assert_eq!(
            clean("\n  修复额度不刷新\n解释").as_deref(),
            Some("修复额度不刷新")
        );
        assert_eq!(
            clean("“修复额度不刷新。”").as_deref(),
            Some("修复额度不刷新")
        );
        assert_eq!(clean("标题：侧边栏改版").as_deref(), Some("侧边栏改版"));
        assert_eq!(
            clean("**Fix login bug.**").as_deref(),
            Some("Fix login bug")
        );
        assert_eq!(
            clean("优化左侧边栏：项目名作主标题，会话名由模型生成").as_deref(),
            Some("优化左侧边栏")
        );
        assert_eq!(
            clean("修登录：加验证码").as_deref(),
            Some("修登录：加验证码")
        );
        assert_eq!(clean("  \n \n"), None);
        assert_eq!(clean("「」"), None);
    }

    #[test]
    fn clean_truncates_long_titles() {
        assert_eq!(
            clean("一二三四五六七八九十一二三四五六七八九十多出来").as_deref(),
            Some("一二三四五六七八九十一二三四五六七八九十")
        );
    }

    #[test]
    fn prompt_limits_long_messages() {
        let long = "啊".repeat(5000);
        assert_eq!(prompt(&long).matches('啊').count(), 2000);
    }

    #[test]
    fn generate_reads_title_from_command() {
        let dir = std::env::temp_dir();
        let title = generate(
            "cat >/dev/null; echo '“改侧边栏。”'",
            &dir,
            0,
            "x",
            Duration::from_secs(5),
        );
        assert_eq!(title.as_deref(), Some("改侧边栏"));
    }

    #[test]
    fn generate_gives_up_on_failure_and_timeout() {
        let dir = std::env::temp_dir();
        assert_eq!(
            generate(
                "cat >/dev/null; exit 1",
                &dir,
                0,
                "x",
                Duration::from_secs(5)
            ),
            None
        );
        let started = Instant::now();
        assert_eq!(
            generate("sleep 5", &dir, 0, "x", Duration::from_millis(300)),
            None
        );
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
