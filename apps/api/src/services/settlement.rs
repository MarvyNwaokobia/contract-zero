//! Mirrors the economy onto CZ World and proves it.
//!
//! **What settles.** Three kinds of operation are queued, in economic order, in the
//! `settlements` table:
//!
//! - `flows`: the ledger's issuance and destruction on actor accounts since the last
//!   sync (production, income, consumption, logistics, wages, imports, and shipments
//!   as they arrive), netted per account and token into bounded `apply_flows` batches.
//! - `raid`: a validated raid's cargo (and any sponsor bounty) via `settle_raid`.
//! - `trade`: an agent purchase from the merchant, as Vex's `post_offer` followed by
//!   the buyer's `accept_offer` with the agreed price as its ceiling.
//!
//! Before a trade or raid is queued, the flows that funded it are queued, so the
//! worker (which submits strictly in id order) never asks the chain to spend what it
//! has not yet been told exists.
//!
//! **What counts as settled.** A row becomes `confirmed` only after every transaction
//! for it has been fetched from RPC at FINAL and every receipt succeeded
//! ([`NearClient::verify`]). A trade that cannot settle is reversed in the economy
//! (`compensated`) so the two never silently diverge.
//!
//! **Escrow.** Bounty escrow is an off-chain hold: on chain the sponsor keeps the
//! credits until `settle_raid` pays them out, so reconciliation counts a sponsor's
//! escrowed credits as still its own.

use std::collections::BTreeMap;

use cz_economy::{Asset, BountyStatus, Reason, TradeRecord, World};
use serde_json::{json, Value};
use sqlx::PgPool;

use super::near::{NearClient, Role, Verified};
use super::world::log_event;
use crate::AppState;

/// Contract limits (contracts-near/cz-world): entries per batch, amount per entry.
const MAX_FLOWS: usize = 32;
const MAX_AMOUNT: i64 = 100_000;

/// The chain account for an engine account.
pub fn chain_account(near: &NearClient, engine_account: &str) -> Option<String> {
    if let Some(p) = engine_account.strip_prefix("player:") {
        return Some(p.to_string());
    }
    let id = engine_account.strip_prefix("faction:").or_else(|| engine_account.strip_prefix("merchant:"))?;
    near.actor_account(id).map(|a| a.to_string())
}

fn actor_accounts(w: &World) -> Vec<String> {
    w.actors.values().map(|a| a.account.clone()).collect()
}

/// Credits `actor_id` has locked in open bounties (still its own on chain).
pub fn escrowed_by(w: &World, actor_id: &str) -> i64 {
    w.bounties.values().filter(|b| b.sponsor == actor_id && b.status == BountyStatus::Open).map(|b| b.amount).sum()
}

type Flows = BTreeMap<(String, Asset), i64>;

/// Net issuance (mints) and destruction (burns) on actor accounts in `ledger[from..to]`.
pub fn flows_between(w: &World, from: usize, to: usize) -> (Flows, Flows) {
    let actors = actor_accounts(w);
    let (mut mints, mut burns) = (Flows::new(), Flows::new());
    for e in &w.ledger[from.min(w.ledger.len())..to.min(w.ledger.len())] {
        let t = &e.transfer;
        // Cargo that reaches an actor from a convoy (on arrival, or seized on the road)
        // appears on chain then: convoys themselves are engine-only.
        let arrived = matches!(t.reason, Reason::ShipmentArrived { .. } | Reason::Seized { .. });
        match t.reason.class() {
            "issuance" if actors.contains(&t.to) => *mints.entry((t.to.clone(), t.asset)).or_default() += t.qty,
            "destruction" if actors.contains(&t.from) => *burns.entry((t.from.clone(), t.asset)).or_default() += t.qty,
            _ if arrived && actors.contains(&t.to) => *mints.entry((t.to.clone(), t.asset)).or_default() += t.qty,
            _ => {}
        }
    }
    (mints, burns)
}

/// Contract-sized `apply_flows` batches (≤ 32 entries, each ≤ 100,000).
fn batches(near: &NearClient, mints: &Flows, burns: &Flows) -> Vec<(Vec<Value>, Vec<Value>)> {
    let expand = |m: &Flows| -> Vec<Value> {
        let mut v = Vec::new();
        for ((acct, asset), qty) in m {
            let Some(account) = chain_account(near, acct) else { continue };
            let mut left = *qty;
            while left > 0 {
                let n = left.min(MAX_AMOUNT);
                v.push(json!({ "account_id": account, "token_id": asset.name(), "amount": n.to_string() }));
                left -= n;
            }
        }
        v
    };
    let (mut m, mut b) = (expand(mints), expand(burns));
    let mut out = Vec::new();
    while !m.is_empty() || !b.is_empty() {
        let take_m = m.len().min(MAX_FLOWS);
        let mm: Vec<Value> = m.drain(..take_m).collect();
        let take_b = b.len().min(MAX_FLOWS - mm.len());
        let bb: Vec<Value> = b.drain(..take_b).collect();
        out.push((mm, bb));
    }
    out
}

/// The ledger position mirrored on chain for this controller.
async fn cursor(db: &PgPool, contract: &str) -> Result<i64, sqlx::Error> {
    sqlx::query("INSERT INTO chain_cursor (contract) VALUES ($1) ON CONFLICT (contract) DO NOTHING").bind(contract).execute(db).await?;
    let (c,): (i64,) = sqlx::query_as("SELECT ledger_seq FROM chain_cursor WHERE contract = $1").bind(contract).fetch_one(db).await?;
    Ok(c)
}

async fn set_cursor(db: &PgPool, contract: &str, seq: i64) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE chain_cursor SET ledger_seq = $2, updated_at = now() WHERE contract = $1").bind(contract).bind(seq).execute(db).await?;
    Ok(())
}

pub async fn enqueue(db: &PgPool, near: &NearClient, kind: &str, op_id: &str, tick: u64, payload: &Value) -> Result<bool, sqlx::Error> {
    let r = sqlx::query("INSERT INTO settlements (kind, op_id, tick, payload, contract) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (contract, op_id) DO NOTHING")
        .bind(kind)
        .bind(op_id)
        .bind(tick as i64)
        .bind(payload)
        .bind(near.contract.to_string())
        .execute(db)
        .await?;
    Ok(r.rows_affected() == 1)
}

/// Queue the flows since the cursor and advance it. Call inside a world transaction.
pub async fn sync_flows(w: &World, db: &PgPool, near: &NearClient) -> Result<(), sqlx::Error> {
    let contract = near.contract.to_string();
    let cursor = cursor(db, &contract).await?;
    let to = w.ledger.len();
    if to as i64 <= cursor {
        return Ok(());
    }
    let (mints, burns) = flows_between(w, cursor as usize, to);
    for (i, (m, b)) in batches(near, &mints, &burns).into_iter().enumerate() {
        let batch_id = format!("ledger-{cursor}-{to}-{i}");
        enqueue(db, near, "flows", &format!("flows:{batch_id}"), w.tick, &json!({ "batch_id": batch_id, "mints": m, "burns": b })).await?;
    }
    set_cursor(db, &contract, to as i64).await?;
    Ok(())
}

/// Queue an agent's trade with the merchant (after the flows that fund it). A purchase
/// settles as a merchant offer the agent accepts; a sale as a merchant bid it accepts.
pub async fn queue_trade(w: &World, db: &PgPool, near: &NearClient, t: &TradeRecord) -> Result<(), sqlx::Error> {
    let Some(party) = chain_account(near, &t.party) else { return Ok(()) };
    sync_flows(w, db, near).await?;
    let (kind, base) = match t.side {
        cz_economy::Side::Buy => ("trade", format!("trade-{}", t.id)),
        cz_economy::Side::Sell => ("sell", format!("sale-{}", t.id)),
    };
    let payload = json!({ "trade": t.id, "quote_base": base, "party": party, "token_id": t.resource.name(), "amount": t.qty.to_string(), "total": t.total.to_string() });
    enqueue(db, near, kind, &base, w.tick, &payload).await.map(|_| ())
}

/// Queue a validated raid's settlement (after the flows that put the cargo there).
pub async fn queue_raid(w: &World, db: &PgPool, near: &NearClient, raid: u64) -> Result<Option<String>, sqlx::Error> {
    let r = &w.raids[&raid];
    let cz_economy::RaidStatus::Extracted { units, bounty } = r.status else { return Ok(None) };
    if units == 0 && bounty == 0 {
        return Ok(None);
    }
    sync_flows(w, db, near).await?;
    let faction = chain_account(near, &w.actors[&r.plan.target].account).unwrap_or_default();
    let sponsor = w
        .bounties
        .values()
        .find(|b| matches!(&b.status, BountyStatus::Paid { raid: id, .. } if *id == raid))
        .and_then(|b| chain_account(near, &w.actors[&b.sponsor].account));
    let op = format!("raid:{raid}");
    let payload = json!({
        "raid_id": raid.to_string(), "faction": faction, "player": r.player, "token_id": r.plan.resource.name(),
        "amount": units.to_string(), "bounty": sponsor.map(|s| json!([s, bounty.to_string()])),
    });
    enqueue(db, near, "raid", &op, w.tick, &payload).await?;
    Ok(Some(op))
}

/// Queue a settled sabotage or recovery: every actor-to-actor or actor-to-player leg
/// of the operation (a recovery's cargo going home, the fee from the sponsor's
/// escrow) as one `settle_operation`, after the flows (e.g. a sabotage's burn).
pub async fn queue_operation(w: &World, db: &PgPool, near: &NearClient, raid: u64) -> Result<Option<String>, sqlx::Error> {
    sync_flows(w, db, near).await?;
    let r = &w.raids[&raid];
    let mut legs = Vec::new();
    for e in &w.ledger {
        let t = &e.transfer;
        let from = match &t.reason {
            Reason::Recovered { raid: id } if *id == raid => chain_account(near, &t.from),
            // The fee leaves the sponsor's escrow, which on chain is still the sponsor's.
            Reason::BountyPaid { bounty, raid: id } if *id == raid => w.bounties.get(bounty).and_then(|b| w.actors.get(&b.sponsor)).and_then(|a| chain_account(near, &a.account)),
            _ => continue,
        };
        let (Some(from), Some(to)) = (from, chain_account(near, &t.to)) else { continue };
        legs.push(json!({ "from": from, "to": to, "token_id": t.asset.name(), "amount": t.qty.to_string() }));
    }
    if legs.is_empty() {
        return Ok(None);
    }
    let op = format!("op:{raid}");
    enqueue(db, near, "operation", &op, w.tick, &json!({ "op_id": raid.to_string(), "player": r.player, "legs": legs })).await?;
    Ok(Some(op))
}

/// One-time alignment when the chain already holds state the ledger cursor knows
/// nothing about (a fresh economy against an existing contract): mint or burn the
/// difference per actor, then start the cursor at the current ledger.
pub async fn bootstrap(state: &AppState) -> Result<(), String> {
    align(state, false, false).await.map(|_| ())
}

/// Bring the chain to the economy's current balances in one batch per actor/token
/// difference. At startup (`force = false`) only on a fresh cursor. Forced (admin), it
/// repairs a mirror that went out of order: the stranded flow batches it replaces
/// are marked `superseded`. Refuses while any trade, raid or operation is still open,
/// since those settle against the balances being aligned.
///
/// `full` is for a deep backlog: queued agent trades are retired as well and the chain
/// is set straight to the economy. The economy already applied those trades; after a
/// long stall the "economy minus queued trades" target can go negative (the merchant
/// has resold or exported goods those trades were still bringing in on chain).
pub async fn align(state: &AppState, force: bool, full: bool) -> Result<Value, String> {
    let Some(near) = state.near.clone() else { return Ok(json!({ "enabled": false })) };
    let contract = near.contract.to_string();
    if !force && cursor(state.world.db(), &contract).await.map_err(|e| e.to_string())? > 0 {
        return Ok(json!({ "aligned": false, "reason": "cursor already set" }));
    }
    let db = state.world.db();
    // Trades still queued are already in the economy but not yet on chain; align to
    // the economy MINUS their effect, so that once they settle (after this batch:
    // alignment runs first) the chain ends exactly at the economy.
    let mut pending: BTreeMap<(String, String), i64> = BTreeMap::new();
    if force {
        let (busy,): (i64,) = sqlx::query_as("SELECT count(*) FROM settlements WHERE contract = $1 AND status IN ('pending', 'submitted') AND kind IN ('raid', 'operation')")
            .bind(&contract).fetch_one(db).await.map_err(|e| e.to_string())?;
        if busy > 0 {
            return Err(format!("{busy} raid/operation settlement(s) still open; retry when they land"));
        }
        if full {
            sqlx::query("UPDATE settlements SET status = 'superseded', error = 'replaced by a full realignment' WHERE contract = $1 AND status IN ('pending', 'submitted', 'failed') AND kind IN ('trade', 'sell')")
                .bind(&contract).execute(db).await.map_err(|e| e.to_string())?;
        }
        let rows: Vec<(String, Value)> = sqlx::query_as("SELECT kind, payload FROM settlements WHERE contract = $1 AND status IN ('pending', 'submitted') AND kind IN ('trade', 'sell')")
            .bind(&contract).fetch_all(db).await.map_err(|e| e.to_string())?;
        let vex = near.account(Role::Vex).to_string();
        for (kind, p) in rows {
            let party = p["party"].as_str().unwrap_or_default().to_string();
            let token = p["token_id"].as_str().unwrap_or_default().to_string();
            let qty: i64 = p["amount"].as_str().and_then(|v| v.parse().ok()).unwrap_or(0);
            let total: i64 = p["total"].as_str().and_then(|v| v.parse().ok()).unwrap_or(0);
            // A purchase moves goods merchant → party and credits party → merchant; a sale the reverse.
            let s = if kind == "trade" { 1 } else { -1 };
            *pending.entry((party.clone(), token.clone())).or_default() += s * qty;
            *pending.entry((vex.clone(), token)).or_default() -= s * qty;
            *pending.entry((party, "credits".into())).or_default() -= s * total;
            *pending.entry((vex.clone(), "credits".into())).or_default() += s * total;
        }
    }
    // Read the chain first (no lock held across RPC), then align under the lock.
    let mut chain: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
    for role in [Role::Vanguard, Role::Vex, Role::Ashen] {
        let Some(acct) = near.actor_account(match role { Role::Vanguard => "vanguard", Role::Vex => "vex", _ => "ashen" }).map(|a| a.to_string()) else { continue };
        chain.insert(acct.clone(), near.balances(&acct).await?.into_iter().collect());
    }
    state
        .world
        .transact(async move |w, db| {
            if force {
                sqlx::query("UPDATE settlements SET status = 'superseded', error = 'replaced by a realignment batch' WHERE contract = $1 AND status IN ('pending', 'submitted', 'failed') AND kind IN ('flows', 'genesis')")
                    .bind(near.contract.to_string()).execute(db).await?;
            }
            let (mut mints, mut burns) = (Flows::new(), Flows::new());
            for a in w.actors.values() {
                let Some(acct) = chain_account(&near, &a.account) else { continue };
                for asset in cz_economy::ALL_ASSETS {
                    // What the actor holds on chain: its balance plus anything the
                    // economy holds for it off chain (bounty escrow, quote holds).
                    let mut engine = w.balance(&a.account, asset);
                    if asset == Asset::Credits {
                        engine += escrowed_by(w, &a.id);
                    }
                    if a.id == w.market.merchant {
                        engine += w.held_for_quotes(asset);
                    }
                    engine -= pending.get(&(acct.clone(), asset.name().to_string())).copied().unwrap_or(0);
                    let on_chain = chain.get(&acct).and_then(|m| m.get(asset.name())).copied().unwrap_or(0);
                    match engine - on_chain {
                        d if d > 0 => { mints.insert((a.account.clone(), asset), d); }
                        d if d < 0 => { burns.insert((a.account.clone(), asset), -d); }
                        _ => {}
                    }
                }
            }
            let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S");
            let mut ops = Vec::new();
            for (i, (m, b)) in batches(&near, &mints, &burns).into_iter().enumerate() {
                let batch_id = format!("{}-{stamp}-{i}", if force { "realign" } else { "baseline" });
                enqueue(db, &near, "genesis", &format!("flows:{batch_id}"), w.tick, &json!({ "batch_id": batch_id, "mints": m, "burns": b, "note": if force { "realign the chain with the economy" } else { "align the chain with the economy at startup" } })).await?;
                ops.push(format!("flows:{batch_id}"));
            }
            set_cursor(db, &near.contract.to_string(), w.ledger.len() as i64).await?;
            Ok(json!({ "aligned": true, "batches": ops, "mints": mints.len(), "burns": burns.len() }))
        })
        .await
        .map_err(|e| e.to_string())
}

type Row = (i64, String, String, Value, i32);

/// Submit the oldest open settlement. Returns whether there was one.
pub async fn process_next(state: &AppState) -> Result<bool, String> {
    let Some(near) = state.near.clone() else { return Ok(false) };
    let db = state.world.db();
    // Only this controller's rows: rows for another contract (e.g. the frozen v1) are
    // never submitted here.
    let row: Option<Row> = sqlx::query_as("SELECT id, kind, op_id, payload, attempts FROM settlements WHERE status IN ('pending', 'submitted') AND contract = $1 ORDER BY (kind <> 'genesis'), id LIMIT 1")
        .bind(near.contract.to_string())
        .fetch_optional(db)
        .await
        .map_err(|e| e.to_string())?;
    let Some((id, kind, op_id, payload, attempts)) = row else { return Ok(false) };
    sqlx::query("UPDATE settlements SET status = 'submitted', attempts = attempts + 1 WHERE id = $1").bind(id).execute(db).await.map_err(|e| e.to_string())?;

    // Already applied on chain (e.g. a crash after submit)? Ask cz-assets, which marks
    // a controller operation used ONLY when value actually moved. (A cancelled or
    // expired quote is used in the controller but never in cz-assets.)
    let attempt = attempts + 1;
    let ledger_ops: Vec<String> = match kind.as_str() {
        "trade" => (1..=attempt).map(|k| format!("ctl:offer:{}-a{k}", payload["quote_base"].as_str().unwrap_or_default())).collect(),
        "sell" => (1..=attempt).map(|k| format!("ctl:bid:{}-a{k}", payload["quote_base"].as_str().unwrap_or_default())).collect(),
        _ => vec![format!("ctl:{op_id}")],
    };
    let mut already = false;
    for op in &ledger_ops {
        if near.view_assets("is_used", json!({ "op_id": op })).await.ok().and_then(|v| v.as_bool()).unwrap_or(false) {
            already = true;
        }
    }
    let result: Result<Vec<Verified>, String> = if already {
        Ok(vec![])
    } else {
        match kind.as_str() {
            "genesis" | "flows" => near
                .call(Role::Server, "apply_flows", json!({ "batch_id": payload["batch_id"], "mints": payload["mints"], "burns": payload["burns"] }), 0)
                .await
                .map(|v| vec![v]),
            "raid" => near
                .call(Role::Server, "settle_raid", json!({
                    "raid_id": payload["raid_id"], "faction": payload["faction"], "player": payload["player"],
                    "token_id": payload["token_id"], "amount": payload["amount"], "bounty": payload["bounty"],
                }), 0)
                .await
                .map(|v| vec![v]),
            "operation" => near
                .call(Role::Server, "settle_operation", json!({ "op_id": payload["op_id"], "player": payload["player"], "legs": payload["legs"] }), 0)
                .await
                .map(|v| vec![v]),
            "trade" => settle_quote(&near, &payload, attempt, false).await,
            "sell" => settle_quote(&near, &payload, attempt, true).await,
            other => Err(format!("unknown settlement kind {other}")),
        }
    };

    match result {
        Ok(verified) => {
            let hashes: Vec<String> = verified.iter().map(|v| v.tx_hash.clone()).collect();
            let evidence = json!({ "already_applied": already, "transactions": verified });
            sqlx::query("UPDATE settlements SET status = 'confirmed', tx_hashes = $2, evidence = $3, error = NULL, confirmed_at = now() WHERE id = $1")
                .bind(id).bind(&hashes).bind(&evidence).execute(db).await.map_err(|e| e.to_string())?;
            let tick = state.world.read(|w| w.tick).await;
            let _ = log_event(db, tick, "near", "settlement", &json!({ "op_id": op_id, "kind": kind, "status": "confirmed", "tx_hashes": hashes, "explorer": verified.iter().map(|v| v.explorer.clone()).collect::<Vec<_>>(), "payload": payload })).await;
            tracing::info!("settlement {op_id} confirmed: {hashes:?}");
        }
        Err(e) => {
            tracing::warn!("settlement {op_id} attempt {} failed: {e}", attempts + 1);
            // Only a trade gives up (it is then compensated in the economy). Flows,
            // raids and operations mirror state the economy already committed and are
            // replay-protected on chain, so they retry until they land: a transient
            // RPC outage must delay them, never leave a permanent gap.
            let give_up = (kind == "trade" || kind == "sell") && attempts + 1 >= 3;
            let status = if give_up { "failed" } else { "pending" };
            sqlx::query("UPDATE settlements SET status = $2, error = $3 WHERE id = $1 AND status <> 'superseded'").bind(id).bind(status).bind(&e).execute(db).await.map_err(|e| e.to_string())?;
            if give_up && (kind == "trade" || kind == "sell") {
                compensate_trade(state, id, &payload).await;
            }
            let tick = state.world.read(|w| w.tick).await;
            let _ = log_event(db, tick, "near", "settlement", &json!({ "op_id": op_id, "kind": kind, "status": status, "error": e })).await;
            // Back off before the next attempt (2, 4, 8 … 60 s), so an RPC outage is
            // waited out instead of hammered.
            tokio::time::sleep(std::time::Duration::from_secs(2u64.pow((attempts + 1).clamp(1, 6) as u32).min(60))).await;
        }
    }
    Ok(true)
}

/// Settle an agent trade as a fresh, attempt-scoped quote: Vex posts an offer (it
/// sells) or a bid (it buys) to the party, and the party accepts with its price limit.
/// If acceptance fails the quote is cancelled; the next attempt uses a new id.
async fn settle_quote(near: &NearClient, p: &Value, attempt: i32, sale: bool) -> Result<Vec<Verified>, String> {
    let id = format!("{}-a{attempt}", p["quote_base"].as_str().unwrap_or_default());
    let party = p["party"].as_str().unwrap_or_default();
    let role = Role::for_actor(party.split('.').next().unwrap_or_default()).ok_or_else(|| format!("{party} has no signing key"))?;
    let (post, accept, quote_key, limit_key) = if sale { ("post_bid", "accept_bid", "bid", "min_total") } else { ("post_offer", "accept_offer", "offer", "max_total") };
    let counterparty = if sale { "seller" } else { "buyer" };
    let mut out = Vec::new();
    out.push(near.call(Role::Vex, post, json!({
        format!("{quote_key}_id"): id, counterparty: party, "token_id": p["token_id"], "amount": p["amount"], "total_credits": p["total"], "ttl_secs": 900,
    }), 0).await?);
    match near.call(role, accept, json!({ format!("{quote_key}_id"): id, limit_key: p["total"] }), 0).await {
        Ok(v) => {
            out.push(v);
            Ok(out)
        }
        Err(e) => {
            let _ = near.call(Role::Vex, "cancel_quote", json!({ "quote_id": format!("{quote_key}:{id}") }), 0).await;
            Err(e)
        }
    }
}

/// The trade could not settle on chain: reverse it in the economy.
async fn compensate_trade(state: &AppState, id: i64, p: &Value) {
    let Some(trade) = p["trade"].as_u64() else { return };
    let res = state.world.transact(async move |w, _db| Ok(w.reverse_trade(trade)?)).await;
    let db = state.world.db();
    match res {
        Ok(_) => {
            let _ = sqlx::query("UPDATE settlements SET status = 'compensated' WHERE id = $1").bind(id).execute(db).await;
            tracing::warn!("trade {trade} reversed in the economy after its settlement failed");
        }
        Err(e) => tracing::error!("trade {trade} failed on chain AND could not be reversed: {e}"),
    }
}

/// Engine vs chain balances for each actor, with what is still in flight.
pub async fn reconcile(state: &AppState) -> Result<Value, String> {
    let Some(near) = state.near.clone() else { return Ok(json!({ "enabled": false })) };
    let open: Vec<(String,)> = sqlx::query_as("SELECT op_id FROM settlements WHERE status IN ('pending', 'submitted') AND contract = $1 ORDER BY id")
        .bind(near.contract.to_string())
        .fetch_all(state.world.db())
        .await
        .map_err(|e| e.to_string())?;
    let cursor = cursor(state.world.db(), &near.contract.to_string()).await.map_err(|e| e.to_string())?;
    let (engine, ledger_len) = state
        .world
        .read(|w| {
            let mut m = BTreeMap::new();
            for a in w.actors.values() {
                let mut h = BTreeMap::new();
                for asset in cz_economy::ALL_ASSETS {
                    let mut v = w.balance(&a.account, asset);
                    if asset == Asset::Credits {
                        v += escrowed_by(w, &a.id);
                    }
                    // What the merchant holds for open player quotes is still its own
                    // on chain until the player accepts.
                    if a.id == w.market.merchant {
                        v += w.held_for_quotes(asset);
                    }
                    h.insert(asset.name().to_string(), v);
                }
                m.insert(a.account.clone(), h);
            }
            (m, w.ledger.len())
        })
        .await;
    let mut actors = Vec::new();
    let mut in_sync = open.is_empty() && cursor as usize == ledger_len;
    for (acct, eng) in &engine {
        let Some(chain_acct) = chain_account(&near, acct) else { continue };
        let chain = near.balances(&chain_acct).await?;
        let diff: BTreeMap<_, _> = eng.iter().map(|(t, v)| (t.clone(), v - chain.get(t).copied().unwrap_or(0))).filter(|(_, d)| *d != 0).collect();
        in_sync &= diff.is_empty();
        actors.push(json!({ "engine_account": acct, "chain_account": chain_acct, "engine": eng, "chain": chain, "difference": diff }));
    }
    Ok(json!({
        "enabled": true,
        "contract": near.contract.to_string(),
        "in_sync": in_sync,
        "unsynced_ledger_entries": ledger_len as i64 - cursor,
        "open_settlements": open.into_iter().map(|(o,)| o).collect::<Vec<_>>(),
        "actors": actors,
        "note": "Differences are expected while settlements are open or ledger entries are unsynced; they must reach zero once both are drained.",
    }))
}

pub fn spawn_worker(state: AppState) {
    if state.near.is_none() {
        tracing::info!("settlement: disabled (CZ_WORLD not set): the economy runs off-chain only");
        return;
    }
    tokio::spawn(async move {
        if let Err(e) = bootstrap(&state).await {
            tracing::error!("settlement bootstrap failed: {e}");
        }
        loop {
            match process_next(&state).await {
                Ok(true) => continue,
                Ok(false) => tokio::time::sleep(std::time::Duration::from_secs(3)).await,
                Err(e) => {
                    tracing::error!("settlement worker: {e}");
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                }
            }
        }
    });
}
