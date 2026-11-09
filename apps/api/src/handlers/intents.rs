//! Official NEAR Intents (1Click) over HTTP: what's supported, dry quotes, status.
//! Read-only against the live mainnet service; see services/intents.rs.

use actix_web::{web, HttpRequest, HttpResponse};
use serde_json::{json, Value};

use crate::services::intents::{expired, is_game_asset, status_meaning, IntentsError, QuoteAsk};
use crate::AppState;

fn err(e: IntentsError) -> HttpResponse {
    let body = json!({ "error": e.to_string() });
    match e {
        IntentsError::GameAsset(_) | IntentsError::Unsupported(_) | IntentsError::WrongChain { .. } | IntentsError::BadAmount => HttpResponse::UnprocessableEntity().json(body),
        IntentsError::ExecutionDisabled => HttpResponse::Forbidden().json(body),
        IntentsError::Refused { .. } | IntentsError::Unreachable(_) => HttpResponse::BadGateway().json(body),
    }
}

/// The adapter's configuration, the supported assets, and recent protocol quotes.
pub async fn overview(state: web::Data<AppState>) -> HttpResponse {
    let tokens = state.intents.tokens().await;
    let recent: Vec<(i64, String, bool, String, String, String, Option<String>, Option<String>, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT id, correlation_id, dry, origin_asset, destination_asset, amount_in, amount_out, min_amount_out, created_at FROM intents_quotes ORDER BY id DESC LIMIT 10",
    )
    .fetch_all(state.world.db()).await.unwrap_or_default();
    let (assets, chains, near_assets) = match &tokens {
        Ok(t) => {
            let mut chains: Vec<&str> = t.iter().map(|x| x.blockchain.as_str()).collect();
            chains.sort();
            chains.dedup();
            let near: Vec<Value> = t.iter().filter(|x| x.blockchain == "near").take(40).map(|x| json!({ "asset_id": x.asset_id, "symbol": x.symbol, "decimals": x.decimals, "price_usd": x.price })).collect();
            (t.len(), chains.into_iter().map(String::from).collect::<Vec<_>>(), near)
        }
        Err(_) => (0, vec![], vec![]),
    };
    // The game's own tokens, checked against the live list (never assumed).
    let cz_supported = tokens.as_ref().map(|t| t.iter().any(|x| is_game_asset(&x.asset_id))).unwrap_or(false);
    HttpResponse::Ok().json(json!({
        "adapter": state.intents.status(),
        "reachable": tokens.is_ok(), "error": tokens.as_ref().err().map(|e| e.to_string()),
        "supported_assets": assets, "chains": chains, "near_assets": near_assets,
        "contract_zero_assets_supported": cz_supported,
        "recent_quotes": recent.into_iter().map(|r| json!({ "id": r.0, "correlation_id": r.1, "dry": r.2, "origin": r.3, "destination": r.4, "amount_in": r.5, "amount_out": r.6, "min_amount_out": r.7, "at": r.8 })).collect::<Vec<_>>(),
    }))
}

/// A dry quote from the live service (prices, fees, minimum received; no deposit
/// address). Persisted with the protocol's correlation id and signature.
pub async fn quote(state: web::Data<AppState>, req: HttpRequest, body: web::Json<QuoteAsk>) -> HttpResponse {
    let who = crate::handlers::auth::player(&state, &req).await.ok().map(|s| s.account);
    let ask = body.into_inner();
    let (view, request, response) = match state.intents.quote(&ask, false).await {
        Ok(x) => x,
        Err(e) => return err(e),
    };
    let deadline = chrono::DateTime::parse_from_rfc3339(&view.deadline).ok().map(|d| d.with_timezone(&chrono::Utc));
    let _ = sqlx::query("INSERT INTO intents_quotes (correlation_id, dry, origin_asset, destination_asset, amount_in, amount_out, min_amount_out, deadline, signature, deposit_address, request, response, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)")
        .bind(&view.correlation_id).bind(view.dry).bind(&ask.origin_asset).bind(&ask.destination_asset).bind(&view.amount_in).bind(&view.amount_out)
        .bind(&view.min_amount_out).bind(deadline).bind(&view.signature).bind(&view.deposit_address).bind(&request).bind(&response).bind(&who)
        .execute(state.world.db()).await
        .map_err(|e| tracing::error!("intents: could not store quote {}: {e}", view.correlation_id));
    let is_expired = expired(&view, chrono::Utc::now());
    HttpResponse::Ok().json(json!({ "quote": view, "expired": is_expired, "execution": "not available: dry quote (no deposit address); swaps settle on NEAR mainnet" }))
}

/// Execution status for a deposit address from a real quote.
pub async fn status(state: web::Data<AppState>, path: web::Path<String>) -> HttpResponse {
    match state.intents.execution_status(&path.into_inner()).await {
        Ok(v) => {
            let s = v["status"].as_str().unwrap_or("").to_string();
            HttpResponse::Ok().json(json!({ "status": s, "meaning": status_meaning(&s), "raw": v }))
        }
        Err(e) => err(e),
    }
}
