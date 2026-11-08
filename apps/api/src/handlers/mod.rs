use actix_web::{web, HttpResponse};

pub mod missions;
pub mod settlement;
pub mod world;

/// Liveness: the process is accepting connections.
async fn health() -> HttpResponse {
    HttpResponse::Ok().finish()
}

/// Readiness: the database is reachable. Point external monitors here, not at the
/// platform healthcheck — a DB blip should page a human, not restart the process.
async fn ready(state: web::Data<crate::AppState>) -> HttpResponse {
    match sqlx::query("SELECT 1").execute(state.world.db()).await {
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
        .route("/ready", web::get().to(ready))
        .route("/world", web::get().to(world::get_world))
        .route("/board", web::get().to(world::get_board))
        .route("/events", web::get().to(world::get_events))
        .route("/players/{player}", web::get().to(world::get_player))
        .route("/observer/simulate", web::post().to(world::simulate))
        .route("/missions/start", web::post().to(missions::start))
        .route("/missions/{session}/complete", web::post().to(missions::complete))
        .route("/settlements", web::get().to(settlement::list))
        .route("/settlements/{op_id}", web::get().to(settlement::get))
        .route("/reconciliation", web::get().to(settlement::reconciliation))
        .route("/admin/advance", web::post().to(settlement::admin_advance));
}
