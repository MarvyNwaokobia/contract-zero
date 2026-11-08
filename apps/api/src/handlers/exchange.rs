//! The Exchange API. See `services::exchange` for the trade lifecycle.
//!
//! Identity: the player is the signed-in session's account (never a body field).
//! Reserving a quote only holds merchant stock for a few minutes (one open quote per
//! player, rate-limited); nothing moves until the account's own key signs the
//! acceptance on chain.

use actix_web::{web, HttpRequest, HttpResponse};
use cz_economy::{Resource, Side};
use serde::Deserialize;
use serde_json::json;

use crate::handlers::missions::{respond, valid_account_id};
use crate::services::exchange::{self, ExchangeError};
use crate::AppState;

fn reply(r: Result<serde_json::Value, ExchangeError>) -> HttpResponse {
    match r {
        Ok(v) => HttpResponse::Ok().json(v),
        Err(ExchangeError::World(e)) => respond(Err(e)),
        Err(ExchangeError::Busy(m)) => HttpResponse::Conflict().json(json!({ "error": m })),
        Err(ExchangeError::NotFound(m)) => HttpResponse::NotFound().json(json!({ "error": m })),
        Err(ExchangeError::Chain(m)) => {
            tracing::warn!("exchange chain error: {m}");
            HttpResponse::BadGateway().json(json!({ "error": m }))
        }
    }
}

#[derive(Deserialize)]
pub struct OverviewQuery {
    pub player: Option<String>,
}

pub async fn overview(state: web::Data<AppState>, q: web::Query<OverviewQuery>) -> HttpResponse {
    if let Some(p) = &q.player {
        if !valid_account_id(p) {
            return HttpResponse::BadRequest().json(json!({ "error": "invalid NEAR account id" }));
        }
    }
    reply(exchange::overview(&state, q.into_inner().player).await)
}

#[derive(Deserialize)]
pub struct QuoteRequest {
    #[serde(default)]
    pub player: String,
    pub resource: Resource,
    /// The player's side: `buy` from the merchant or `sell` to it.
    pub side: Side,
    pub qty: i64,
    /// The worst total the player accepts (max to pay / min to receive). Defaults to
    /// whatever the current price is.
    pub limit_total: Option<i64>,
}

pub async fn create(state: web::Data<AppState>, req: HttpRequest, body: web::Json<QuoteRequest>) -> HttpResponse {
    let ip = req.connection_info().realip_remote_addr().unwrap_or("unknown").to_string();
    if !state.mission_limiter.check(&ip) {
        return HttpResponse::TooManyRequests().json(json!({ "error": "too many requests, slow down" }));
    }
    let who = match crate::handlers::auth::player(&state, &req).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    if let Err(r) = crate::handlers::auth::same_player(&who, &body.player) {
        return r;
    }
    let mut b = body.into_inner();
    b.player = who.account;
    if !(1..=10_000).contains(&b.qty) {
        return HttpResponse::BadRequest().json(json!({ "error": "qty must be 1..=10000" }));
    }
    let limit = b.limit_total.unwrap_or(match b.side { Side::Buy => i64::MAX, Side::Sell => 0 });
    reply(exchange::create(&state, b.player, b.resource, b.side, b.qty, limit).await)
}

pub async fn get(state: web::Data<AppState>, path: web::Path<u64>) -> HttpResponse {
    reply(exchange::resolve(&state, path.into_inner(), None).await)
}

#[derive(Deserialize, Default)]
pub struct ConfirmRequest {
    /// The player's accept transaction, if the wallet returned it.
    pub tx_hash: Option<String>,
}

/// The quote must belong to the signed-in player.
async fn own_quote(state: &AppState, req: &HttpRequest, id: u64) -> Result<(), HttpResponse> {
    let who = crate::handlers::auth::player(state, req).await?;
    let owner = state.world.read(|w| w.quotes.get(&id).map(|q| q.player.clone())).await;
    match owner {
        None => Err(HttpResponse::NotFound().json(json!({ "error": format!("no quote {id}") }))),
        Some(p) if p != who.account => Err(HttpResponse::Forbidden().json(json!({ "error": "that quote belongs to another player" }))),
        Some(_) => Ok(()),
    }
}

pub async fn confirm(state: web::Data<AppState>, req: HttpRequest, path: web::Path<u64>, body: Option<web::Json<ConfirmRequest>>) -> HttpResponse {
    let id = path.into_inner();
    if let Err(r) = own_quote(&state, &req, id).await {
        return r;
    }
    let tx = body.and_then(|b| b.into_inner().tx_hash);
    reply(exchange::resolve(&state, id, tx).await)
}

pub async fn accept(state: web::Data<AppState>, req: HttpRequest, path: web::Path<u64>) -> HttpResponse {
    let id = path.into_inner();
    if let Err(r) = own_quote(&state, &req, id).await {
        return r;
    }
    reply(exchange::accept_offchain(&state, id).await)
}
