//! 工作区选择：列设备目录和挂载都交给外部命令，`hubd` 只转发结果。
//!
//! 命令约定（默认 `cc-workspace`，可用 `HUBD_WORKSPACE_CMD` 替换）：
//! - `devices`：每行一个设备名。
//! - `ls <设备> [路径]`：第 1 行当前路径，第 2 行上一级，之后每行一个子目录的完整路径。
//! - `mount <设备> <路径>`：输出服务器上的路径。

use std::process::Command;
use std::time::Duration;

use crate::runner;

const BROWSE_TIMEOUT: Duration = Duration::from_secs(15);
const MOUNT_TIMEOUT: Duration = Duration::from_secs(30);

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
    fn failing_command_is_an_error_not_an_empty_listing() {
        assert!(browse("/bin/false", Some("pc"), None).is_err());
        assert!(browse("/nonexistent/cc-workspace", None, None).is_err());
        assert!(mount("/bin/false", "pc", "/x").is_err());
    }
}
