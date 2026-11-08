use actix_web::{web, HttpResponse};

/// Liveness: the process is accepting connections.
async fn health() -> HttpResponse {
    HttpResponse::Ok().finish()
}

/// Readiness: the database is reachable. Point external monitors here, not at the
/// platform healthcheck — a DB blip should page a human, not restart the process.
async fn ready(state: web::Data<crate::AppState>) -> HttpResponse {
    match sqlx::query("SELECT 1").execute(&state.db).await {
        Ok(_) => HttpResponse::Ok().json(serde_json::json!({ "status": "ready", "db": "up" })),
        Err(e) => {
            tracing::warn!("readiness check failed: db unreachable: {}", e);
            HttpResponse::ServiceUnavailable()
                .json(serde_json::json!({ "status": "degraded", "db": "down" }))
        }
    }
}

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.route("/health", web::get().to(health))
        .route("/ready", web::get().to(ready));
}
