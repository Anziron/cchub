//! 工作区选择：列设备目录和挂载都交给外部命令，`hubd` 只转发结果。
//!
//! 命令约定（默认 `cc-workspace`，可用 `HUBD_WORKSPACE_CMD` 替换）：
//! - `devices`：每行一个设备名。
//! - `ls <设备> [路径]`：第 1 行当前路径，第 2 行上一级，之后每行一个子目录的完整路径。
//! - `mount <设备> <路径>`：输出服务器上的路径。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path};
use std::process::Command;
use std::time::Duration;

use crate::runner;

const BROWSE_TIMEOUT: Duration = Duration::from_secs(15);
const MOUNT_TIMEOUT: Duration = Duration::from_secs(30);
/// 查看任务输出只看末尾，日志再大也不占内存。
const TASK_OUTPUT_TAIL: u64 = 64 * 1024;

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

pub fn mount(program: &str, device: &str, path: &str) -> Result<String, String> {
    let output = run(program, &["mount", device, path], MOUNT_TIMEOUT)
        .map_err(|_| "挂载失败：设备离线，或这个目录下已有挂载的项目".to_string())?;
    match output.trim() {
        "" => Err("挂载命令没有返回路径".to_string()),
        cwd => Ok(cwd.to_string()),
    }
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
    let failed = |_| "输出文件读取失败，可能已被清理".to_string();
    let mut file = File::open(path).map_err(failed)?;
    let length = file.metadata().map_err(failed)?.len();
    file.seek(SeekFrom::Start(length.saturating_sub(TASK_OUTPUT_TAIL)))
        .map_err(failed)?;
    let mut bytes = Vec::new();
    file.take(TASK_OUTPUT_TAIL)
        .read_to_end(&mut bytes)
        .map_err(failed)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
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
    }
}
