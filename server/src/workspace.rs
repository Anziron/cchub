//! 工作区选择：列设备目录和挂载都交给外部命令，`hubd` 只转发结果。
//!
//! 命令约定（默认 `cc-workspace`，可用 `HUBD_WORKSPACE_CMD` 替换）：
//! - `devices`：每行一个设备名。
//! - `ls <设备> [路径]`：第 1 行当前路径，第 2 行上一级，之后每行一个子目录的完整路径。
//! - `status`：每行 `设备\t系统\tonline|offline`。
//! - `mount <设备> <路径>`：输出服务器上的路径。
//! - `ensure <服务器上的路径>`：确认 `/mnt/<设备>/...` 已挂载，没有就补挂；成功时退出码为 0。

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path};
use std::process::Command;
use std::time::Duration;

use cchub_protocol::{is_conversation_line, DeviceInfo};

use crate::runner;

const BROWSE_TIMEOUT: Duration = Duration::from_secs(15);
const MOUNT_TIMEOUT: Duration = Duration::from_secs(30);
/// 查看任务输出只看末尾，日志再大也不占内存。
const TASK_OUTPUT_TAIL: u64 = 64 * 1024;
/// 子代理任务的输出文件链接到它的完整记录 `.jsonl`，夹着大量内部记录，单行可达几十 KB：
/// 读更长的末尾，只留对话行，返回的整行合计不超过这个长度。
const TRANSCRIPT_TAIL: u64 = 2 * 1024 * 1024;
const TRANSCRIPT_MAX: usize = 256 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub struct Listing {
    pub path: Option<String>,
    pub parent: Option<String>,
    pub entries: Vec<String>,
}

fn run(program: &str, args: &[&str], timeout: Duration) -> Result<String, ()> {
    let mut command = Command::new(program);
    command.args(args);
    match runner::run(command, timeout) {
        Some((true, output)) => Ok(String::from_utf8_lossy(&output).into_owned()),
        _ => Err(()),
    }
}

pub fn browse(program: &str, device: Option<&str>, path: Option<&str>) -> Result<Listing, String> {
    let Some(device) = device else {
        let output = run(program, &["devices"], BROWSE_TIMEOUT)
            .map_err(|_| "读取设备列表失败".to_string())?;
        return Ok(Listing {
            path: None,
            parent: None,
            entries: output.lines().map(str::to_string).collect(),
        });
    };
    let mut args = vec!["ls", device];
    args.extend(path);
    let output = run(program, &args, BROWSE_TIMEOUT)
        .map_err(|_| "读取目录失败：设备离线、没有权限或路径不存在".to_string())?;
    Ok(parse_listing(&output))
}

/// `status`：每行 `设备\t系统\tonline|offline`，系统可为空。
pub fn status(program: &str) -> Result<Vec<DeviceInfo>, String> {
    let output = run(program, &["status"], BROWSE_TIMEOUT)
        .map_err(|_| "读取设备状态失败".to_string())?;
    Ok(parse_status(&output))
}

fn parse_status(output: &str) -> Vec<DeviceInfo> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\t');
            let name = fields.next().filter(|name| !name.is_empty())?;
            let os = fields.next().filter(|os| !os.is_empty());
            let online = fields.next() == Some("online");
            Some(DeviceInfo {
                name: name.to_string(),
                os: os.map(str::to_string),
                online,
            })
        })
        .collect()
}

pub fn mount(program: &str, device: &str, path: &str) -> Result<String, String> {
    let output = run(program, &["mount", device, path], MOUNT_TIMEOUT)
        .map_err(|_| "挂载失败：设备离线，或这个目录下已有挂载的项目".to_string())?;
    match output.trim() {
        "" => Err("挂载命令没有返回路径".to_string()),
        cwd => Ok(cwd.to_string()),
    }
}

/// 启动会话前确认项目目录还挂着，没挂上就补挂。挂载会因服务器重启、sshfs 退出而消失，
/// 不补的话目录只是个空文件夹，探测也会当成在线，会话就在空目录里启动。
pub fn ensure(program: &str, path: &Path) -> Result<(), String> {
    let path = path.to_str().ok_or("项目目录不是 UTF-8")?;
    run(program, &["ensure", path], MOUNT_TIMEOUT)
        .map(drop)
        .map_err(|_| "项目目录没有挂载，补挂失败：设备离线？".to_string())
}

/// 只放行 CLI 写的后台任务输出，别的路径都不读，这个接口不能变成任意读文件。
fn is_task_output(path: &str) -> bool {
    let path = Path::new(path);
    let mut parts = path.components();
    let safe = path
        .components()
        .all(|part| !matches!(part, Component::ParentDir));
    let in_tmp = matches!(parts.next(), Some(Component::RootDir))
        && matches!(parts.next(), Some(Component::Normal(dir)) if dir == "tmp")
        && matches!(parts.next(), Some(Component::Normal(dir))
            if dir.to_str().is_some_and(|name| name.starts_with("claude-")));
    let in_tasks = path
        .parent()
        .and_then(Path::file_name)
        .is_some_and(|name| name == "tasks");
    safe && in_tmp && in_tasks && path.extension().is_some_and(|ext| ext == "output")
}

pub fn read_task_output(path: &str) -> Result<String, String> {
    if !is_task_output(path) {
        return Err("不是后台任务的输出文件".to_string());
    }
    let transcript = fs::canonicalize(path)
        .is_ok_and(|target| target.extension().is_some_and(|ext| ext == "jsonl"));
    let tail = if transcript {
        TRANSCRIPT_TAIL
    } else {
        TASK_OUTPUT_TAIL
    };
    let failed = |_| "输出文件读取失败，可能已被清理".to_string();
    let mut file = File::open(path).map_err(failed)?;
    let length = file.metadata().map_err(failed)?.len();
    let start = length.saturating_sub(tail);
    file.seek(SeekFrom::Start(start)).map_err(failed)?;
    let mut bytes = Vec::new();
    file.take(tail).read_to_end(&mut bytes).map_err(failed)?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(if transcript {
        conversation_tail(&text, start > 0, TRANSCRIPT_MAX)
    } else {
        text.into_owned()
    })
}

/// 只留对话行，从后往前取整行，合计不超过 `max`（至少留一行）。
/// 不是从头读时第一行是半行，丢掉；最后一行可能还没写完，解析不了也会被过滤。
fn conversation_tail(text: &str, partial_first: bool, max: usize) -> String {
    let skip = usize::from(partial_first);
    let mut kept = Vec::new();
    let mut size = 0;
    for line in text
        .lines()
        .skip(skip)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        if !is_conversation_line(line) {
            continue;
        }
        if !kept.is_empty() && size + line.len() + 1 > max {
            break;
        }
        size += line.len() + 1;
        kept.push(line);
    }
    kept.reverse();
    kept.join("\n")
}

fn parse_listing(output: &str) -> Listing {
    let not_empty = |line: Option<&str>| line.filter(|l| !l.is_empty()).map(str::to_string);
    let mut lines = output.lines();
    Listing {
        path: not_empty(lines.next()),
        parent: not_empty(lines.next()),
        entries: lines
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_current_parent_and_children() {
        assert_eq!(
            parse_listing("D:\\cchub\nD:\\\nD:\\cchub\\web\nD:\\cchub\\docs\n"),
            Listing {
                path: Some("D:\\cchub".into()),
                parent: Some("D:\\".into()),
                entries: vec!["D:\\cchub\\web".into(), "D:\\cchub\\docs".into()],
            }
        );
    }

    #[test]
    fn empty_path_and_parent_mean_the_list_of_drives() {
        assert_eq!(
            parse_listing("\n\nC:\\\nD:\\\n"),
            Listing {
                path: None,
                parent: None,
                entries: vec!["C:\\".into(), "D:\\".into()],
            }
        );
    }

    #[test]
    fn parses_device_status_lines() {
        assert_eq!(
            parse_status("pc-company\tWindows\tonline\nmac\t\toffline\n\nbad\n"),
            vec![
                DeviceInfo {
                    name: "pc-company".into(),
                    os: Some("Windows".into()),
                    online: true
                },
                DeviceInfo {
                    name: "mac".into(),
                    os: None,
                    online: false
                },
                DeviceInfo {
                    name: "bad".into(),
                    os: None,
                    online: false
                },
            ]
        );
        assert!(status("/bin/false").is_err());
    }

    #[test]
    fn only_task_output_files_can_be_read() {
        assert!(is_task_output("/tmp/claude-0/-mnt-x/abc/tasks/b1.output"));
        assert!(!is_task_output("/etc/passwd"));
        assert!(!is_task_output("/root/.ssh/id_ed25519"));
        assert!(!is_task_output("/tmp/claude-0/x/tasks/b1.txt"));
        assert!(!is_task_output("/tmp/other/x/tasks/b1.output"));
        assert!(!is_task_output("/tmp/claude-0/../../etc/tasks/b1.output"));
        assert!(!is_task_output("tmp/claude-0/x/tasks/b1.output"));
        assert!(read_task_output("/etc/passwd").is_err());
    }

    #[test]
    fn failing_command_is_an_error_not_an_empty_listing() {
        assert!(browse("/bin/false", Some("pc"), None).is_err());
        assert!(browse("/nonexistent/cc-workspace", None, None).is_err());
        assert!(mount("/bin/false", "pc", "/x").is_err());
        assert!(ensure("/bin/false", Path::new("/mnt/pc/d/x")).is_err());
        assert!(ensure("/bin/true", Path::new("/mnt/pc/d/x")).is_ok());
    }

    #[test]
    fn transcript_keeps_whole_conversation_lines_within_limit() {
        let user = r#"{"type":"user","message":{"content":"hi"}}"#;
        let assistant = r#"{"type":"assistant","message":{"content":[]}}"#;
        let blob = r#"{"type":"api-request-blob","content":"system prompt"}"#;
        let text = format!("pe\":1}}\n{user}\n{blob}\n{assistant}\n{{\"type\":\"assis");
        assert_eq!(
            conversation_tail(&text, true, 1024),
            format!("{user}\n{assistant}")
        );
        // 第一行完整时不丢。
        assert_eq!(
            conversation_tail(&format!("{user}\n{blob}"), false, 1024),
            user
        );
        // 超长时只留最后的整行，但至少一行。
        assert_eq!(
            conversation_tail(&format!("{user}\n{assistant}"), false, assistant.len() + 1),
            assistant
        );
        assert_eq!(
            conversation_tail(&format!("{user}\n{assistant}"), false, 1),
            assistant
        );
    }
}
