//! Supply Orders over HTTP: the market (merchants, open and recent orders, with their
//! settlement evidence) and the player's side of an order.
//!
//! A player's steps are CHAIN-FIRST. The player signs `place_order`,
//! `accept_proposal` or `cancel_order` on `world2` in their own wallet (or within a
//! quick-trade budget); the API then reads the controller's state and applies the same
//! step to the economy only if the chain shows it happened, for this player, with these
//! terms. The API never moves a player's assets on its own authority, and a supplied
//! account id is never taken as proof: the session decides who the player is.

use actix_web::{web, HttpRequest, HttpResponse};
use cz_economy::{orders::MAX_ORDER_TICKS, policy, Action, Caller, Resource, Side};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::handlers::auth::player;
use crate::services::settlement::{chain_account, queue_order_steps};
use crate::services::world::{log_decision, log_event, WorldError};
use crate::AppState;

const MAX_QTY: i64 = 500;
const MAX_LIMIT: i64 = 100_000;

fn tick_secs() -> u64 {
    std::env::var("WORLD_TICK_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(60).max(1)
}

fn bad(msg: impl Into<String>) -> HttpResponse {
    HttpResponse::BadRequest().json(json!({ "error": msg.into() }))
}

fn econ(e: WorldError) -> HttpResponse {
    match e {
        WorldError::Econ(e) => HttpResponse::Conflict().json(json!({ "error": e.to_string() })),
        other => {
            tracing::error!("orders: {other}");
            HttpResponse::InternalServerError().json(json!({ "error": "storage error" }))
        }
    }
}

/// The market: every merchant (profile, record, shelves, own prices) and the open and
/// recent supply orders with their proposals, fills and settlement evidence.
pub async fn market(state: web::Data<AppState>) -> HttpResponse {
    let near = state.near.clone();
    let (merchants, orders, chain_ids) = state
        .world
        .read(|w| {
            let merchants: Vec<Value> = w
                .merchant_ids()
                .iter()
                .filter_map(|id| {
                    let a = w.actors.get(id)?;
                    let p = w.profile(id)?;
                    let shelves: Value = Resource::ALL
                        .iter()
                        .map(|&r| {
                            let stock = w.balance(&a.account, cz_economy::Asset::Res(r));
                            (r.name().to_string(), json!({
                                "stock": stock, "target": p.target[r.idx()],
                                "reserved": w.reserved_by(&a.account, cz_economy::Asset::Res(r)),
                                "ask": w.merchant_quote(id, r, Side::Buy, 1), "bid": w.merchant_quote(id, r, Side::Sell, 1),
                            }))
                        })
                        .collect::<serde_json::Map<_, _>>()
                        .into();
                    Some(json!({
                        "id": id, "name": a.name, "account": near.as_ref().and_then(|n| chain_account(n, &a.account)),
                        "credits": w.balance(&a.account, cz_economy::Asset::Credits), "credit_reserve": a.credit_reserve,
                        "margin_bp": p.strategy.margin_bp, "spread_bp": p.strategy.spread_bp, "min_margin_bp": p.min_margin_bp, "max_commit_bp": p.max_commit_bp,
                        "record": p.record, "shelves": shelves, "instant_market": *id == w.market.merchant,
                    }))
                })
                .collect();
            let mut list: Vec<&cz_economy::SupplyOrder> = w.orders.values().collect();
            list.sort_by_key(|o| std::cmp::Reverse(o.id));
            list.truncate(60);
            let chain_ids: Vec<String> = list.iter().map(|o| o.chain_order_id()).collect();
            let orders: Vec<Value> = list
                .into_iter()
                .map(|o| {
                    let requester_name = w.actors.get(&o.requester).map(|a| a.name.clone()).unwrap_or_else(|| o.requester.trim_start_matches("player:").to_string());
                    let props: Vec<Value> = w.proposals.values().filter(|p| p.order == o.id).map(|p| json!({
                        "id": p.id, "merchant": p.merchant, "merchant_name": w.actors.get(&p.merchant).map(|a| a.name.clone()),
                        "qty": p.qty, "total": p.total, "posted_at": p.posted_at, "expires_at": p.expires_at, "status": p.status, "note": p.note,
                        "chain_proposal_id": crate::services::settlement::chain_proposal_id(p.id),
                    })).collect();
                    json!({
                        "id": o.id, "chain_id": o.chain_order_id(), "requester": o.requester, "requester_name": requester_name,
                        "requester_kind": if w.actors.contains_key(&o.requester) { "faction" } else { "player" },
                        "side": o.side, "resource": o.resource, "qty": o.qty, "limit_total": o.limit_total, "allow_partial": o.allow_partial,
                        "placed_at": o.placed_at, "expires_at": o.expires_at, "urgency": o.urgency, "filled": o.filled, "settled_total": o.settled_total,
                        "status": o.status, "purpose": o.purpose, "fills": o.fills, "proposals": props,
                    })
                })
                .collect();
            (merchants, orders, chain_ids)
        })
        .await;
    // Settlement evidence for each order's steps (server-signed and player-signed).
    let mut evidence: std::collections::HashMap<String, Vec<Value>> = Default::default();
    if !chain_ids.is_empty() {
        let patterns: Vec<String> = chain_ids.iter().flat_map(|c| [format!("order:{c}"), format!("propose:{c}|%"), format!("fill:{c}|%"), format!("close:{c}"), format!("expire:{c}"), format!("player:{c}:%")]).collect();
        let rows: Vec<(String, String, String, Vec<String>, Option<String>)> = sqlx::query_as("SELECT op_id, kind, status, tx_hashes, error FROM settlements WHERE op_id LIKE ANY($1) ORDER BY id")
            .bind(&patterns).fetch_all(state.world.db()).await.unwrap_or_default();
        for (op, kind, status, hashes, error) in rows {
            let c = op.split_once(':').map(|(_, r)| r.split(['|', ':']).next().unwrap_or("").to_string()).unwrap_or_default();
            evidence.entry(c).or_default().push(json!({ "op_id": op, "kind": kind, "status": status, "tx_hashes": hashes, "error": error }));
        }
    }
    let orders: Vec<Value> = orders
        .into_iter()
        .map(|mut o| {
            let c = o["chain_id"].as_str().unwrap_or_default().to_string();
            o["settlement"] = json!(evidence.remove(&c).unwrap_or_default());
            o
        })
        .collect();
    let tick = state.world.read(|w| w.tick).await;
    HttpResponse::Ok().json(json!({
        "tick": tick, "tick_secs": tick_secs(),
        "settlement": if state.near.is_some() { "near" } else { "off_chain" },
        "controller": state.near.as_ref().map(|n| n.contract.to_string()),
        "merchants": merchants, "orders": orders,
    }))
}

#[derive(Deserialize)]
pub struct Prepare {
    pub side: Side,
    pub resource: Resource,
    pub qty: i64,
    pub limit_total: i64,
    #[serde(default)]
    pub allow_partial: bool,
    pub ttl_ticks: u64,
}

/// Step 1 for a player: the exact `place_order` call to sign, with a fresh chain id.
pub async fn prepare(state: web::Data<AppState>, req: HttpRequest, body: web::Json<Prepare>) -> HttpResponse {
    let s = match player(&state, &req).await { Ok(s) => s, Err(r) => return r };
    let Some(near) = state.near.clone() else { return bad("supply orders settle on NEAR, which is off here") };
    let b = body.into_inner();
    if !(1..=MAX_QTY).contains(&b.qty) || !(1..=MAX_LIMIT).contains(&b.limit_total) {
        return bad(format!("quantity 1…{MAX_QTY}, limit 1…{MAX_LIMIT} credits"));
    }
    let max_ticks = (3_600 / tick_secs()).min(MAX_ORDER_TICKS);
    if !(1..=max_ticks).contains(&b.ttl_ticks) {
        return bad(format!("an order lasts 1…{max_ticks} hours"));
    }
    let engine_acct = cz_economy::player_account(&s.account);
    let nonce = state.world.read(|w| w.order_nonces.get(&engine_acct).copied().unwrap_or(0)).await + 1;
    // The nonce is in the id (replay guard in the engine); the suffix keeps ids unique
    // on the controller across economy resets.
    let suffix: String = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
    let order_id = format!("u{nonce}-{suffix}");
    let args = json!({
        "order_id": order_id, "side": if b.side == Side::Buy { "Buy" } else { "Sell" }, "token_id": b.resource.name(),
        "quantity": b.qty.to_string(), "limit_credits": b.limit_total.to_string(), "allow_partial": b.allow_partial,
        "ttl_secs": b.ttl_ticks * tick_secs(),
    });
    HttpResponse::Ok().json(json!({ "order_id": order_id, "nonce": nonce, "call": { "receiver_id": near.contract.to_string(), "method": "place_order", "args": args, "gas": "300000000000000" } }))
}

#[derive(Deserialize)]
pub struct Confirm {
    pub order_id: String,
    /// The player's transaction (verified on chain and kept as evidence).
    pub tx_hash: Option<String>,
}

/// Step 2: the player placed the order on chain. Read it back, record it in the
/// economy with the chain's own terms, and let every merchant answer at once.
pub async fn confirm(state: web::Data<AppState>, req: HttpRequest, body: web::Json<Confirm>) -> HttpResponse {
    let s = match player(&state, &req).await { Ok(s) => s, Err(r) => return r };
    let Some(near) = state.near.clone() else { return bad("settlement is off") };
    let oid = body.order_id.clone();
    let Some(nonce) = oid.strip_prefix('u').and_then(|r| r.split('-').next()).and_then(|n| n.parse::<u64>().ok()) else { return bad("not a player order id") };
    let o = match near.view("get_order", json!({ "order_id": oid })).await {
        Ok(v) if v.is_null() => return HttpResponse::NotFound().json(json!({ "error": "no such order on chain yet" })),
        Ok(v) => v,
        Err(e) => return HttpResponse::BadGateway().json(json!({ "error": format!("could not read the chain: {e}") })),
    };
    if o["requester"].as_str() != Some(s.account.as_str()) {
        return HttpResponse::Forbidden().json(json!({ "error": "that order belongs to another account" }));
    }
    if o["state"].as_str() != Some("Open") {
        return HttpResponse::Conflict().json(json!({ "error": format!("the order is {} on chain", o["state"].as_str().unwrap_or("?")) }));
    }
    let num = |k: &str| o[k].as_str().and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    let side = if o["side"].as_str() == Some("Sell") { Side::Sell } else { Side::Buy };
    let Some(resource) = o["token_id"].as_str().and_then(|t| Resource::ALL.into_iter().find(|r| r.name() == t)) else { return bad("unsupported token") };
    let expires_ns = o["expires_at_ns"].as_u64().unwrap_or(0);
    let left_secs = (expires_ns / 1_000_000_000).saturating_sub(chrono::Utc::now().timestamp() as u64);
    let ttl_ticks = (left_secs / tick_secs()).clamp(1, MAX_ORDER_TICKS);
    if let Some(h) = &body.tx_hash {
        if let Ok(acct) = s.account.parse() {
            if let Err(e) = near.verify(h, &acct, "place_order").await {
                return bad(format!("that transaction didn't verify: {e}"));
            }
        }
    }
    let action = Action::PlaceOrder { side, resource, qty: num("quantity"), limit_total: num("limit_credits"), allow_partial: o["allow_partial"].as_bool().unwrap_or(false), ttl_ticks, nonce, urgency: 0, purpose: "player supply order".into(), chain_id: Some(oid.clone()) };
    let caller = Caller::Player(s.account.clone());
    let n = near.clone();
    let tx = body.tx_hash.clone();
    let res = state
        .world
        .transact(async move |w, db| {
            let mut ev = w.execute(&caller, &action)?;
            record_player_step(&mut *db, &n, w.tick, &format!("player:{oid}:place"), tx.as_deref(), &json!({ "order_id": oid, "step": "place" })).await?;
            // Every merchant answers now, so the player sees competing offers at once.
            let order = w.orders.values().find(|o| o.chain_id.as_deref() == Some(oid.as_str())).map(|o| o.id).unwrap_or_default();
            for m in w.merchant_ids() {
                for d in policy::merchant_proposals(w, &m).into_iter().filter(|d| d.trigger == format!("supply order #{order}")) {
                    let r = d.action.as_ref().map(|a| w.execute(&Caller::Agent(m.clone()), a));
                    log_decision(&mut *db, w.tick, "fallback", &d, r.as_ref()).await?;
                    if let Some(Ok(e)) = r {
                        ev.extend(e);
                    }
                }
            }
            queue_order_steps(w, &mut *db, &n, &ev).await?;
            Ok(order)
        })
        .await;
    match res {
        Ok(order) => HttpResponse::Ok().json(json!({ "order": order })),
        Err(e) => econ(e),
    }
}

#[derive(Deserialize)]
pub struct Step {
    pub proposal: Option<u64>,
    pub tx_hash: Option<String>,
}

/// Step 3: the player accepted a proposal on chain (`accept_proposal`). Applied to the
/// economy only once the controller shows that exact fill as settled.
pub async fn accept(state: web::Data<AppState>, req: HttpRequest, path: web::Path<u64>, body: web::Json<Step>) -> HttpResponse {
    let s = match player(&state, &req).await { Ok(s) => s, Err(r) => return r };
    let Some(near) = state.near.clone() else { return bad("settlement is off") };
    let order = path.into_inner();
    let Some(proposal) = body.proposal else { return bad("which proposal?") };
    let me = cz_economy::player_account(&s.account);
    let Some(chain) = state.world.read(|w| w.orders.get(&order).filter(|o| o.requester == me).map(|o| o.chain_order_id())).await else {
        return HttpResponse::NotFound().json(json!({ "error": "no such order of yours" }));
    };
    let k = format!("{chain}|{}", crate::services::settlement::chain_proposal_id(proposal));
    match near.view("is_used", json!({ "op_id": format!("fill:{k}") })).await {
        Ok(v) if v.as_bool() == Some(true) => {}
        Ok(_) => return HttpResponse::Conflict().json(json!({ "error": "the chain doesn't show that fill yet" })),
        Err(e) => return HttpResponse::BadGateway().json(json!({ "error": format!("could not read the chain: {e}") })),
    }
    let caller = Caller::Player(s.account.clone());
    let n = near.clone();
    let tx = body.tx_hash.clone();
    state
        .world
        .transact(async move |w, db| {
            let ev = w.execute(&caller, &Action::AcceptProposal { order, proposal })?;
            record_player_step(&mut *db, &n, w.tick, &format!("player:{chain}:fill:{proposal}"), tx.as_deref(), &json!({ "order_id": chain, "proposal": proposal, "step": "accept" })).await?;
            queue_order_steps(w, &mut *db, &n, &ev).await?;
            log_event(&mut *db, w.tick, &me, "economy", &json!({ "action": "accept_proposal", "order": order, "proposal": proposal })).await?;
            Ok(())
        })
        .await
        .map(|_| HttpResponse::Ok().json(json!({ "ok": true })))
        .unwrap_or_else(econ)
}

/// The player cancelled on chain (`cancel_order`): mirror it once the chain shows it.
pub async fn cancel(state: web::Data<AppState>, req: HttpRequest, path: web::Path<u64>, body: web::Json<Step>) -> HttpResponse {
    let s = match player(&state, &req).await { Ok(s) => s, Err(r) => return r };
    let Some(near) = state.near.clone() else { return bad("settlement is off") };
    let order = path.into_inner();
    let me = cz_economy::player_account(&s.account);
    let Some(chain) = state.world.read(|w| w.orders.get(&order).filter(|o| o.requester == me).map(|o| o.chain_order_id())).await else {
        return HttpResponse::NotFound().json(json!({ "error": "no such order of yours" }));
    };
    match near.view("get_order", json!({ "order_id": chain })).await {
        Ok(v) if v["close_reason"].as_str() == Some("cancelled") => {}
        Ok(_) => return HttpResponse::Conflict().json(json!({ "error": "the chain doesn't show the cancellation yet" })),
        Err(e) => return HttpResponse::BadGateway().json(json!({ "error": format!("could not read the chain: {e}") })),
    }
    let caller = Caller::Player(s.account.clone());
    let n = near.clone();
    let tx = body.tx_hash.clone();
    state
        .world
        .transact(async move |w, db| {
            let ev = w.execute(&caller, &Action::CancelOrder { order })?;
            record_player_step(&mut *db, &n, w.tick, &format!("player:{chain}:cancel"), tx.as_deref(), &json!({ "order_id": chain, "step": "cancel" })).await?;
            queue_order_steps(w, &mut *db, &n, &ev).await?;
            Ok(())
        })
        .await
        .map(|_| HttpResponse::Ok().json(json!({ "ok": true })))
        .unwrap_or_else(econ)
}

/// Keep a player-signed step as settlement evidence (already verified against the
/// controller's state by the caller; nothing for the worker to submit).
async fn record_player_step(db: &mut sqlx::PgConnection, near: &crate::services::near::NearClient, tick: u64, op: &str, tx: Option<&str>, payload: &Value) -> Result<(), WorldError> {
    let hashes: Vec<String> = tx.map(|h| vec![h.to_string()]).unwrap_or_default();
    sqlx::query("INSERT INTO settlements (kind, op_id, tick, payload, contract, status, tx_hashes, evidence, confirmed_at) VALUES ('player_order', $1, $2, $3, $4, 'confirmed', $5, $6, now()) ON CONFLICT (contract, op_id) DO NOTHING")
        .bind(op).bind(tick as i64).bind(payload).bind(near.contract.to_string()).bind(&hashes)
        .bind(json!({ "signed_by": "player", "verified": "controller state read back before the economy applied it" }))
        .execute(&mut *db).await?;
    Ok(())
}
