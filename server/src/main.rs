#[cfg(unix)]
mod auth;
#[cfg(unix)]
mod config;
#[cfg(unix)]
mod device;
#[cfg(unix)]
mod host;
#[cfg(unix)]
mod runner;
#[cfg(unix)]
mod session;
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

    let args: Vec<_> = std::env::args_os().collect();
    if args.len() == 3 && args[1] == "--probe" {
        return if device::probe_main(std::path::Path::new(&args[2])) {
            ExitCode::SUCCESS
        } else {
            ExitCode::FAILURE
        };
    }

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

    async fn health() -> Json<Health> {
        Json(Health {
            version: env!("CARGO_PKG_VERSION").to_string(),
            protocol_version: PROTOCOL_VERSION,
        })
    }

    let host: Box<dyn host::ProcessHost> = match config.host {
        config::HostKind::Systemd => Box::new(host::SystemdHost {
            claude_cmd: config.claude_cmd,
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
