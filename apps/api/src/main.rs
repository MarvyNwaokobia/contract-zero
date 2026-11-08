use actix_cors::Cors;
use actix_web::{middleware::Logger, web, App, HttpServer};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::str::FromStr;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod handlers;
mod migrate;
mod services;

#[derive(Clone)]
pub struct AppState {
    /// NEAR settlement client (None = off-chain only).
    pub near: Option<std::sync::Arc<services::near::NearClient>>,
    /// The live economy (owns the database pool).
    pub world: services::world::WorldService,
    /// Per-IP limiter for mission start/complete. Built once and shared (Arc) so
    /// every Actix worker draws from the same bucket.
    pub mission_limiter: std::sync::Arc<services::rate_limiter::RateLimiter>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    let _sentry_guard = std::env::var("SENTRY_DSN").ok().map(|dsn| {
        sentry::init((
            dsn,
            sentry::ClientOptions { release: sentry::release_name!(), ..Default::default() },
        ))
    });

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .with(sentry_tracing::layer())
        .init();

    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let connect_opts = PgConnectOptions::from_str(&database_url).expect("Invalid DATABASE_URL");
    let db = PgPoolOptions::new().max_connections(20).connect_with(connect_opts).await?;

    // Apply pending migrations before serving; a failure aborts boot on purpose.
    migrate::run(&db).await?;

    let near = match services::near::NearClient::from_env() {
        Ok(Some(n)) => {
            tracing::info!("settlement: CZ World at {} on NEAR testnet", n.contract);
            Some(std::sync::Arc::new(n))
        }
        Ok(None) => None,
        Err(e) => anyhow::bail!("NEAR settlement misconfigured: {e}"),
    };
    let world = services::world::WorldService::load(db, near.clone()).await?;
    let app_state = AppState {
        near,
        world,
        mission_limiter: std::sync::Arc::new(services::rate_limiter::RateLimiter::new(10, 60)),
    };

    services::scheduler::spawn(app_state.clone());
    services::settlement::spawn_worker(app_state.clone());
    services::exchange::spawn_sweeper(app_state.clone());

    // FRONTEND_ORIGIN: comma-separated allowed origins. localhost is always allowed.
    let allowed_origins: Vec<String> = std::env::var("FRONTEND_ORIGIN")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let bind_addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
    tracing::info!("Starting CONTRACT ZERO API on {}", bind_addr);

    HttpServer::new(move || {
        let origins = allowed_origins.clone();
        let cors = Cors::default()
            .allowed_origin_fn(move |origin, _req_head| {
                let s = origin.to_str().unwrap_or("");
                s.starts_with("http://localhost:")
                    || s.starts_with("https://localhost:")
                    || origins.iter().any(|o| s == o.as_str())
            })
            .allow_any_method()
            .allow_any_header()
            .max_age(3600);

        App::new()
            .app_data(web::Data::new(app_state.clone()))
            .wrap(Logger::default())
            .wrap(cors)
            .wrap(sentry_actix::Sentry::new())
            .configure(handlers::configure_routes)
    })
    .bind(&bind_addr)?
    .run()
    .await?;

    Ok(())
}
