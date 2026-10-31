#[cfg(unix)]
mod config;
#[cfg(unix)]
mod host;
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
    use std::sync::Arc;

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
    });
    let router = Router::new()
        .route("/health", get(health))
        .route("/ws", get(ws::upgrade))
        .with_state(app);

    let listener = tokio::net::TcpListener::bind(config.listen).await?;
    println!("hubd listening on {}", listener.local_addr()?);
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
}
