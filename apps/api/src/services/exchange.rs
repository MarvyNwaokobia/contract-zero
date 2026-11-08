//! The Exchange: players trade with the merchant at firm, player-signed quotes.
//!
//! **On chain** (settlement enabled), a trade is the player's own transaction:
//!
//! 1. **Quote.** The engine resyncs the player's holdings from `cz-assets` (players own
//!    their tokens and may move them anywhere), reserves the quote and holds the
//!    merchant's side in escrow. Vex then posts a matching offer (the player buys)
//!    or bid (the player sells) on the controller, addressed to that player only.
//! 2. **Accept.** The player signs `accept_offer` / `accept_bid` on the controller
//!    with their own key, with the quoted total as their price limit. The server
//!    never signs for a player and holds no player key.
//! 3. **Resolve.** The quote settles in the engine only once `cz-assets` reports the
//!    operation applied (`is_used("ctl:<quote>")`: value actually moved). A quote that
//!    lapses unaccepted is cancelled on chain and its hold returns to the merchant.
//!    The player's confirm call resolves it immediately; a sweeper resolves the rest.
//!
//! **Off chain** (no `CZ_WORLD`), `accept` settles directly in the engine and every
//! response says `settled_on_chain: false`.

use std::collections::HashMap;

use cz_economy::{Asset, Event, PlayerQuote, Resource, Side};
use serde_json::{json, Value};

use super::near::{NearClient, Role};
use super::world::{log_event, WorldError};
use crate::AppState;

/// How long a quote stands on chain.
pub const QUOTE_TTL_SECS: u32 = 300;
/// After expiry, how long the sweeper waits before releasing (an accept submitted just
/// before expiry may still be finalizing).
const SWEEP_GRACE_SECS: i64 = 30;
/// Gas the player's accept transaction attaches (about 10 TGas is burnt; the rest is
/// reserved for the follow-up calls, 50 TGas): the controller registers the
/// player's storage, settles both legs on `cz-assets`, then runs its callback.
pub const ACCEPT_GAS: u64 = 60_000_000_000_000;

const ASSETS: [Asset; 4] = [Asset::Credits, Asset::Res(Resource::Ammo), Asset::Res(Resource::Med), Asset::Res(Resource::Fuel)];

#[derive(Debug, thiserror::Error)]
pub enum ExchangeError {
    #[error(transparent)]
    World(#[from] WorldError),
    #[error("{0}")]
    Busy(String),
    #[error("{0}")]
    NotFound(String),
    #[error("NEAR: {0}")]
    Chain(String),
}

impl From<sqlx::Error> for ExchangeError {
    fn from(e: sqlx::Error) -> Self {
        ExchangeError::World(WorldError::Db(e))
    }
}

fn side_name(s: Side) -> &'static str {
    match s {
        Side::Buy => "buy",
        Side::Sell => "sell",
    }
}

/// (method, quote key, limit arg) for the player's acceptance of `side`.
fn accept_shape(side: Side) -> (&'static str, &'static str, &'static str) {
    match side {
        Side::Buy => ("accept_offer", "offer", "max_total"),
        Side::Sell => ("accept_bid", "bid", "min_total"),
    }
}

/// Raid cargo that is credited in the engine but not yet on chain would be wiped by a
/// resync, so a player with open settlements waits until they land.
async fn has_open_settlements(state: &AppState, near: &NearClient, player: &str) -> Result<bool, sqlx::Error> {
    let (n,): (i64,) = sqlx::query_as("SELECT count(*) FROM settlements WHERE status IN ('pending', 'submitted') AND contract = $1 AND payload->>'player' = $2")
        .bind(near.contract.to_string())
        .bind(player)
        .fetch_one(state.world.db())
        .await?;
    Ok(n > 0)
}

async fn chain_holdings(near: &NearClient, player: &str) -> Result<HashMap<String, i64>, ExchangeError> {
    near.balances(player).await.map_err(ExchangeError::Chain)
}

fn quote_json(q: &PlayerQuote) -> Value {
    json!({
        "id": q.id, "player": q.player, "resource": q.resource, "side": side_name(q.side), "qty": q.qty,
        "total": q.total, "unit": if q.qty > 0 { q.total as f64 / q.qty as f64 } else { 0.0 }, "status": q.status,
    })
}

/// Reserve a quote for `player` and post it on chain.
pub async fn create(state: &AppState, player: String, resource: Resource, side: Side, qty: i64, limit_total: i64) -> Result<Value, ExchangeError> {
    let near = state.near.clone();
    let chain = match &near {
        Some(n) => {
            if has_open_settlements(state, n, &player).await? {
                return Err(ExchangeError::Busy("your raid cargo is still settling on NEAR; try again in a few seconds".into()));
            }
            Some(chain_holdings(n, &player).await?)
        }
        None => None,
    };
    let p = player.clone();
    let quote = state
        .world
        .transact(async move |w, db| {
            let mut synced = Vec::new();
            if let Some(chain) = &chain {
                for a in ASSETS {
                    synced.extend(w.sync_holding(&p, a, chain.get(a.name()).copied().unwrap_or(0))?);
                }
            }
            let q = w.reserve_quote(&p, resource, side, qty, limit_total)?;
            log_event(db, w.tick, &format!("player:{p}"), "exchange", &json!({ "phase": "quote", "quote": quote_json(&q), "synced": synced })).await?;
            Ok(q)
        })
        .await?;

    let Some(near) = near else {
        sqlx::query("INSERT INTO player_quotes (quote_id, player, side, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))")
            .bind(quote.id as i64)
            .bind(&player)
            .bind(side_name(side))
            .bind(QUOTE_TTL_SECS as f64)
            .execute(state.world.db())
            .await?;
        return Ok(json!({ "quote": quote_json(&quote), "chain": null, "settled_on_chain": false, "expires_in_secs": QUOTE_TTL_SECS }));
    };

    // A fresh suffix per quote: quote ids are never reused on the controller, even
    // across economy resets.
    let suffix = &uuid::Uuid::new_v4().simple().to_string()[..8];
    let chain_id = format!("px-{}-{suffix}", quote.id);
    let (method, key, limit_arg) = accept_shape(side);
    let (post, counterparty) = match side {
        Side::Buy => ("post_offer", "buyer"),
        Side::Sell => ("post_bid", "seller"),
    };
    let posted = near
        .call(Role::Vex, post, json!({
            format!("{key}_id"): chain_id, counterparty: player, "token_id": resource.name(), "amount": quote.qty.to_string(),
            "total_credits": quote.total.to_string(), "ttl_secs": QUOTE_TTL_SECS,
        }), 0)
        .await;
    let posted = match posted {
        Ok(v) => v,
        Err(e) => {
            let id = quote.id;
            let _ = state.world.transact(async move |w, _| Ok(w.release_quote(id)?)).await;
            return Err(ExchangeError::Chain(format!("Vex could not post the quote: {e}")));
        }
    };
    sqlx::query(
        "INSERT INTO player_quotes (quote_id, contract, chain_quote, player, side, expires_at, tx_hashes)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6), $7)",
    )
    .bind(quote.id as i64)
    .bind(near.contract.to_string())
    .bind(format!("{key}:{chain_id}"))
    .bind(&player)
    .bind(side_name(side))
    .bind(QUOTE_TTL_SECS as f64)
    .bind(vec![posted.tx_hash.clone()])
    .execute(state.world.db())
    .await?;
    Ok(json!({
        "quote": quote_json(&quote),
        "expires_in_secs": QUOTE_TTL_SECS,
        "settled_on_chain": false,
        "posted": { "tx_hash": posted.tx_hash, "explorer": posted.explorer },
        // Exactly what the player's wallet signs.
        "chain": {
            "receiver_id": near.contract.to_string(), "method": method,
            "args": { format!("{key}_id"): chain_id, limit_arg: quote.total.to_string() },
            "gas": ACCEPT_GAS.to_string(), "deposit": "0",
        },
    }))
}

type QuoteRow = (i64, Option<String>, String, String, chrono::DateTime<chrono::Utc>, Vec<String>, bool);

async fn load_row(state: &AppState, quote_id: u64) -> Result<QuoteRow, ExchangeError> {
    sqlx::query_as("SELECT quote_id, chain_quote, player, status, expires_at, tx_hashes, expires_at + make_interval(secs => $2) < now() FROM player_quotes WHERE quote_id = $1")
        .bind(quote_id as i64)
        .bind(SWEEP_GRACE_SECS as f64)
        .fetch_optional(state.world.db())
        .await?
        .ok_or_else(|| ExchangeError::NotFound(format!("no quote {quote_id}")))
}

async fn current(state: &AppState, quote_id: u64) -> Result<Value, ExchangeError> {
    let (_, chain_quote, _, status, expires_at, hashes, _) = load_row(state, quote_id).await?;
    let expires_in = (expires_at - chrono::Utc::now()).num_seconds().max(0);
    let q = state.world.read(|w| w.quotes.get(&quote_id).cloned()).await.ok_or_else(|| ExchangeError::NotFound(format!("no quote {quote_id}")))?;
    Ok(json!({
        "quote": quote_json(&q), "status": status, "chain_quote": chain_quote, "expires_in_secs": expires_in,
        "settled_on_chain": status == "settled" && chain_quote.is_some(),
        "tx_hashes": hashes, "explorer": hashes.iter().map(|h| super::near::explorer_tx(h)).collect::<Vec<_>>(),
    }))
}

/// Resolve a quote against the chain: settle it if the player's acceptance moved
/// value, release it if it lapsed, otherwise leave it open. `tx_hash` (the player's
/// accept transaction, if the client has it) is verified and recorded.
pub async fn resolve(state: &AppState, quote_id: u64, tx_hash: Option<String>) -> Result<Value, ExchangeError> {
    // One resolver at a time (the player's confirm, a status poll and the sweeper can
    // all arrive together); each re-reads the quote after taking the lock.
    let _g = RESOLVE.lock().await;
    resolve_locked(state, quote_id, tx_hash).await
}

/// Serializes quote resolution across the process.
static RESOLVE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn resolve_locked(state: &AppState, quote_id: u64, tx_hash: Option<String>) -> Result<Value, ExchangeError> {
    let (_, chain_quote, player, status, _, _, lapsed) = load_row(state, quote_id).await?;
    if status != "open" {
        return current(state, quote_id).await;
    }
    let Some(near) = state.near.clone() else { return current(state, quote_id).await };
    let Some(chain_quote) = chain_quote else { return current(state, quote_id).await };

    let applied = near.view_assets("is_used", json!({ "op_id": format!("ctl:{chain_quote}") })).await.map_err(ExchangeError::Chain)?.as_bool().unwrap_or(false);
    if applied {
        let q = state.world.read(|w| w.quotes.get(&quote_id).cloned()).await.ok_or_else(|| ExchangeError::NotFound(format!("no quote {quote_id}")))?;
        let mut hashes = Vec::new();
        if let Some(h) = tx_hash.filter(|h| !h.is_empty()) {
            let (method, _, _) = accept_shape(q.side);
            let signer = player.parse().map_err(|_| ExchangeError::Chain("bad player account".into()))?;
            let v = near.verify(&h, &signer, method).await.map_err(ExchangeError::Chain)?;
            hashes.push(v.tx_hash);
        }
        // The chain already moved the trade; resync the player to their holdings just
        // before it (chain now minus the trade's effect), then settle the quote, so
        // the engine ends exactly at the chain's balances.
        let chain = if has_open_settlements(state, &near, &player).await? { None } else { Some(chain_holdings(&near, &player).await?) };
        let p = player.clone();
        let events = state
            .world
            .transact(async move |w, db| {
                let mut ev = Vec::new();
                if let Some(chain) = &chain {
                    let (credit_delta, res_delta) = match q.side { Side::Buy => (-q.total, q.qty), Side::Sell => (q.total, -q.qty) };
                    for (asset, delta) in [(Asset::Credits, credit_delta), (Asset::Res(q.resource), res_delta)] {
                        ev.extend(w.sync_holding(&p, asset, chain.get(asset.name()).copied().unwrap_or(0) - delta)?);
                    }
                }
                ev.extend(w.settle_quote(quote_id)?);
                log_event(db, w.tick, &format!("player:{p}"), "exchange", &json!({ "phase": "settled", "quote": quote_id, "events": super::world::summarize(&ev) })).await?;
                Ok(ev)
            })
            .await?;
        let trade = events.iter().find_map(|e| if let Event::QuoteSettled { trade, .. } = e { Some(*trade) } else { None });
        sqlx::query("UPDATE player_quotes SET status = 'settled', resolved_at = now(), tx_hashes = tx_hashes || $2, detail = $3 WHERE quote_id = $1")
            .bind(quote_id as i64)
            .bind(hashes)
            .bind(json!({ "trade": trade }))
            .execute(state.world.db())
            .await?;
        return current(state, quote_id).await;
    }

    if !lapsed {
        return current(state, quote_id).await;
    }
    // Still settling on the controller (an accept in flight)? Wait for its callback.
    let on_chain = near.view("get_quote", json!({ "quote_id": chain_quote })).await.map_err(ExchangeError::Chain)?;
    if on_chain.get("state").and_then(|s| s.as_str()) == Some("Settling") {
        return current(state, quote_id).await;
    }
    let mut hashes = Vec::new();
    if !on_chain.is_null() {
        match near.call(Role::Vex, "cancel_quote", json!({ "quote_id": chain_quote }), 0).await {
            Ok(v) => hashes.push(v.tx_hash),
            // Lost a race with an acceptance: resolve again next sweep.
            Err(e) => return Err(ExchangeError::Chain(format!("cancel failed: {e}"))),
        }
    }
    // Cancelled (or never accepted): make sure value did not move after all.
    let applied = near.view_assets("is_used", json!({ "op_id": format!("ctl:{chain_quote}") })).await.map_err(ExchangeError::Chain)?.as_bool().unwrap_or(false);
    if applied {
        return Box::pin(resolve_locked(state, quote_id, None)).await;
    }
    state
        .world
        .transact(async move |w, db| {
            let ev = w.release_quote(quote_id)?;
            log_event(db, w.tick, "system", "exchange", &json!({ "phase": "released", "quote": quote_id })).await?;
            Ok(ev)
        })
        .await?;
    sqlx::query("UPDATE player_quotes SET status = 'released', resolved_at = now(), tx_hashes = tx_hashes || $2 WHERE quote_id = $1")
        .bind(quote_id as i64)
        .bind(hashes)
        .execute(state.world.db())
        .await?;
    current(state, quote_id).await
}

/// Off-chain only: the player accepts directly in the engine.
pub async fn accept_offchain(state: &AppState, quote_id: u64) -> Result<Value, ExchangeError> {
    if state.near.is_some() {
        return Err(ExchangeError::Busy("settlement is on NEAR: sign the acceptance with your wallet".into()));
    }
    let _g = RESOLVE.lock().await;
    let (_, _, player, status, _, _, _) = load_row(state, quote_id).await?;
    if status != "open" {
        return current(state, quote_id).await;
    }
    state
        .world
        .transact(async move |w, db| {
            let ev = w.settle_quote(quote_id)?;
            log_event(db, w.tick, &format!("player:{player}"), "exchange", &json!({ "phase": "settled", "quote": quote_id, "off_chain": true })).await?;
            Ok(ev)
        })
        .await?;
    sqlx::query("UPDATE player_quotes SET status = 'settled', resolved_at = now() WHERE quote_id = $1").bind(quote_id as i64).execute(state.world.db()).await?;
    current(state, quote_id).await
}

/// Release every lapsed open quote (or settle it, if the player's acceptance landed).
pub async fn sweep(state: &AppState) -> Result<usize, ExchangeError> {
    let due: Vec<(i64,)> = sqlx::query_as("SELECT quote_id FROM player_quotes WHERE status = 'open' AND expires_at + make_interval(secs => $1) < now() ORDER BY quote_id LIMIT 20")
        .bind(SWEEP_GRACE_SECS as f64)
        .fetch_all(state.world.db())
        .await?;
    let mut n = 0;
    for (id,) in due {
        if state.near.is_none() {
            let id = id as u64;
            let _g = RESOLVE.lock().await;
            if load_row(state, id).await?.3 != "open" {
                continue;
            }
            state.world.transact(async move |w, _| Ok(w.release_quote(id)?)).await?;
            sqlx::query("UPDATE player_quotes SET status = 'released', resolved_at = now() WHERE quote_id = $1").bind(id as i64).execute(state.world.db()).await?;
        } else if let Err(e) = resolve(state, id as u64, None).await {
            tracing::warn!("exchange: quote {id} not resolved yet: {e}");
            continue;
        }
        n += 1;
    }
    Ok(n)
}

pub fn spawn_sweeper(state: AppState) {
    tokio::spawn(async move {
        loop {
            match sweep(&state).await {
                Ok(n) if n > 0 => tracing::info!("exchange: resolved {n} lapsed quote(s)"),
                Ok(_) => {}
                Err(e) => tracing::error!("exchange sweeper: {e}"),
            }
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        }
    });
}

/// The market as one player sees it: the merchant's prices for every resource, what
/// the player holds (on chain when settlement is on), their open quote, and where
/// factions are short (which is where prices and raid payouts move next).
pub async fn overview(state: &AppState, player: Option<String>) -> Result<Value, ExchangeError> {
    let chain = match (&state.near, &player) {
        (Some(n), Some(p)) => Some(chain_holdings(n, p).await?),
        _ => None,
    };
    let p = player.clone();
    let v = state
        .world
        .read(move |w| {
            let m = w.merchant();
            let lot = 10;
            let prices: Vec<Value> = Resource::ALL
                .iter()
                .map(|&r| {
                    let pb = w.price(r);
                    json!({
                        "resource": r, "stock": w.merchant_stock(r), "target": pb.target, "ask": pb.ask, "bid": pb.bid, "mid": pb.mid,
                        "scarcity_bp": pb.scarcity_bp, "demand_bp": pb.demand_bp, "net_demand_24h": pb.net_demand_24h,
                        "buy_10": w.quote(r, Side::Buy, lot).ok().map(|q| q.total),
                        "sell_10": if w.merchant_insolvent() { None } else { w.quote(r, Side::Sell, lot).ok().map(|q| q.total) },
                    })
                })
                .collect();
            let shortages: Vec<Value> = w
                .actors
                .values()
                .filter(|a| a.kind == cz_economy::ActorKind::Faction)
                .flat_map(|a| {
                    Resource::ALL.iter().filter_map(move |&r| {
                        let target = if r == Resource::Ammo { cz_economy::policy::ammo_target(a) } else { a.requirement(r) };
                        let have = w.balance(&a.account, Asset::Res(r));
                        (have < target).then(|| json!({ "actor": a.id, "name": a.name, "resource": r, "have": have, "target": target, "short": target - have }))
                    })
                })
                .collect();
            let holdings = p.as_ref().map(|p| {
                let acct = cz_economy::player_account(p);
                ASSETS.iter().map(|a| (a.name().to_string(), json!(w.balance(&acct, *a)))).collect::<serde_json::Map<_, _>>()
            });
            let open = p.as_ref().and_then(|p| w.open_quote_of(p)).map(quote_json);
            let trades: Vec<Value> = p
                .as_ref()
                .map(|p| {
                    let acct = cz_economy::player_account(p);
                    w.trades.iter().rev().filter(|t| t.party == acct).take(10).map(|t| json!(t)).collect()
                })
                .unwrap_or_default();
            json!({
                "tick": w.tick, "merchant": { "id": m.id, "name": m.name, "insolvent": w.merchant_insolvent(), "credits": w.balance(&m.account, Asset::Credits) },
                "prices": prices, "shortages": shortages, "engine_holdings": holdings, "open_quote": open, "trades": trades,
            })
        })
        .await;
    let mut v = v;
    v["chain_holdings"] = json!(chain);
    v["settlement"] = json!(if state.near.is_some() { "near" } else { "off_chain" });
    v["quote_ttl_secs"] = json!(QUOTE_TTL_SECS);
    Ok(v)
}
