//! Settlement evidence: the queue of on-chain operations and live reconciliation.

use actix_web::{web, HttpResponse};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::services::near::explorer_tx;
use crate::AppState;

type Row = (i64, String, String, i64, String, i32, Vec<String>, Option<Value>, Option<String>, Value, String);

fn row_json(r: Row) -> Value {
    let (id, kind, op_id, tick, status, attempts, hashes, evidence, error, payload, contract) = r;
    json!({
        "id": id, "kind": kind, "op_id": op_id, "contract": contract, "tick": tick, "status": status, "attempts": attempts,
        // Only a confirmed row is on-chain settlement; anything else is in flight or failed.
        "settled_on_chain": status == "confirmed",
        "tx_hashes": hashes, "explorer": hashes.iter().map(|h| explorer_tx(h)).collect::<Vec<_>>(),
        "evidence": evidence, "error": error, "payload": payload,
    })
}

const COLS: &str = "id, kind, op_id, tick, status, attempts, tx_hashes, evidence, error, payload, contract";

#[derive(Deserialize)]
pub struct ListQuery {
    pub limit: Option<i64>,
}

pub async fn list(state: web::Data<AppState>, q: web::Query<ListQuery>) -> HttpResponse {
    let rows: Result<Vec<Row>, _> = sqlx::query_as(&format!("SELECT {COLS} FROM settlements ORDER BY id DESC LIMIT $1"))
        .bind(q.limit.unwrap_or(30).clamp(1, 200))
        .fetch_all(state.world.db())
        .await;
    match rows {
        Ok(r) => HttpResponse::Ok().json(json!({ "enabled": state.near.is_some(), "settlements": r.into_iter().map(row_json).collect::<Vec<_>>() })),
        Err(e) => HttpResponse::InternalServerError().json(json!({ "error": e.to_string() })),
    }
}

pub async fn get(state: web::Data<AppState>, path: web::Path<String>) -> HttpResponse {
    let row: Result<Option<Row>, _> = sqlx::query_as(&format!("SELECT {COLS} FROM settlements WHERE op_id = $1 ORDER BY id DESC LIMIT 1"))
        .bind(path.into_inner())
        .fetch_optional(state.world.db())
        .await;
    match row {
        Ok(Some(r)) => HttpResponse::Ok().json(row_json(r)),
        Ok(None) => HttpResponse::NotFound().json(json!({ "error": "no such settlement" })),
        Err(e) => HttpResponse::InternalServerError().json(json!({ "error": e.to_string() })),
    }
}

pub async fn reconciliation(state: web::Data<AppState>) -> HttpResponse {
    match crate::services::settlement::reconcile(&state).await {
        Ok(v) => HttpResponse::Ok().json(v),
        Err(e) => HttpResponse::BadGateway().json(json!({ "error": e })),
    }
}

#[derive(Deserialize)]
pub struct AdvanceRequest {
    pub ticks: u64,
}

/// Advance the world clock by `ticks` (agents act every tick). Operator-only: disabled
/// unless `ADMIN_TOKEN` is set, and requires it in the `x-admin-token` header. Used to
/// run the acceptance scenario deterministically instead of waiting on the clock.
pub async fn admin_advance(state: web::Data<AppState>, req: actix_web::HttpRequest, body: web::Json<AdvanceRequest>) -> HttpResponse {
    let Ok(token) = std::env::var("ADMIN_TOKEN") else { return HttpResponse::NotFound().finish() };
    let given = req.headers().get("x-admin-token").and_then(|v| v.to_str().ok()).unwrap_or_default();
    if token.is_empty() || given != token {
        return HttpResponse::Unauthorized().json(json!({ "error": "admin token required" }));
    }
    match state.world.advance(body.ticks.min(24 * 14), 1).await {
        Ok(v) => HttpResponse::Ok().json(v),
        Err(e) => HttpResponse::InternalServerError().json(json!({ "error": e.to_string() })),
    }
}

/// Operator-only: realign the chain with the economy (see `settlement::align`).
pub async fn admin_realign(state: web::Data<AppState>, req: actix_web::HttpRequest) -> HttpResponse {
    let Ok(token) = std::env::var("ADMIN_TOKEN") else { return HttpResponse::NotFound().finish() };
    let given = req.headers().get("x-admin-token").and_then(|v| v.to_str().ok()).unwrap_or_default();
    if token.is_empty() || given != token {
        return HttpResponse::Unauthorized().json(json!({ "error": "admin token required" }));
    }
    match crate::services::settlement::align(&state, true).await {
        Ok(v) => HttpResponse::Ok().json(v),
        Err(e) => HttpResponse::Conflict().json(json!({ "error": e })),
    }
}

/// Operator-only: run one strategic planning round now (for testing the planner).
pub async fn admin_plan(state: web::Data<AppState>, req: actix_web::HttpRequest) -> HttpResponse {
    let Ok(token) = std::env::var("ADMIN_TOKEN") else { return HttpResponse::NotFound().finish() };
    let given = req.headers().get("x-admin-token").and_then(|v| v.to_str().ok()).unwrap_or_default();
    if token.is_empty() || given != token {
        return HttpResponse::Unauthorized().json(json!({ "error": "admin token required" }));
    }
    let Some(planner) = crate::services::planner::Planner::from_env() else {
        return HttpResponse::Conflict().json(json!({ "error": "NEAR_AI_API_KEY is not set" }));
    };
    crate::services::planner::run(&state, &planner).await;
    HttpResponse::Ok().json(json!({ "ran": true, "model": planner.model }))
}
