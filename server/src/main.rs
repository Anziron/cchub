use std::{env, io};

use axum::{routing::get, Json, Router};
use cchub_protocol::{Health, PROTOCOL_VERSION};
use tokio::net::TcpListener;

const DEFAULT_LISTEN: &str = "127.0.0.1:7878";

// hubd 要尽量省内存，用单线程运行时。
#[tokio::main(flavor = "current_thread")]
async fn main() -> io::Result<()> {
    let listen = env::var("HUBD_LISTEN").unwrap_or_else(|_| DEFAULT_LISTEN.to_string());
    let listener = TcpListener::bind(&listen).await?;
    println!("hubd listening on {}", listener.local_addr()?);
    axum::serve(listener, app())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
}

fn app() -> Router {
    Router::new().route("/health", get(health))
}

async fn health() -> Json<Health> {
    Json(Health {
        version: env!("CARGO_PKG_VERSION").to_string(),
        protocol_version: PROTOCOL_VERSION,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn health_reports_package_and_protocol_version() {
        let Json(body) = health().await;
        assert_eq!(body.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(body.protocol_version, PROTOCOL_VERSION);
    }
}
