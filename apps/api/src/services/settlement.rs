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
use sqlx::PgConnection;

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
async fn cursor<'e, E: sqlx::PgExecutor<'e>>(db: E, contract: &str) -> Result<i64, sqlx::Error> {
    // One statement, so it can run on a pool or inside a transaction.
    let (c,): (i64,) = sqlx::query_as("INSERT INTO chain_cursor (contract) VALUES ($1) ON CONFLICT (contract) DO UPDATE SET contract = EXCLUDED.contract RETURNING ledger_seq").bind(contract).fetch_one(db).await?;
    Ok(c)
}

async fn set_cursor<'e, E: sqlx::PgExecutor<'e>>(db: E, contract: &str, seq: i64) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE chain_cursor SET ledger_seq = $2, updated_at = now() WHERE contract = $1").bind(contract).bind(seq).execute(db).await?;
    Ok(())
}

pub async fn enqueue<'e, E: sqlx::PgExecutor<'e>>(db: E, near: &NearClient, kind: &str, op_id: &str, tick: u64, payload: &Value) -> Result<bool, sqlx::Error> {
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
pub async fn sync_flows(w: &World, db: &mut PgConnection, near: &NearClient) -> Result<(), sqlx::Error> {
    let contract = near.contract.to_string();
    let cursor = cursor(&mut *db, &contract).await?;
    let to = w.ledger.len();
    if to as i64 <= cursor {
        return Ok(());
    }
    let (mints, burns) = flows_between(w, cursor as usize, to);
    for (i, (m, b)) in batches(near, &mints, &burns).into_iter().enumerate() {
        let batch_id = format!("ledger-{cursor}-{to}-{i}");
        enqueue(&mut *db, near, "flows", &format!("flows:{batch_id}"), w.tick, &json!({ "batch_id": batch_id, "mints": m, "burns": b })).await?;
    }
    set_cursor(&mut *db, &contract, to as i64).await?;
    Ok(())
}

/// Queue an agent's trade with the merchant (after the flows that fund it). A purchase
/// settles as a merchant offer the agent accepts; a sale as a merchant bid it accepts.
pub async fn queue_trade(w: &World, db: &mut PgConnection, near: &NearClient, t: &TradeRecord) -> Result<(), sqlx::Error> {
    let Some(party) = chain_account(near, &t.party) else { return Ok(()) };
    sync_flows(w, &mut *db, near).await?;
    let (kind, base) = match t.side {
        cz_economy::Side::Buy => ("trade", format!("trade-{}", t.id)),
        cz_economy::Side::Sell => ("sell", format!("sale-{}", t.id)),
    };
    let payload = json!({ "trade": t.id, "quote_base": base, "party": party, "token_id": t.resource.name(), "amount": t.qty.to_string(), "total": t.total.to_string() });
    enqueue(&mut *db, near, kind, &base, w.tick, &payload).await.map(|_| ())
}

/// Queue a validated raid's settlement (after the flows that put the cargo there).
pub async fn queue_raid(w: &World, db: &mut PgConnection, near: &NearClient, raid: u64) -> Result<Option<String>, sqlx::Error> {
    let r = &w.raids[&raid];
    let cz_economy::RaidStatus::Extracted { units, bounty } = r.status else { return Ok(None) };
    if units == 0 && bounty == 0 {
        return Ok(None);
    }
    sync_flows(w, &mut *db, near).await?;
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
    enqueue(&mut *db, near, "raid", &op, w.tick, &payload).await?;
    Ok(Some(op))
}

/// Queue a settled sabotage or recovery: every actor-to-actor or actor-to-player leg
/// of the operation (a recovery's cargo going home, the fee from the sponsor's
/// escrow) as one `settle_operation`, after the flows (e.g. a sabotage's burn).
pub async fn queue_operation(w: &World, db: &mut PgConnection, near: &NearClient, raid: u64) -> Result<Option<String>, sqlx::Error> {
    sync_flows(w, &mut *db, near).await?;
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
    enqueue(&mut *db, near, "operation", &op, w.tick, &json!({ "op_id": raid.to_string(), "player": r.player, "legs": legs })).await?;
    Ok(Some(op))
}

/// One-time alignment when the chain already holds state the ledger cursor knows
/// nothing about (a fresh economy against an existing contract): mint or burn the
/// difference per actor, then start the cursor at the current ledger.
pub async fn bootstrap(state: &AppState) -> Result<(), String> {
    // This process holds the single-writer lock (main.rs), so no other worker exists:
    // leases left by an earlier process (a restart or a crash) are released now
    // rather than holding the head of the queue until they expire. The row is
    // re-checked against `is_used` before it is submitted again.
    if let Some(near) = &state.near {
        sqlx::query("UPDATE settlements SET lease_until = NULL WHERE contract = $1 AND status = 'submitted' AND claimed_by IS DISTINCT FROM $2")
            .bind(near.contract.to_string()).bind(&state.worker_id).execute(state.world.db()).await.map_err(|e| e.to_string())?;
    }
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
                    .bind(near.contract.to_string()).execute(&mut *db).await?;
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
                enqueue(&mut *db, &near, "genesis", &format!("flows:{batch_id}"), w.tick, &json!({ "batch_id": batch_id, "mints": m, "burns": b, "note": if force { "realign the chain with the economy" } else { "align the chain with the economy at startup" } })).await?;
                ops.push(format!("flows:{batch_id}"));
            }
            set_cursor(&mut *db, &near.contract.to_string(), w.ledger.len() as i64).await?;
            Ok(json!({ "aligned": true, "batches": ops, "mints": mints.len(), "burns": burns.len() }))
        })
        .await
        .map_err(|e| e.to_string())
}

type Row = (i64, String, String, Value, i32, Option<Value>);

/// How long a claimed row stays ours before another worker may take it over.
pub const LEASE_SECS: f64 = 300.0;
/// A player's quote lives this long on chain (`ttl_secs` in `settle_quote`). After it
/// plus a margin, an attempt whose outcome was unknown can no longer move value.
pub const QUOTE_TTL_SECS: i64 = 900;
const UNKNOWN_SETTLES_AFTER_SECS: i64 = QUOTE_TTL_SECS + 300;
/// A refusal for "insufficient balance" usually means an earlier operation that would
/// fund the account hasn't landed yet (the queue reorders around deferred rows). It
/// becomes a real failure only if it persists this long.
pub const BALANCE_SETTLES_AFTER_SECS: i64 = 1_800;
/// How long a row refused for balance waits before its next try.
const BALANCE_RETRY_SECS: i64 = 45;

/// What one submission attempt is known to have done.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Never reached the network (signing, nonce or block fetch failed).
    NotSent,
    /// Reached the chain and definitively failed (receipt failure, refused, not success).
    Failed,
    /// May or may not have landed: a timeout or lost response after broadcast, or a
    /// transaction we could not fetch at FINAL. Never compensated on its own.
    Unknown,
}

impl Outcome {
    pub fn name(self) -> &'static str {
        match self {
            Outcome::NotSent => "not_sent",
            Outcome::Failed => "failed",
            Outcome::Unknown => "unknown",
        }
    }
}

/// Classify an error from `NearClient::call` / `verify`.
pub fn classify(err: &str) -> Outcome {
    let pre_send = ["Meta-signing error", "Failed to fetch nonce", "Failed to fetch block", "has no signing key", "unknown settlement kind"];
    if err.contains("send failed") && pre_send.iter().any(|p| err.contains(p)) {
        return Outcome::NotSent;
    }
    if err.contains("has no signing key") || err.contains("unknown settlement kind") {
        return Outcome::NotSent;
    }
    let definitive = ["the ledger refused the operation", "a receipt failed", "final status is not success", "failed: Failure", "ActionError", "FunctionCallError", "InvalidTransaction"];
    if definitive.iter().any(|p| err.contains(p)) {
        return Outcome::Failed;
    }
    Outcome::Unknown
}

/// A transaction hash quoted at the start of an error, if any.
fn tx_hash_in(err: &str) -> Option<String> {
    err.split(|c: char| !c.is_ascii_alphanumeric()).find(|w| w.len() >= 43 && w.len() <= 44).map(str::to_string)
}

/// Whether a trade whose settlement keeps failing may be reversed in the economy.
/// Every attempt must be known not to have moved value: never sent, failed on chain,
/// or unknown but older than the quote's lifetime (and `is_used` was false this round).
pub fn may_compensate(attempts: &[Value], now_unix: i64) -> bool {
    // Balance refusals are waits for funding, not verdicts, until they have persisted.
    let first_balance = attempts.iter().filter(|a| a["reason"] == "balance").filter_map(|a| a["at"].as_i64()).min();
    if first_balance.is_some_and(|t| now_unix - t < BALANCE_SETTLES_AFTER_SECS) {
        return false;
    }
    attempts.len() >= 3
        && attempts.iter().all(|a| match a["outcome"].as_str() {
            Some("not_sent") | Some("failed") => true,
            Some("unknown") => a["at"].as_i64().is_some_and(|t| now_unix - t >= UNKNOWN_SETTLES_AFTER_SECS),
            _ => false,
        })
}

/// Atomically claim the next settlement for this contract.
///
/// The queue is strictly ordered: the head row is locked (`FOR UPDATE`), and it is
/// only taken if nobody holds a live lease on it. A second worker blocks on the lock,
/// then sees the lease and backs off, so it never jumps ahead to a later row.
///
/// One exception keeps players from waiting on agent bookkeeping: a batch the ledger
/// refused for its epoch issuance budget is deferred until the epoch resets. While it
/// waits, player raid and operation payouts behind it may settle (they move existing
/// tokens, mint nothing, and the chain checks balances), but agent trades and later
/// flows stay in order behind it.
pub async fn claim(db: &sqlx::PgPool, contract: &str, worker: &str) -> Result<Option<Row>, sqlx::Error> {
    sqlx::query_as(
        "WITH blocked AS (
             SELECT min(id) AS id FROM settlements
             WHERE contract = $1 AND status = 'pending' AND defer_reason = 'issuance_budget' AND next_attempt_at > now()
         ),
         head AS (
             SELECT s.id FROM settlements s, blocked b
             WHERE s.contract = $1 AND s.status IN ('pending', 'submitted')
               AND NOT coalesce(s.defer_reason IN ('issuance_budget', 'balance') AND s.next_attempt_at > now(), false)
               AND (b.id IS NULL OR s.id < b.id OR s.kind IN ('raid', 'operation'))
             ORDER BY (s.kind <> 'genesis'), s.id
             LIMIT 1
             FOR UPDATE OF s
         )
         UPDATE settlements s
         SET status = 'submitted', attempts = s.attempts + 1, claimed_by = $2,
             lease_until = now() + make_interval(secs => $3), defer_reason = NULL, next_attempt_at = NULL
         FROM head
         WHERE s.id = head.id
           AND (s.lease_until IS NULL OR s.lease_until < now() OR s.claimed_by = $2)
         RETURNING s.id, s.kind, s.op_id, s.payload, s.attempts - 1, s.evidence",
    )
    .bind(contract)
    .bind(worker)
    .bind(LEASE_SECS)
    .fetch_optional(db)
    .await
}

/// When the token epoch budgets a batch needs will have room again.
async fn budget_reset(near: &NearClient, payload: &Value) -> Option<chrono::DateTime<chrono::Utc>> {
    let mut tokens: Vec<String> = payload["mints"].as_array()?.iter().filter_map(|m| m["token_id"].as_str().map(str::to_string)).collect();
    tokens.sort();
    tokens.dedup();
    let mut latest: Option<i64> = None;
    for t in tokens {
        let info = near.view_assets("token_info", json!({ "token_id": t })).await.ok()?;
        let started = info["epoch_started_ns"].as_u64()? as i64;
        let reset_ns = started + 86_400 * 1_000_000_000;
        latest = Some(latest.map_or(reset_ns, |l| l.max(reset_ns)));
    }
    latest.map(|ns| chrono::DateTime::from_timestamp_nanos(ns) + chrono::Duration::seconds(30))
}

/// Submit the next settlement. Returns whether there was one.
pub async fn process_next(state: &AppState) -> Result<bool, String> {
    let Some(near) = state.near.clone() else { return Ok(false) };
    let db = state.world.db();
    let Some((id, kind, op_id, payload, attempts, evidence)) = claim(db, &near.contract.to_string(), &state.worker_id).await.map_err(|e| e.to_string())? else {
        return Ok(false);
    };
    let mut history: Vec<Value> = evidence.as_ref().and_then(|e| e["attempts"].as_array().cloned()).unwrap_or_default();

    // Already applied on chain (e.g. a crash after submit, or an earlier attempt whose
    // outcome was unknown)? Ask cz-assets, which marks a controller operation used ONLY
    // when value actually moved. (A cancelled or expired quote is used in the
    // controller but never in cz-assets.)
    let attempt = attempts + 1;
    let ledger_ops: Vec<String> = match kind.as_str() {
        "trade" => (1..=attempt).map(|k| format!("ctl:offer:{}-a{k}", payload["quote_base"].as_str().unwrap_or_default())).collect(),
        "sell" => (1..=attempt).map(|k| format!("ctl:bid:{}-a{k}", payload["quote_base"].as_str().unwrap_or_default())).collect(),
        _ => vec![format!("ctl:{op_id}")],
    };
    let mut already = false;
    let mut checked = true;
    for op in &ledger_ops {
        match near.view_assets("is_used", json!({ "op_id": op })).await.map(|v| v.as_bool()) {
            Ok(Some(true)) => already = true,
            Ok(_) => {}
            Err(_) => checked = false,
        }
    }
    let result: Result<Vec<Verified>, String> = if already {
        Ok(vec![])
    } else if !checked {
        // Can't tell whether an earlier attempt landed: don't submit blind.
        Err("send failed: Failed to fetch nonce (is_used check unavailable; not submitted)".into())
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

    let now = chrono::Utc::now();
    match result {
        Ok(verified) => {
            let hashes: Vec<String> = verified.iter().map(|v| v.tx_hash.clone()).collect();
            history.push(json!({ "n": attempt, "at": now.timestamp(), "outcome": if already { "already_applied" } else { "confirmed" }, "tx": hashes }));
            let evidence = json!({ "already_applied": already, "transactions": verified, "attempts": history });
            sqlx::query("UPDATE settlements SET status = 'confirmed', tx_hashes = $2, evidence = $3, error = NULL, confirmed_at = now(), lease_until = NULL WHERE id = $1 AND claimed_by = $4")
                .bind(id).bind(&hashes).bind(&evidence).bind(&state.worker_id).execute(db).await.map_err(|e| e.to_string())?;
            let tick = state.world.read(|w| w.tick).await;
            let _ = log_event(db, tick, "near", "settlement", &json!({ "op_id": op_id, "kind": kind, "status": "confirmed", "tx_hashes": hashes, "explorer": verified.iter().map(|v| v.explorer.clone()).collect::<Vec<_>>(), "payload": payload })).await;
            tracing::info!("settlement {op_id} confirmed: {hashes:?}");
        }
        Err(e) => {
            let outcome = classify(&e);
            let balance = e.contains("insufficient balance");
            history.push(json!({ "n": attempt, "at": now.timestamp(), "outcome": outcome.name(), "tx": tx_hash_in(&e), "error": e, "reason": if balance { "balance" } else { "" } }));
            tracing::warn!("settlement {op_id} attempt {attempt} {}: {e}", outcome.name());
            // Only an agent trade may give up, and only when every attempt is known not
            // to have moved value. Flows, raids and operations mirror state the economy
            // already committed and are replay-protected on chain, so they retry until
            // they land: a transient outage delays them, never leaves a gap.
            let give_up = (kind == "trade" || kind == "sell") && may_compensate(&history, now.timestamp());
            // The ledger's epoch issuance budget is a known wait, not a fault: defer to
            // the reset instead of retrying every minute.
            // A refusal for insufficient balance waits briefly and lets later rows
            // through: they may be what funds this one. Every operation is replay-
            // protected and additive, so order changes when a step can land, never
            // the final balances.
            let (defer, until) = if e.contains("epoch issuance budget exceeded") {
                (Some("issuance_budget"), budget_reset(&near, &payload).await.or(Some(now + chrono::Duration::minutes(10))))
            } else if balance && !give_up {
                (Some("balance"), Some(now + chrono::Duration::seconds(BALANCE_RETRY_SECS)))
            } else {
                (None, None)
            };
            let status = if give_up { "failed" } else { "pending" };
            sqlx::query("UPDATE settlements SET status = $2, error = $3, evidence = $4, defer_reason = $5, next_attempt_at = $6, lease_until = NULL
                         WHERE id = $1 AND claimed_by = $7 AND status <> 'superseded'")
                .bind(id).bind(status).bind(&e).bind(json!({ "attempts": history })).bind(defer).bind(until).bind(&state.worker_id)
                .execute(db).await.map_err(|e| e.to_string())?;
            if give_up {
                compensate_trade(state, id, &payload).await;
            }
            let tick = state.world.read(|w| w.tick).await;
            let _ = log_event(db, tick, "near", "settlement", &json!({ "op_id": op_id, "kind": kind, "status": status, "outcome": outcome.name(), "deferred_until": until, "error": e })).await;
            if defer.is_none() {
                // Back off before the next attempt (2, 4, 8 … 60 s), so an RPC outage is
                // waited out instead of hammered.
                tokio::time::sleep(std::time::Duration::from_secs(2u64.pow((attempts + 1).clamp(1, 6) as u32).min(60))).await;
            }
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
            let _ = sqlx::query("UPDATE settlements SET status = 'compensated' WHERE id = $1 AND status = 'failed'").bind(id).execute(db).await;
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
    let (engine, ledger_len, unsynced) = state
        .world
        .read(|w| {
            // What the ledger has done since the last flow sync, not yet on chain.
            let (mints, burns) = flows_between(w, cursor as usize, w.ledger.len());
            let mut unsynced: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
            for ((acct, asset), q) in mints { *unsynced.entry(acct).or_default().entry(asset.name().to_string()).or_default() += q; }
            for ((acct, asset), q) in burns { *unsynced.entry(acct).or_default().entry(asset.name().to_string()).or_default() -= q; }
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
            (m, w.ledger.len(), unsynced)
        })
        .await;
    let mut exact = open.is_empty();
    let mut actors = Vec::new();
    let mut in_sync = open.is_empty() && cursor as usize == ledger_len;
    for (acct, eng) in &engine {
        let Some(chain_acct) = chain_account(&near, acct) else { continue };
        let chain = near.balances(&chain_acct).await?;
        let diff: BTreeMap<_, _> = eng.iter().map(|(t, v)| (t.clone(), v - chain.get(t).copied().unwrap_or(0))).filter(|(_, d)| *d != 0).collect();
        in_sync &= diff.is_empty();
        // Net of the ledger entries the next flow sync will carry: with nothing in
        // flight this must be exactly zero, at any moment.
        let pending = unsynced.get(acct).cloned().unwrap_or_default();
        let net: BTreeMap<_, _> = eng.iter().map(|(t, v)| (t.clone(), v - chain.get(t).copied().unwrap_or(0) - pending.get(t).copied().unwrap_or(0))).filter(|(_, d)| *d != 0).collect();
        exact &= net.is_empty();
        actors.push(json!({ "engine_account": acct, "chain_account": chain_acct, "engine": eng, "chain": chain, "difference": diff, "unsynced": pending, "difference_net_of_unsynced": net }));
    }
    Ok(json!({
        "enabled": true,
        "contract": near.contract.to_string(),
        "in_sync": in_sync,
        "exact": exact,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_are_classified_by_what_they_prove() {
        assert_eq!(classify("post_bid: send failed: Meta-signing error: Failed to fetch nonce: QueryError"), Outcome::NotSent);
        assert_eq!(classify("HaSPBjXeLAsX8f5A4nQHJ8Vsa8EPC7DNig3mntRj8Wc9: the ledger refused the operation (callback returned false)"), Outcome::Failed);
        assert_eq!(classify("apply_flows: transaction 5Gj failed: Failure(ActionError(..))"), Outcome::Failed);
        assert_eq!(classify("apply_flows: send failed: TimeoutError"), Outcome::Unknown);
        assert_eq!(classify("apply_flows: transaction still pending"), Outcome::Unknown);
        assert_eq!(classify("{\"code\":-32000}"), Outcome::Unknown);
        assert_eq!(tx_hash_in("HaSPBjXeLAsX8f5A4nQHJ8Vsa8EPC7DNig3mntRj8Wc9: the ledger refused").as_deref(), Some("HaSPBjXeLAsX8f5A4nQHJ8Vsa8EPC7DNig3mntRj8Wc9"));
    }

    #[test]
    fn a_trade_is_compensated_only_when_no_attempt_could_have_moved_value() {
        let a = |o: &str, at: i64| json!({ "outcome": o, "at": at });
        let now = 10_000;
        // Three definitive failures: safe.
        assert!(may_compensate(&[a("not_sent", 1), a("failed", 2), a("failed", 3)], now));
        // Fewer than three attempts: keep trying.
        assert!(!may_compensate(&[a("failed", 1), a("failed", 2)], now));
        // An unknown outcome inside the quote's lifetime: never compensate.
        assert!(!may_compensate(&[a("failed", 1), a("unknown", now - 60), a("failed", 3)], now));
        // An unknown outcome older than the quote's lifetime (+ margin) can no longer land.
        assert!(may_compensate(&[a("failed", 1), a("unknown", now - UNKNOWN_SETTLES_AFTER_SECS), a("failed", 3)], now));
        // A balance refusal is a wait for funding until it has persisted half an hour.
        let b = |at: i64| json!({ "outcome": "failed", "at": at, "reason": "balance" });
        assert!(!may_compensate(&[b(now - 60), b(now - 30), b(now - 10)], now));
        assert!(may_compensate(&[b(now - BALANCE_SETTLES_AFTER_SECS), b(now - 30), b(now - 10)], now));
        // An unrecorded outcome counts as unknown.
        assert!(!may_compensate(&[a("failed", 1), json!({}), a("failed", 3)], now));
    }

    /// Database tests run against the dev database with their own contract id.
    /// Enable with CZ_DB_TESTS=1 (and DATABASE_URL).
    async fn test_db() -> Option<sqlx::PgPool> {
        if std::env::var("CZ_DB_TESTS").as_deref() != Ok("1") {
            return None;
        }
        dotenvy::dotenv().ok();
        let pool = sqlx::PgPool::connect(&std::env::var("DATABASE_URL").ok()?).await.ok()?;
        crate::migrate::run(&pool).await.ok()?;
        Some(pool)
    }

    async fn seed(db: &sqlx::PgPool, contract: &str, rows: &[(&str, &str)]) -> Vec<i64> {
        // Rows a crashed earlier run of this test left behind (never the real contract's).
        let prefix = format!("{}%", &contract[..contract.find('-').map_or(contract.len(), |i| contract[i + 1..].find('-').map_or(contract.len(), |j| i + 1 + j + 1))]);
        sqlx::query("DELETE FROM settlements WHERE contract LIKE $1 AND contract LIKE 'test-%' AND created_at < now() - interval '1 minute'").bind(&prefix).execute(db).await.unwrap();
        let mut ids = vec![];
        for (kind, op) in rows {
            let (id,): (i64,) = sqlx::query_as("INSERT INTO settlements (kind, op_id, tick, payload, contract) VALUES ($1, $2, 0, '{}', $3) RETURNING id")
                .bind(kind).bind(op).bind(contract).fetch_one(db).await.unwrap();
            ids.push(id);
        }
        ids
    }

    #[tokio::test]
    async fn two_workers_never_claim_the_same_row_or_jump_the_queue() {
        let Some(db) = test_db().await else { return };
        let contract = format!("test-claim-{}", uuid::Uuid::new_v4());
        let ids = seed(&db, &contract, &[("flows", "f1"), ("trade", "t2"), ("raid", "r3")]).await;
        let (a, b) = tokio::join!(claim(&db, &contract, "worker-a"), claim(&db, &contract, "worker-b"));
        let got: Vec<i64> = [a.unwrap(), b.unwrap()].into_iter().flatten().map(|r| r.0).collect();
        // Exactly one worker holds the head; the other gets nothing (it doesn't skip ahead).
        assert_eq!(got, vec![ids[0]]);
        // While the lease is live, a second claim gets nothing.
        assert!(claim(&db, &contract, "worker-b").await.unwrap().is_none());
        // A crashed worker's lease expires and the row is reclaimable.
        sqlx::query("UPDATE settlements SET lease_until = now() - interval '1 second' WHERE id = $1").bind(ids[0]).execute(&db).await.unwrap();
        let r = claim(&db, &contract, "worker-b").await.unwrap().unwrap();
        assert_eq!((r.0, r.4), (ids[0], 1)); // attempts counts the earlier claim
        sqlx::query("DELETE FROM settlements WHERE contract = $1").bind(&contract).execute(&db).await.unwrap();
    }

    #[tokio::test]
    async fn an_issuance_deferral_lets_only_player_payouts_pass() {
        let Some(db) = test_db().await else { return };
        let contract = format!("test-defer-{}", uuid::Uuid::new_v4());
        let ids = seed(&db, &contract, &[("flows", "f1"), ("trade", "t2"), ("flows", "f3"), ("raid", "r4"), ("operation", "o5")]).await;
        sqlx::query("UPDATE settlements SET defer_reason = 'issuance_budget', next_attempt_at = now() + interval '1 hour' WHERE id = $1").bind(ids[0]).execute(&db).await.unwrap();
        let first = claim(&db, &contract, "w").await.unwrap().unwrap();
        assert_eq!(first.0, ids[3], "the raid payout settles past the deferred batch");
        sqlx::query("UPDATE settlements SET status = 'confirmed' WHERE id = $1").bind(first.0).execute(&db).await.unwrap();
        assert_eq!(claim(&db, &contract, "w").await.unwrap().unwrap().0, ids[4]);
        sqlx::query("UPDATE settlements SET status = 'confirmed' WHERE id = $1").bind(ids[4]).execute(&db).await.unwrap();
        // The agent trade and later flows wait behind the deferred batch.
        assert!(claim(&db, &contract, "w").await.unwrap().is_none());
        // A row refused for balance blocks nothing: the trade behind it may fund it.
        sqlx::query("UPDATE settlements SET defer_reason = 'balance', next_attempt_at = now() + interval '1 minute' WHERE id = $1").bind(ids[0]).execute(&db).await.unwrap();
        assert_eq!(claim(&db, &contract, "w").await.unwrap().unwrap().0, ids[1], "the trade goes ahead of the balance-deferred batch");
        sqlx::query("UPDATE settlements SET status = 'confirmed' WHERE id = $1").bind(ids[1]).execute(&db).await.unwrap();
        sqlx::query("UPDATE settlements SET defer_reason = 'issuance_budget', next_attempt_at = now() + interval '1 hour' WHERE id = $1").bind(ids[0]).execute(&db).await.unwrap();
        // Once the epoch resets, the batch goes first again.
        sqlx::query("UPDATE settlements SET next_attempt_at = now() - interval '1 second' WHERE id = $1").bind(ids[0]).execute(&db).await.unwrap();
        assert_eq!(claim(&db, &contract, "w").await.unwrap().unwrap().0, ids[0]);
        sqlx::query("DELETE FROM settlements WHERE contract = $1").bind(&contract).execute(&db).await.unwrap();
    }
}
