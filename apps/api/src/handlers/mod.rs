use actix_web::{web, HttpResponse};

pub mod auth;
pub mod exchange;
pub mod missions;
pub mod profile;
pub mod settlement;
pub mod warroom;
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
        .route("/warroom", web::get().to(warroom::overview))
        .route("/warroom/timeline", web::get().to(warroom::timeline))
        .route("/observer/simulate", web::post().to(world::simulate))
        .route("/missions/start", web::post().to(missions::start))
        .route("/missions/{session}/story", web::get().to(missions::story))
        .route("/missions/{session}/loadout", web::post().to(missions::loadout))
        .route("/missions/{session}/complete", web::post().to(missions::complete))
        .route("/settlements", web::get().to(settlement::list))
        .route("/settlements/{op_id}", web::get().to(settlement::get))
        .route("/reconciliation", web::get().to(settlement::reconciliation))
        .route("/admin/advance", web::post().to(settlement::admin_advance))
        .route("/admin/realign", web::post().to(settlement::admin_realign))
        .route("/admin/plan", web::post().to(settlement::admin_plan))
        .route("/me/profile", web::get().to(profile::get))
        .route("/me/career", web::get().to(profile::career))
        .route("/me/profile", web::post().to(profile::set))
        .route("/auth/config", web::get().to(auth::config))
        .route("/auth/challenge", web::post().to(auth::challenge))
        .route("/auth/wallet", web::post().to(auth::wallet))
        .route("/auth/near-auth", web::post().to(auth::near_auth))
        .route("/auth/dev", web::post().to(auth::dev))
        .route("/auth/session", web::get().to(auth::session))
        .route("/auth/logout", web::post().to(auth::logout))
        .route("/relay/delegate", web::post().to(auth::relay))
        .route("/relay/near-auth-sign", web::post().to(auth::near_auth_sign))
        .route("/exchange", web::get().to(exchange::overview))
        .route("/exchange/quotes", web::post().to(exchange::create))
        .route("/exchange/quotes/{id}", web::get().to(exchange::get))
        .route("/exchange/quotes/{id}/confirm", web::post().to(exchange::confirm))
        .route("/exchange/quotes/{id}/accept", web::post().to(exchange::accept));
}
