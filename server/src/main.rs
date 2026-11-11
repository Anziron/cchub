#[cfg(unix)]
mod auth;
#[cfg(unix)]
mod config;
#[cfg(unix)]
mod device;
#[cfg(unix)]
mod host;
#[cfg(unix)]
mod idle;
#[cfg(unix)]
mod runner;
#[cfg(unix)]
mod session;
#[cfg(unix)]
mod title;
#[cfg(unix)]
mod usage;
#[cfg(unix)]
mod workspace;
#[cfg(unix)]
mod ws;

#[cfg(not(unix))]
fn main() {
    eprintln!("hubd 只支持 Linux");
    std::process::exit(1);
}

#[cfg(unix)]
fn main() -> std::process::ExitCode {
    use std::process::ExitCode;

    let config = match config::Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    // hubd 要尽量省内存，用单线程运行时。
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("无法创建运行时");
    match runtime.block_on(run(config)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(unix)]
async fn run(config: config::Config) -> std::io::Result<()> {
    use std::net::SocketAddr;
    use std::sync::Arc;
    use std::time::Duration;

    use axum::{routing::get, Json, Router};
    use cchub_protocol::{Health, PROTOCOL_VERSION};

    /// 空闲回收的检查间隔。
    const IDLE_CHECK_EVERY: Duration = Duration::from_secs(60);

    async fn health() -> Json<Health> {
        Json(Health {
            version: env!("CARGO_PKG_VERSION").to_string(),
            protocol_version: PROTOCOL_VERSION,
        })
    }

    // systemd 模式下 `hubd` 自己有很小的 `MemoryMax`，起标题的进程要放进独立的 scope。
    let title_memory_mb = match config.host {
        config::HostKind::Systemd => config.title_memory_max_mb,
        config::HostKind::Direct => 0,
    };
    let host: Box<dyn host::ProcessHost> = match config.host {
        config::HostKind::Systemd => Box::new(host::SystemdHost {
            claude_cmd: config.claude_cmd,
            memory_max_mb: config.session_memory_max_mb,
        }),
        config::HostKind::Direct => Box::new(host::DirectHost {
            claude_cmd: config.claude_cmd,
        }),
    };
    std::fs::create_dir_all(&config.state_dir)?;
    let app = Arc::new(ws::App {
        sessions: session::Sessions::new(config.state_dir),
        host,
        allowed_users: config.allowed_users,
        min_available_mb: config.min_available_mb,
        workspace_cmd: config.workspace_cmd,
        title_cmd: config.title_cmd,
        title_memory_mb,
        usage_cmd: config.usage_cmd,
        usage_lock: Default::default(),
        probes: device::Probes::default(),
        devices_cache: Default::default(),
    });

    let retention = config.retention;
    let pruner = app.clone();
    tokio::spawn(async move {
        let mut daily = tokio::time::interval(Duration::from_secs(24 * 60 * 60));
        loop {
            daily.tick().await;
            let app = pruner.clone();
            let _ = tokio::task::spawn_blocking(move || {
                app.sessions
                    .prune(retention, |id, dir| app.host.is_running(id, dir))
            })
            .await;
        }
    });

    if !config.idle.is_zero() {
        let idle = config.idle;
        let reaper = app.clone();
        tokio::spawn(async move {
            let mut every = tokio::time::interval(IDLE_CHECK_EVERY);
            loop {
                every.tick().await;
                let app = reaper.clone();
                let stopped = tokio::task::spawn_blocking(move || {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_or(0, |time| time.as_secs());
                    idle::reclaim(&app, idle, now)
                })
                .await
                .unwrap_or_default();
                for session in stopped {
                    println!("空闲回收：结束会话 {session} 的进程");
                }
            }
        });
    }

    let router = Router::new()
        .route("/health", get(health))
        .route("/ws", get(ws::upgrade))
        .with_state(app);

    let listener = tokio::net::TcpListener::bind(config.listen).await?;
    println!("hubd listening on {}", listener.local_addr()?);
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
}
