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
    /// Sign-in, sessions and the gas relayer.
    pub auth: std::sync::Arc<services::auth::AuthService>,
    /// This process's id for settlement leases (host, pid and a random suffix).
    pub worker_id: String,
    /// The official NEAR Intents (1Click) adapter: read-only unless approved.
    pub intents: services::intents::IntentsClient,
}

/// `CZ_ENV=production` turns on the strict deployment rules: credentialed CORS only
/// for `FRONTEND_ORIGIN`, secure cookies, and no localhost exceptions.
pub fn is_production() -> bool {
    std::env::var("CZ_ENV").as_deref() == Ok("production")
}

/// Whether a browser origin may make credentialed requests. Development also allows
/// localhost and 127.0.0.1 on any port; production allows only the listed origins.
pub fn origin_allowed(origin: &str, listed: &[String], production: bool) -> bool {
    if listed.iter().any(|o| o == origin) {
        return true;
    }
    !production && (origin.starts_with("http://localhost:") || origin.starts_with("https://localhost:") || origin.starts_with("http://127.0.0.1:"))
}

/// The world lives in this process's memory and is written back to Postgres, so only
/// one API instance may own it. This advisory lock is held for the life of the
/// process on a dedicated connection; a second instance on the same database refuses
/// to start instead of forking the world.
pub const WORLD_WRITER_LOCK: i64 = 0x0C2E_0001;

#[cfg(test)]
mod origin_tests {
    use super::origin_allowed;

    #[test]
    fn production_allows_only_listed_origins() {
        let listed = vec!["https://contract-zero.vercel.app".to_string()];
        assert!(origin_allowed("https://contract-zero.vercel.app", &listed, true));
        assert!(!origin_allowed("http://localhost:3000", &listed, true));
        assert!(!origin_allowed("http://127.0.0.1:3000", &listed, true));
        assert!(!origin_allowed("https://evil.example", &listed, true));
        assert!(!origin_allowed("https://contract-zero.vercel.app.evil.example", &listed, true));
    }

    #[test]
    fn development_also_allows_local_origins() {
        assert!(origin_allowed("http://localhost:3000", &[], false));
        assert!(origin_allowed("http://127.0.0.1:3000", &[], false));
        assert!(!origin_allowed("https://evil.example", &[], false));
    }
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

    // Single writer: hold the world lock for as long as this process runs.
    let mut writer = db.acquire().await?.detach();
    let (locked,): (bool,) = sqlx::query_as("SELECT pg_try_advisory_lock($1)").bind(WORLD_WRITER_LOCK).fetch_one(&mut writer).await?;
    if !locked {
        anyhow::bail!("another API instance already owns the world on this database (advisory lock {WORLD_WRITER_LOCK:#x}); run one writer per database");
    }
    let _writer_lock = writer; // dropped (and the lock released) only when the process exits

    let production = is_production();
    if production && std::env::var("FRONTEND_ORIGIN").unwrap_or_default().trim().is_empty() {
        anyhow::bail!("CZ_ENV=production requires FRONTEND_ORIGIN (the web app's exact origin)");
    }

    let near = match services::near::NearClient::from_env() {
        Ok(Some(n)) => {
            tracing::info!("settlement: CZ World at {} on NEAR testnet", n.contract);
            Some(std::sync::Arc::new(n))
        }
        Ok(None) => None,
        Err(e) => anyhow::bail!("NEAR settlement misconfigured: {e}"),
    };
    let auth = services::auth::AuthService::from_env(near.as_ref().map(|n| n.contract.to_string())).map_err(|e| anyhow::anyhow!("auth misconfigured: {e}"))?;
    if auth.dev_login && near.is_some() {
        anyhow::bail!("AUTH_DEV_LOGIN cannot be enabled while settlement is on NEAR");
    }
    match &auth.relayer {
        Some(r) => tracing::info!("auth: gas relayer {}", r.account),
        None => tracing::info!("auth: no gas relayer (sessions keys and social sign-in sponsorship disabled)"),
    }
    let world = services::world::WorldService::load(db, near.clone()).await?;
    let app_state = AppState {
        near,
        world,
        mission_limiter: std::sync::Arc::new(services::rate_limiter::RateLimiter::new(20, 60)),
        auth: std::sync::Arc::new(auth),
        worker_id: format!("{}-{}-{}", std::env::var("HOSTNAME").unwrap_or_else(|_| "api".into()), std::process::id(), &uuid::Uuid::new_v4().to_string()[..8]),
        intents: services::intents::IntentsClient::from_env(),
    };

    services::scheduler::spawn(app_state.clone());
    services::settlement::spawn_worker(app_state.clone());
    services::exchange::spawn_sweeper(app_state.clone());
    services::planner::spawn(app_state.clone());

    // FRONTEND_ORIGIN: comma-separated allowed origins. In development, localhost and
    // 127.0.0.1 are allowed too; in production (CZ_ENV=production) only the list.
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
        let csrf_origins = allowed_origins.clone();
        let cors = Cors::default()
            .allowed_origin_fn(move |origin, _req_head| origin_allowed(origin.to_str().unwrap_or(""), &origins, production))
            .allow_any_method()
            .allow_any_header()
            .supports_credentials()
            .max_age(3600);

        App::new()
            .app_data(web::Data::new(app_state.clone()))
            // CSRF: a state-changing request that carries a browser Origin must come from an
            // allowed origin, whatever CORS lets through. (Scripts without an Origin still
            // need the session cookie, which a browser on another site won't attach to a
            // request it can't read.)
            .wrap(actix_web::middleware::Condition::new(true, actix_web::middleware::from_fn(move |req: actix_web::dev::ServiceRequest, next: actix_web::middleware::Next<actix_web::body::BoxBody>| {
                let origins = csrf_origins.clone();
                async move {
                    let unsafe_method = !matches!(*req.method(), actix_web::http::Method::GET | actix_web::http::Method::HEAD | actix_web::http::Method::OPTIONS);
                    let origin = req.headers().get("origin").and_then(|v| v.to_str().ok()).map(str::to_string);
                    if unsafe_method {
                        if let Some(o) = origin {
                            if !origin_allowed(&o, &origins, production) {
                                return Err(actix_web::error::ErrorForbidden("cross-site request refused"));
                            }
                        }
                    }
                    next.call(req).await
                }
            })))
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
