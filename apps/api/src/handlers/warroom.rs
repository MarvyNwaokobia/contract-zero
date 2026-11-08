//! The War Room: the live strategic picture (factions, routes, contracts, price
//! history) and the causal timeline that explains it, one chain per decision:
//!
//!   trigger → observed state → proposal → validation → transaction → world consequence
//!   → gameplay consequence
//!
//! Every link is read from a record (the decision log, the settlement queue, the
//! ledger events); nothing is inferred except the last link, which is a fixed rule per
//! event type and is labelled as such.

use std::collections::{BTreeMap, HashMap};

use actix_web::{web, HttpResponse};
use cz_economy::{policy, Asset, BountyStatus, ConvoyStatus, Resource, World};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::services::near::explorer_tx;
use crate::AppState;

fn res(w: &World, account: &str) -> Value {
    json!({
        "credits": w.balance(account, Asset::Credits),
        "ammo": w.balance(account, Asset::Res(Resource::Ammo)),
        "med": w.balance(account, Asset::Res(Resource::Med)),
        "fuel": w.balance(account, Asset::Res(Resource::Fuel)),
    })
}

fn snapshot(w: &World) -> Value {
    let actors: Vec<Value> = w.actors.values().map(|a| {
        let memory = w.memory.get(&a.id);
        let mut grudges: Vec<Value> = memory.map(|m| m.players.iter().map(|(p, g)| json!({
            "player": p, "raids": g.raids, "sabotage": g.sabotage, "recoveries": g.recoveries, "units_lost": g.units_lost, "last_tick": g.last_tick,
        })).collect()).unwrap_or_default();
        grudges.sort_by_key(|g| std::cmp::Reverse(g["units_lost"].as_i64().unwrap_or(0)));
        grudges.truncate(5);
        let rivals: Vec<Value> = memory.map(|m| m.sponsors.iter().map(|(s, ticks)| json!({
            "sponsor": s, "sponsor_name": w.actors.get(s).map(|x| x.name.as_str()).unwrap_or(s), "bounties_paid": ticks.len(), "last_tick": ticks.last(),
        })).collect()).unwrap_or_default();
        json!({
            "id": a.id, "name": a.name, "kind": a.kind,
            "holdings": res(w, &a.account),
            "production": { "ammo": a.production[0], "med": a.production[1], "fuel": a.production[2] },
            "requirement": { "ammo": a.requirement(Resource::Ammo), "med": a.requirement(Resource::Med), "fuel": a.requirement(Resource::Fuel) },
            "credit_reserve": a.credit_reserve,
            "income_per_day": a.income_per_day,
            "defense": a.defense,
            "doctrine": a.doctrine,
            "disrupted": Resource::ALL.iter().filter(|r| w.disrupted(&a.id, **r)).map(|r| json!({ "resource": r.name(), "until": a.disrupted_until[*r as usize] })).collect::<Vec<_>>(),
            "recent_raids": w.recent_raids_on(&a.id, policy::RAID_MEMORY_TICKS),
            "grudges": grudges,
            "rivals": rivals,
        })
    }).collect();
    let convoys: Vec<Value> = w.convoys.values().rev().filter(|c| c.status == ConvoyStatus::InTransit || w.tick.saturating_sub(c.arrives_at) < 12).take(12).map(|c| {
        let span = c.arrives_at.saturating_sub(c.dispatched_at).max(1);
        let progress = (w.tick.saturating_sub(c.dispatched_at) as f64 / span as f64).min(1.0);
        json!({
            "id": c.id, "owner": c.owner, "owner_name": w.actors.get(&c.owner).map(|a| a.name.as_str()).unwrap_or(&c.owner),
            "resource": c.resource.name(), "units": c.units, "defense": c.defense,
            "dispatched_at": c.dispatched_at, "arrives_at": c.arrives_at, "progress": progress, "status": c.status,
        })
    }).collect();
    let contracts: Vec<Value> = w.open_bounties().map(|b| json!({
        "id": b.id, "kind": b.kind.name(), "sponsor": b.sponsor, "sponsor_name": w.actors[&b.sponsor].name,
        "target": b.target, "target_name": w.actors[&b.target].name, "resource": b.resource.name(), "amount": b.amount, "expires_at": b.expires_at,
    })).collect();
    let paid = w.bounties.values().filter(|b| matches!(b.status, BountyStatus::Paid { .. })).count();
    let prices: Vec<Value> = Resource::ALL.iter().map(|r| { let p = w.price(*r); json!({ "resource": r.name(), "ask": p.ask, "bid": p.bid, "mid": p.mid, "stock": w.merchant_stock(*r), "target": w.market.target[*r as usize] }) }).collect();
    json!({
        "tick": w.tick, "day": w.tick / cz_economy::TICKS_PER_DAY, "hour": w.tick % cz_economy::TICKS_PER_DAY,
        "actors": actors, "convoys": convoys, "contracts": contracts, "contracts_paid": paid, "prices": prices,
        "merchant_insolvent": w.merchant_insolvent(),
    })
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    pub hours: Option<i64>,
}

/// GET /warroom: the strategic picture, the last `hours` of price and holdings
/// history, recent faction broadcasts and the settlement queue's health.
pub async fn overview(state: web::Data<AppState>, q: web::Query<HistoryQuery>) -> HttpResponse {
    let snap = state.world.read(snapshot).await;
    let db = state.world.db();
    let hours = q.hours.unwrap_or(96).clamp(6, 24 * 14);
    let history: Vec<(i64, Value, Value)> = sqlx::query_as("SELECT tick, prices, holdings FROM (SELECT tick, prices, holdings FROM market_history ORDER BY tick DESC LIMIT $1) h ORDER BY tick")
        .bind(hours).fetch_all(db).await.unwrap_or_default();
    let broadcasts: Vec<(i64, String, Value)> = sqlx::query_as("SELECT tick, source, payload FROM world_events WHERE kind = 'faction_broadcast' ORDER BY seq DESC LIMIT 12")
        .fetch_all(db).await.unwrap_or_default();
    let queue: Vec<(String, i64)> = sqlx::query_as("SELECT status, count(*) FROM settlements GROUP BY status").fetch_all(db).await.unwrap_or_default();
    let calls: Vec<(i64, Value)> = sqlx::query_as("SELECT tick, payload FROM world_events WHERE kind = 'planner_call' ORDER BY seq DESC LIMIT 1").fetch_all(db).await.unwrap_or_default();
    HttpResponse::Ok().json(json!({
        "world": snap,
        "history": history.into_iter().map(|(t, p, h)| json!({ "tick": t, "prices": p, "holdings": h })).collect::<Vec<_>>(),
        "broadcasts": broadcasts.into_iter().map(|(t, s, p)| json!({ "tick": t, "actor": s, "text": p["text"], "model": p["model"] })).collect::<Vec<_>>(),
        "settlement": queue.into_iter().collect::<BTreeMap<_, _>>(),
        "planner": {
            "configured": std::env::var("NEAR_AI_API_KEY").map(|k| !k.trim().is_empty()).unwrap_or(false),
            "last_call": calls.first().map(|(t, p)| json!({ "tick": t, "model": p["model"], "ok": p["ok"], "latency_ms": p["latency_ms"] })),
        },
    }))
}

#[derive(Deserialize)]
pub struct TimelineQuery {
    pub limit: Option<i64>,
    /// Include decisions where the agent chose to do nothing.
    pub quiet: Option<bool>,
}

/// One sentence for a ledger event, using actor names.
fn describe(e: &Value, name: &dyn Fn(&str) -> String) -> Option<String> {
    let s = |k: &str| e[k].as_str().unwrap_or("").to_string();
    let n = |k: &str| e[k].as_i64().unwrap_or(0);
    Some(match e["event"].as_str()? {
        "traded" => {
            let who = name(s("party").trim_start_matches("faction:").trim_start_matches("merchant:"));
            if s("side") == "buy" { format!("{who} bought {} {} from Vex for {} cr", n("qty"), s("resource"), n("total")) } else { format!("{who} sold {} {} to Vex for {} cr", n("qty"), s("resource"), n("total")) }
        }
        "defense_changed" => format!("{} set depot defense to level {}", name(&s("actor")), n("level")),
        "bounty_posted" => format!("{} escrowed a {} cr bounty on {}'s {}", name(&s("sponsor")), n("amount"), name(&s("target")), s("resource")),
        "contract_posted" => format!("{} escrowed a {} cr {} contract against {}'s {}", name(&s("sponsor")), n("amount"), s("kind"), name(&s("target")), s("resource")),
        "convoy_seized" => format!("{} seized caravan #{} ({} {})", name(&s("by")), n("convoy"), n("units"), s("resource")),
        "production_disrupted" => format!("{}'s {} line is down until tick {}", name(&s("actor")), s("resource"), n("until")),
        "raid_extracted" => format!("Operation #{} paid out: {} units moved, {} cr fee", n("raid"), n("units"), n("bounty")),
        "raid_failed" => format!("Operation #{} failed", n("raid")),
        "raid_started" => format!("Operation #{} started against {}'s {}", n("raid"), name(&s("target")), s("resource")),
        "shipment_dispatched" => format!("{} dispatched a caravan of {} {}", name(&s("owner")), n("units"), s("resource")),
        "strategy_changed" => format!("Vex changed pricing strategy to {}", e["strategy"].as_str().unwrap_or("?")),
        _ => return None,
    })
}

/// What the player will notice. A fixed rule per event type, not a model's guess.
fn gameplay(e: &Value, name: &dyn Fn(&str) -> String) -> Option<String> {
    let s = |k: &str| e[k].as_str().unwrap_or("").to_string();
    let n = |k: &str| e[k].as_i64().unwrap_or(0);
    Some(match e["event"].as_str()? {
        "traded" => {
            let party = s("party");
            let who = name(party.trim_start_matches("faction:").trim_start_matches("merchant:"));
            if s("side") == "buy" { format!("{who}'s depot holds more {}: a bigger haul on the Contracts board, and Vex's {} ask rises", s("resource"), s("resource")) } else { format!("Vex's {} shelf refills, so its ask eases on the Exchange", s("resource")) }
        }
        "defense_changed" => format!("The next raid on {} faces a level-{} guard", name(&s("actor")), n("level")),
        "bounty_posted" => format!("A raid contract on {}'s {} appears on the board, paying {} cr", name(&s("target")), s("resource"), n("amount")),
        "contract_posted" => format!("A {} contract appears on the Contracts board, paying {} cr", s("kind"), n("amount")),
        "convoy_seized" => "Vex is short on that shelf; a recovery contract is likely to follow".to_string(),
        "production_disrupted" => format!("{}'s {} stock stops growing: smaller hauls until tick {}", name(&s("actor")), s("resource"), n("until")),
        "raid_extracted" => format!("The player is paid {} cr; the target remembers the operation and hardens", n("bounty")),
        "raid_failed" => "The cargo stays put; the depot stays on the board".to_string(),
        _ => return None,
    })
}

/// The chain record for one action: a settlement row by op id, or the reason none exists.
fn transaction(e: &Value, rows: &HashMap<String, Value>) -> Value {
    let op = match e["event"].as_str() {
        Some("traded") => Some(if e["side"] == "buy" { format!("trade-{}", e["id"]) } else { format!("sale-{}", e["id"]) }),
        _ => None,
    };
    if let Some(op) = op {
        return rows.get(&op).cloned().unwrap_or_else(|| json!({ "op_id": op, "status": "not_queued", "note": "No chain account for this party; recorded in the game ledger only." }));
    }
    let note = match e["event"].as_str() {
        Some("defense_changed") => "No assets move: posture is game state. Its upkeep settles in a later ledger batch.",
        Some("bounty_posted" | "contract_posted") => "Escrowed in game state. NEAR moves the credits only when an operation completes (settle_raid / settle_operation).",
        Some("convoy_seized") => "The seized cargo is minted to the faction in the next ledger batch.",
        _ => "Game state only.",
    };
    json!({ "status": "off_chain", "note": note })
}

fn settlement_json(op: &str, kind: &str, status: &str, hashes: &[String], error: &Option<String>) -> Value {
    json!({
        "op_id": op, "kind": kind, "status": status,
        // Only confirmed is on-chain settlement; pending/submitted are in flight.
        "settled_on_chain": status == "confirmed",
        "tx_hashes": hashes, "explorer": hashes.iter().map(|h| explorer_tx(h)).collect::<Vec<_>>(), "error": error,
    })
}

/// GET /warroom/timeline: one causal chain per agent decision or player operation,
/// newest first.
pub async fn timeline(state: web::Data<AppState>, q: web::Query<TimelineQuery>) -> HttpResponse {
    let limit = q.limit.unwrap_or(40).clamp(1, 200);
    let db = state.world.db();
    let rows: Vec<(i64, i64, String, String, Value)> = match sqlx::query_as(
        "SELECT seq, tick, source, kind, payload FROM world_events
         WHERE (kind = 'agent_decision' AND ($2 OR payload->>'validation' <> 'no_action' OR payload->>'planner' LIKE 'llm:%'))
            OR (kind = 'mission' AND payload->>'phase' = 'complete')
         ORDER BY seq DESC LIMIT $1",
    ).bind(limit).bind(q.quiet.unwrap_or(false)).fetch_all(db).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("timeline query failed: {e}");
            return HttpResponse::InternalServerError().json(json!({ "error": "could not read the timeline" }));
        }
    };

    // Every op id these chains could have produced, fetched in one query.
    let mut ops = Vec::new();
    for (_, _, _, kind, p) in &rows {
        if kind == "mission" {
            if let Some(op) = p["result"]["settlement"]["op_id"].as_str() { ops.push(op.to_string()); }
        }
        for e in p["events"].as_array().into_iter().flatten() {
            if e["event"] == "traded" {
                ops.push(if e["side"] == "buy" { format!("trade-{}", e["id"]) } else { format!("sale-{}", e["id"]) });
            }
        }
    }
    let settled: Vec<(String, String, String, Vec<String>, Option<String>)> = sqlx::query_as("SELECT op_id, kind, status, tx_hashes, error FROM settlements WHERE op_id = ANY($1)")
        .bind(&ops).fetch_all(db).await.unwrap_or_default();
    let by_op: HashMap<String, Value> = settled.iter().map(|(op, k, s, h, e)| (op.clone(), settlement_json(op, k, s, h, e))).collect();

    // Players by callsign, not account id.
    let players: Vec<String> = rows.iter().filter(|r| r.3 == "mission").map(|r| r.2.trim_start_matches("player:").to_string()).collect();
    let callsigns: HashMap<String, String> = sqlx::query_as::<_, (String, String)>("SELECT account, callsign FROM player_profiles WHERE account = ANY($1)")
        .bind(&players).fetch_all(db).await.unwrap_or_default().into_iter().collect();
    let names: HashMap<String, String> = state.world.read(|w| w.actors.values().map(|a| (a.id.clone(), a.name.clone())).collect()).await;
    let name = |id: &str| names.get(id).cloned().unwrap_or_else(|| id.to_string());

    let chains: Vec<Value> = rows.into_iter().map(|(seq, tick, source, kind, p)| {
        if kind == "mission" {
            let r = &p["result"];
            let events: Vec<&Value> = r["events"].as_array().map(|v| v.iter().collect()).unwrap_or_default();
            let op = r["settlement"]["op_id"].as_str().unwrap_or("");
            return json!({
                "seq": seq, "tick": tick, "kind": "operation", "actor": source, "actor_name": callsigns.get(source.trim_start_matches("player:")).cloned().unwrap_or_else(|| source.trim_start_matches("player:").to_string()),
                "trigger": format!("{} contract on {}'s {}", r["kind"].as_str().unwrap_or("raid"), name(r["target"].as_str().unwrap_or("")), r["resource"].as_str().unwrap_or("")),
                "observed": [["outcome", r["outcome"]], ["elapsed_secs", r["elapsed_secs"]], ["min_secs", r["min_secs"]]],
                "proposal": { "planner": "player", "summary": format!("Run the {} in the field", r["kind"].as_str().unwrap_or("raid")), "rationale": Value::Null },
                "validation": { "status": if r["outcome"] == "extracted" { "accepted" } else { "rejected" }, "by": "server (session, timing, plan)", "error": r["reason"] },
                "transaction": by_op.get(op).cloned().unwrap_or_else(|| json!({ "op_id": op, "status": if op.is_empty() { "off_chain" } else { "not_queued" } })),
                "world": events.iter().filter_map(|e| describe(e, &name)).collect::<Vec<_>>(),
                "gameplay": events.iter().filter_map(|e| gameplay(e, &name)).collect::<Vec<_>>(),
            });
        }
        let events: Vec<&Value> = p["events"].as_array().map(|v| v.iter().collect()).unwrap_or_default();
        let planner = p["planner"].as_str().unwrap_or("fallback");
        let action = if p["action"].is_null() { &p["proposed"] } else { &p["action"] };
        json!({
            "seq": seq, "tick": tick, "kind": "decision", "actor": source, "actor_name": name(&source),
            "trigger": p["trigger"],
            "observed": p["context"],
            "proposal": {
                "planner": planner,
                "source": if planner.starts_with("llm:") { "NEAR AI strategic planner" } else { "deterministic policy" },
                "action": action,
                "rationale": p["rationale"],
            },
            "validation": { "status": p["validation"], "error": p["error"], "by": if planner.starts_with("llm:") { "policy check, then the economy engine" } else { "the economy engine" } },
            "transactions": events.iter().map(|e| transaction(e, &by_op)).collect::<Vec<_>>(),
            "world": events.iter().filter_map(|e| describe(e, &name)).collect::<Vec<_>>(),
            "gameplay": events.iter().filter_map(|e| gameplay(e, &name)).collect::<Vec<_>>(),
        })
    }).collect();
    HttpResponse::Ok().json(json!({ "chains": chains, "gameplay_rule": "The gameplay line is a fixed rule per event type, not model output." }))
}
