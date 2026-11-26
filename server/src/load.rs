//! 服务器负载：整台机器的 CPU、内存，各会话和其他进程的占用。只读 `/proc` 和 cgroup，不起子进程。
//!
//! CPU 使用率要两次采样相减。上一次的累计值留在 `Sampler` 里，客户端定时来问，每次都和上一次比；
//! 还没有上一次、或上一次太久远时，先采一次，隔一小会儿再采。

use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use cchub_protocol::{HostLoad, ProcessLoad, SessionLoad};

use crate::host::{ProcessHost, Usage, UNIT_PREFIX};

/// 上一次采样超过这么久就不拿来比，免得报的是很久以前的平均值。
const STALE: Duration = Duration::from_secs(30);
/// 没有可比的上一次时，两次采样的间隔。
const BASELINE: Duration = Duration::from_millis(300);
/// “其他进程”报几个。
const TOP_OTHERS: usize = 4;

/// 所有连接共用：每次统计都和最近一次（不管是谁问的）比。
#[derive(Default)]
pub struct Sampler {
    last: Mutex<Option<Snapshot>>,
}

/// 留给下一次比的累计值。
struct Snapshot {
    at: Instant,
    cpu: CpuTimes,
    /// 会话 → 累计 CPU 微秒。
    sessions: HashMap<String, u64>,
    /// （PID，启动时刻）→ 累计 CPU 节拍。带上启动时刻，PID 被复用时不会接着算。
    procs: HashMap<(u32, u64), u64>,
}

/// `/proc/stat` 第一行：所有核合计的节拍数。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CpuTimes {
    total: u64,
    idle: u64,
}

/// `/proc/<pid>/stat` 里用到的字段。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proc {
    pub pid: u32,
    pub name: String,
    /// 进程组号。
    pub group: u32,
    /// 启动时刻（开机后的节拍数）。
    pub start: u64,
    /// 自己用的 CPU 节拍（用户态 + 内核态）。
    pub ticks: u64,
    /// 已退出并被回收的子进程用的 CPU 节拍。
    pub child_ticks: u64,
    pub rss_pages: u64,
    /// 内核线程（如 `kworker`）：没有用户态内存和工作目录，不算“其他进程”。
    pub kernel: bool,
}

/// `/proc/<pid>/stat` 第 9 个字段（flags）里表示内核线程的位，见 `include/linux/sched.h`。
const PF_KTHREAD: u64 = 0x0020_0000;

impl Sampler {
    /// `sessions` 是所有会话的 ID 和目录，没在运行的由 `host.usage` 排除。
    pub fn measure(
        &self,
        host: &dyn ProcessHost,
        sessions: &[(String, PathBuf)],
    ) -> Result<HostLoad, String> {
        // 同一时间只统计一次：两次采样之间要停一小会儿，排队的请求接着用刚采的。
        let mut last = self.last.lock().unwrap_or_else(PoisonError::into_inner);
        let previous = match last.take().filter(|s| s.at.elapsed() < STALE) {
            Some(previous) => previous,
            None => {
                let at = Instant::now();
                let (cpu, _) = read_cpu()?;
                let first = snapshot(at, cpu, &session_usage(host, sessions), &read_procs());
                std::thread::sleep(BASELINE);
                first
            }
        };

        let at = Instant::now();
        let (cpu, cpus) = read_cpu()?;
        let usage = session_usage(host, sessions);
        let procs = read_procs();
        let load_x100 = fs::read_to_string("/proc/loadavg")
            .ok()
            .and_then(|text| parse_loadavg(&text))
            .ok_or("读不了 /proc/loadavg")?;
        let (mem_total_mb, mem_available_mb) = fs::read_to_string("/proc/meminfo")
            .ok()
            .and_then(|text| parse_meminfo(&text))
            .ok_or("读不了 /proc/meminfo")?;

        let elapsed_usec = at.duration_since(previous.at).as_micros();
        let total_ticks = cpu.total.saturating_sub(previous.cpu.total);
        let busy = |times: CpuTimes| times.total.saturating_sub(times.idle);
        let cpu_permille = share(
            u128::from(busy(cpu).saturating_sub(busy(previous.cpu))),
            u128::from(total_ticks),
        );

        let mut session_loads: Vec<SessionLoad> = usage
            .iter()
            .map(|(id, usage)| {
                let before = previous.sessions.get(id).copied().unwrap_or(0);
                SessionLoad {
                    session: id.clone(),
                    cpu_permille: share(
                        u128::from(usage.cpu_usec.saturating_sub(before)),
                        elapsed_usec * u128::from(cpus),
                    ),
                    mem_mb: megabytes(usage.mem_bytes),
                }
            })
            .collect();
        session_loads.sort_by_key(|load| Reverse((load.cpu_permille, load.mem_mb)));

        // 会话的进程不算“其他进程”：DirectHost 按进程组认，systemd 按 cgroup 认（只查排在前面的几个）。内核线程也不算。
        let groups: HashSet<u32> = usage.iter().filter_map(|(_, usage)| usage.group).collect();
        let mut ranked: Vec<(u32, &Proc)> = procs
            .iter()
            .filter(|process| !process.kernel && !groups.contains(&process.group))
            .map(|process| {
                let before = previous
                    .procs
                    .get(&(process.pid, process.start))
                    .copied()
                    .unwrap_or(0);
                let ticks = u128::from(process.ticks.saturating_sub(before));
                (share(ticks, u128::from(total_ticks)), process)
            })
            .collect();
        ranked.sort_by_key(|(cpu, process)| Reverse((*cpu, process.rss_pages)));
        let page = page_size();
        let others = ranked
            .into_iter()
            .filter(|(_, process)| !in_session_unit(process.pid))
            .take(TOP_OTHERS)
            .map(|(cpu_permille, process)| ProcessLoad {
                pid: process.pid,
                name: process.name.clone(),
                cwd: fs::read_link(format!("/proc/{}/cwd", process.pid))
                    .ok()
                    .map(|path| path.to_string_lossy().into_owned()),
                cpu_permille,
                mem_mb: megabytes(process.rss_pages.saturating_mul(page)),
            })
            .collect();

        *last = Some(snapshot(at, cpu, &usage, &procs));
        Ok(HostLoad {
            cpus,
            cpu_permille,
            load_x100,
            mem_total_mb,
            mem_available_mb,
            sessions: session_loads,
            others,
        })
    }
}

fn snapshot(at: Instant, cpu: CpuTimes, sessions: &[(String, Usage)], procs: &[Proc]) -> Snapshot {
    Snapshot {
        at,
        cpu,
        sessions: sessions
            .iter()
            .map(|(id, usage)| (id.clone(), usage.cpu_usec))
            .collect(),
        procs: procs
            .iter()
            .map(|process| ((process.pid, process.start), process.ticks))
            .collect(),
    }
}

fn session_usage(host: &dyn ProcessHost, sessions: &[(String, PathBuf)]) -> Vec<(String, Usage)> {
    sessions
        .iter()
        .filter_map(|(id, dir)| Some((id.clone(), host.usage(id, dir)?)))
        .collect()
}

fn read_cpu() -> Result<(CpuTimes, u32), String> {
    fs::read_to_string("/proc/stat")
        .ok()
        .and_then(|text| parse_cpu(&text))
        .ok_or_else(|| "读不了 /proc/stat".to_string())
}

fn read_procs() -> Vec<Proc> {
    let Ok(entries) = fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let pid = entry.file_name().to_str()?.parse().ok()?;
            proc_stat(pid)
        })
        .collect()
}

/// 进程在不在某个会话的 systemd unit 里。
fn in_session_unit(pid: u32) -> bool {
    fs::read_to_string(format!("/proc/{pid}/cgroup"))
        .is_ok_and(|text| text.contains(&format!("/{UNIT_PREFIX}")))
}

pub fn proc_stat(pid: u32) -> Option<Proc> {
    parse_proc(pid, &fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)
}

/// `part / whole` 换成千分比，四舍五入，最多 1000。
fn share(part: u128, whole: u128) -> u32 {
    if whole == 0 {
        return 0;
    }
    u32::try_from(((part * 1000 + whole / 2) / whole).min(1000)).unwrap_or(1000)
}

fn megabytes(bytes: u64) -> u32 {
    u32::try_from(bytes / (1024 * 1024)).unwrap_or(u32::MAX)
}

/// `/proc/stat`：第一行是所有核合计（单位是节拍），`cpuN` 行数就是核数。
fn parse_cpu(stat: &str) -> Option<(CpuTimes, u32)> {
    let first = stat.lines().next()?.strip_prefix("cpu ")?;
    let fields = first
        .split_whitespace()
        .map(|field| field.parse::<u64>().ok())
        .collect::<Option<Vec<_>>>()?;
    // user nice system idle iowait irq softirq steal；之后的 guest 已经算在 user 里。
    let total = fields.iter().take(8).sum();
    let idle = fields.get(3)? + fields.get(4).copied().unwrap_or(0);
    let cpus = stat
        .lines()
        .filter(|line| {
            line.strip_prefix("cpu")
                .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()))
        })
        .count();
    Some((CpuTimes { total, idle }, u32::try_from(cpus).ok()?.max(1)))
}

/// `/proc/loadavg` 的前三项，各乘 100 取整。
fn parse_loadavg(text: &str) -> Option<Vec<u32>> {
    let load = text
        .split_whitespace()
        .take(3)
        .map(|field| Some((field.parse::<f64>().ok()? * 100.0).round() as u32))
        .collect::<Option<Vec<_>>>()?;
    (load.len() == 3).then_some(load)
}

/// `/proc/meminfo` 的总量和可用量，MB。
fn parse_meminfo(text: &str) -> Option<(u32, u32)> {
    let kb = |key: &str| -> Option<u64> {
        text.lines()
            .find_map(|line| line.strip_prefix(key))?
            .split_whitespace()
            .next()?
            .parse()
            .ok()
    };
    Some((
        megabytes(kb("MemTotal:")? * 1024),
        megabytes(kb("MemAvailable:")? * 1024),
    ))
}

/// `/proc/<pid>/stat`。进程名在括号里，可能带空格和括号，所以从最后一个 `)` 往后数字段。
fn parse_proc(pid: u32, text: &str) -> Option<Proc> {
    let open = text.find('(')?;
    let close = text.rfind(')')?;
    let name = text.get(open + 1..close)?.to_string();
    let rest: Vec<&str> = text.get(close + 1..)?.split_whitespace().collect();
    // `rest[0]` 是第 3 个字段（状态），第 n 个字段在 `rest[n - 3]`。
    let field = |n: usize| -> Option<u64> { rest.get(n - 3)?.parse().ok() };
    Some(Proc {
        pid,
        name,
        group: u32::try_from(field(5)?).ok()?,
        start: field(22)?,
        ticks: field(14)? + field(15)?,
        child_ticks: field(16)? + field(17)?,
        rss_pages: field(24)?,
        kernel: field(9)? & PF_KTHREAD != 0,
    })
}

/// cgroup v2 的 `cpu.stat` 里的累计 CPU 微秒。
pub fn parse_usage_usec(text: &str) -> Option<u64> {
    text.lines()
        .find_map(|line| line.strip_prefix("usage_usec "))?
        .trim()
        .parse()
        .ok()
}

fn sysconf(name: libc::c_int) -> Option<u64> {
    // SAFETY: sysconf 只接收整数参数，不涉及内存。
    let value = unsafe { libc::sysconf(name) };
    u64::try_from(value).ok().filter(|value| *value > 0)
}

pub fn page_size() -> u64 {
    sysconf(libc::_SC_PAGESIZE).unwrap_or(4096)
}

/// `/proc/<pid>/stat` 里 CPU 时间的单位：每秒多少节拍。
pub fn clock_ticks() -> u64 {
    sysconf(libc::_SC_CLK_TCK).unwrap_or(100)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn parses_cpu_totals_and_core_count() {
        let stat = "cpu  100 5 50 800 20 3 2 1 7 0\n\
                    cpu0 50 2 25 400 10 1 1 0 3 0\n\
                    cpu1 50 3 25 400 10 2 1 1 4 0\n\
                    intr 12345\nctxt 999\n";
        let (times, cpus) = parse_cpu(stat).unwrap();
        // guest（7）不算：已经算在 user 里。
        assert_eq!(
            times,
            CpuTimes {
                total: 981,
                idle: 820,
            }
        );
        assert_eq!(cpus, 2);
        assert_eq!(parse_cpu("intr 1\n"), None);
    }

    #[test]
    fn parses_loadavg_and_meminfo() {
        assert_eq!(
            parse_loadavg("10.91 11.55 9.81 8/312 2375933\n"),
            Some(vec![1091, 1155, 981])
        );
        assert_eq!(parse_loadavg("0.5\n"), None);
        let meminfo = "MemTotal:        2014208 kB\nMemFree:          214000 kB\n\
                       MemAvailable:     758784 kB\n";
        assert_eq!(parse_meminfo(meminfo), Some((1967, 741)));
        assert_eq!(parse_meminfo("MemTotal: 1 kB\n"), None);
    }

    #[test]
    fn parses_process_name_with_spaces_and_parens() {
        let stat = "4242 (my (odd) name) S 1 4240 4240 0 -1 4194560 100 0 0 0 \
                    70 30 5 6 20 0 1 0 123456 104857600 2560 18446744073709551615";
        let process = parse_proc(4242, stat).unwrap();
        assert_eq!(process.name, "my (odd) name");
        assert_eq!(process.group, 4240);
        assert_eq!(process.ticks, 100);
        assert_eq!(process.child_ticks, 11);
        assert_eq!(process.start, 123456);
        assert_eq!(process.rss_pages, 2560);
        assert!(!process.kernel);
        assert_eq!(parse_proc(1, "1 (init) S 0"), None);
    }

    #[test]
    fn recognizes_kernel_threads() {
        // 取自真实的 /proc/101/stat：flags（第 9 个字段）带 PF_KTHREAD。
        let stat = "101 (kworker/R-crypt) I 2 0 0 0 -1 69238880 0 0 0 0 0 0 0 0 0 -20 1 0 64 \
                    0 0 18446744073709551615 0 0 0 0 0 0 0 2147483647 0 1 0 0 17 2 0 0";
        assert!(parse_proc(101, stat).unwrap().kernel);
    }

    #[test]
    fn parses_cgroup_cpu_usage() {
        let text = "usage_usec 267059156\nuser_usec 200000000\nsystem_usec 67059156\n";
        assert_eq!(parse_usage_usec(text), Some(267_059_156));
        assert_eq!(parse_usage_usec("user_usec 1\n"), None);
    }

    #[test]
    fn share_rounds_and_caps() {
        assert_eq!(share(1, 3), 333);
        assert_eq!(share(2, 3), 667);
        assert_eq!(share(5, 0), 0);
        assert_eq!(share(7, 5), 1000);
    }

    /// 只报一个会话的假托管：会话的进程组就是测试进程自己的进程组。
    struct OneSession {
        group: u32,
    }

    impl ProcessHost for OneSession {
        fn start(
            &self,
            _session: &str,
            _dir: &Path,
            _cwd: &Path,
            _launch: crate::host::Launch,
            _input: &crate::session::HeldInput,
        ) -> std::io::Result<()> {
            Ok(())
        }

        fn is_running(&self, session: &str, _dir: &Path) -> bool {
            session == "s1"
        }

        fn stop(&self, _session: &str, _dir: &Path) -> std::io::Result<()> {
            Ok(())
        }

        fn usage(&self, session: &str, _dir: &Path) -> Option<Usage> {
            (session == "s1").then_some(Usage {
                cpu_usec: 0,
                mem_bytes: 300 * 1024 * 1024,
                group: Some(self.group),
            })
        }
    }

    #[test]
    fn measures_this_machine() {
        let me = proc_stat(std::process::id()).unwrap();
        let host = OneSession { group: me.group };
        let sessions = [
            ("s1".to_string(), PathBuf::from("/nonexistent/s1")),
            ("s2".to_string(), PathBuf::from("/nonexistent/s2")),
        ];
        let sampler = Sampler::default();
        for _ in 0..2 {
            let load = sampler.measure(&host, &sessions).unwrap();
            assert!(load.cpus >= 1);
            assert!(load.cpu_permille <= 1000);
            assert_eq!(load.load_x100.len(), 3);
            assert!(load.mem_total_mb > 0 && load.mem_available_mb <= load.mem_total_mb);
            assert_eq!(
                load.sessions,
                vec![SessionLoad {
                    session: "s1".into(),
                    cpu_permille: 0,
                    mem_mb: 300,
                }]
            );
            assert!(load.others.len() <= TOP_OTHERS);
            // 会话进程组里的进程（这里就是测试进程自己）不算“其他进程”。
            assert!(load.others.iter().all(|other| other.pid != me.pid));
        }
    }
}
