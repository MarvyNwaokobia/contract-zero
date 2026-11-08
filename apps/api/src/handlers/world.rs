//! Read endpoints over the live world: the War Room view, the raid board, the event
//! feed, and Observer Mode (a simulation on a copy of the world).

use actix_web::{web, HttpResponse};
use cz_economy::mission::{self, RaidPlan};
use cz_economy::{policy, Asset, Event, RaidStatus, Resource, World, TICKS_PER_DAY};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::AppState;

/// Time of day drives the mission's look: day, evening, then night with NVG.
pub fn zone_for_tick(tick: u64) -> &'static str {
    match tick % TICKS_PER_DAY {
        6..=16 => "DUSTLINE",
        17..=20 => "REDYARD",
        _ => "BLACKSITE",
    }
}

fn holdings(w: &World, account: &str) -> Value {
    json!({
        "credits": w.balance(account, Asset::Credits),
        "ammo": w.balance(account, Asset::Res(Resource::Ammo)),
        "med": w.balance(account, Asset::Res(Resource::Med)),
        "fuel": w.balance(account, Asset::Res(Resource::Fuel)),
    })
}

/// The mission the client builds for a raid plan. `raid_id` is set once started.
pub fn mission_json(w: &World, plan: &RaidPlan, raid_id: Option<u64>) -> Value {
    let bounty = w.bounty_for(&plan.target, plan.resource);
    json!({
        "id": raid_id.map(|r| r.to_string()).unwrap_or_else(|| format!("{}-{}-{}", plan.target, plan.resource.name(), w.tick)),
        "target": w.actors[&plan.target].name,
        "issuer": bounty.map(|b| w.actors[&b.sponsor].name.clone()),
        "cargo": { "resource": plan.resource.name(), "units": plan.manifest },
        "defense": plan.defense,
        "seed": plan.seed,
        "zone": zone_for_tick(w.tick),
        "guards": plan.guards,
    })
}

/// One board entry: a raidable depot, why it looks the way it does, and its bounty.
pub fn board_entry(w: &World, plan: &RaidPlan) -> Value {
    let a = &w.actors[&plan.target];
    let bounty = w.bounty_for(&plan.target, plan.resource);
    json!({
        "target": plan.target, "target_name": a.name,
        "resource": plan.resource.name(),
        "manifest": plan.manifest,
        "defense": plan.defense,
        "guards": plan.guards,
        "bounty": bounty.map(|b| json!({ "id": b.id, "sponsor": b.sponsor, "sponsor_name": w.actors[&b.sponsor].name, "amount": b.amount, "expires_at": b.expires_at })),
        "market_value": { "bid": w.price(plan.resource).bid * plan.manifest, "unit_bid": w.price(plan.resource).bid },
        "mission": mission_json(w, plan, None),
    })
}

pub fn world_view(w: &World) -> Value {
    let actors: Vec<Value> = w.actors.values().map(|a| json!({
        "id": a.id, "name": a.name, "kind": a.kind, "account": a.account,
        "holdings": holdings(w, &a.account),
        "requirement": { "ammo": a.requirement(Resource::Ammo), "med": a.requirement(Resource::Med), "fuel": a.requirement(Resource::Fuel) },
        "ammo_target": if a.kind == cz_economy::ActorKind::Faction { policy::ammo_target(a) } else { 0 },
        "credit_reserve": a.credit_reserve,
        "defense": a.defense,
        "recent_raids": w.recent_raids_on(&a.id, policy::RAID_MEMORY_TICKS),
    })).collect();
    let prices: Vec<Value> = Resource::ALL.iter().map(|r| json!({ "resource": r.name(), "price": w.price(*r), "stock": w.merchant_stock(*r) })).collect();
    let shipments: Vec<_> = w.convoys.values().rev().take(10).collect();
    let bounties: Vec<_> = w.open_bounties().collect();
    let raids: Vec<_> = w.raids.values().rev().take(10).collect();
    let trades: Vec<_> = w.trades.iter().rev().take(20).collect();
    let mut flows = serde_json::Map::new();
    for asset in [Asset::Credits, Asset::Res(Resource::Ammo), Asset::Res(Resource::Med), Asset::Res(Resource::Fuel)] {
        let key = match asset { Asset::Credits => "credits", Asset::Res(r) => r.name() };
        flows.insert(key.into(), json!({ "issued": w.issued(asset), "destroyed": w.destroyed(asset), "conserved": w.total(asset) == 0 }));
    }
    json!({
        "tick": w.tick, "day": w.tick / TICKS_PER_DAY, "hour": w.tick % TICKS_PER_DAY, "version": w.version,
        "zone": zone_for_tick(w.tick),
        "actors": actors,
        "market": { "merchant": w.market.merchant, "target": w.market.target, "strategy": w.market.strategy, "insolvent": w.merchant_insolvent() },
        "prices": prices,
        "shipments": shipments, "bounties": bounties, "raids": raids, "recent_trades": trades,
        "flows": flows,
        "board": mission::available_raids(w).iter().map(|p| board_entry(w, p)).collect::<Vec<_>>(),
    })
}

pub async fn get_world(state: web::Data<AppState>) -> HttpResponse {
    HttpResponse::Ok().json(state.world.read(world_view).await)
}

pub async fn get_board(state: web::Data<AppState>) -> HttpResponse {
    let board = state.world.read(|w| mission::available_raids(w).iter().map(|p| board_entry(w, p)).collect::<Vec<_>>()).await;
    HttpResponse::Ok().json(json!({ "board": board }))
}

pub async fn get_player(state: web::Data<AppState>, path: web::Path<String>) -> HttpResponse {
    let player = path.into_inner();
    if !crate::handlers::missions::valid_account_id(&player) {
        return HttpResponse::BadRequest().json(json!({ "error": "invalid account id" }));
    }
    let view = state
        .world
        .read(|w| {
            let acct = cz_economy::player_account(&player);
            let raids: Vec<_> = w.raids.values().rev().filter(|r| r.player == player).take(10).collect();
            let active = w.active_raid_of(&player).map(|r| r.id);
            json!({ "player": player, "holdings": holdings(w, &acct), "active_raid": active, "raids": raids })
        })
        .await;
    HttpResponse::Ok().json(view)
}

#[derive(Deserialize)]
pub struct EventsQuery {
    pub since: Option<i64>,
    pub kind: Option<String>,
    pub limit: Option<i64>,
}

pub async fn get_events(state: web::Data<AppState>, q: web::Query<EventsQuery>) -> HttpResponse {
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let rows: Result<Vec<(i64, i64, String, String, Value)>, _> = sqlx::query_as(
        "SELECT seq, tick, source, kind, payload FROM world_events
         WHERE seq > $1 AND ($2::text IS NULL OR kind = $2)
         ORDER BY seq DESC LIMIT $3",
    )
    .bind(q.since.unwrap_or(0))
    .bind(q.kind.as_deref())
    .bind(limit)
    .fetch_all(state.world.db())
    .await;
    match rows {
        Ok(rows) => HttpResponse::Ok().json(json!({
            "events": rows.into_iter().map(|(seq, tick, source, kind, payload)| json!({
                "seq": seq, "tick": tick, "source": source, "kind": kind, "payload": payload,
            })).collect::<Vec<_>>()
        })),
        Err(e) => {
            tracing::error!("events query failed: {e}");
            HttpResponse::InternalServerError().json(json!({ "error": "could not read events" }))
        }
    }
}

#[derive(Deserialize)]
pub struct SimulateRequest {
    /// In-game hours to simulate (max two weeks).
    pub ticks: u64,
    /// Simulate from a fresh seeded genesis instead of a copy of the live world.
    pub seed: Option<u64>,
    /// Probability (percent) that a simulated raider hits a depot each tick.
    pub raid_chance_pct: Option<u64>,
}

/// Observer Mode: run the economy forward on a COPY of the world (or a fresh seeded
/// genesis) with the deterministic agents and simulated raiders. Nothing here touches
/// the live world, the database or NEAR; every result is labelled simulated.
pub async fn simulate(state: web::Data<AppState>, body: web::Json<SimulateRequest>) -> HttpResponse {
    let ticks = body.ticks.min(14 * TICKS_PER_DAY);
    let mut w = match body.seed {
        Some(seed) => cz_economy::genesis(seed),
        None => state.world.read(|w| w.clone()).await,
    };
    let raid_pct = body.raid_chance_pct.unwrap_or(8).min(100);
    let mut rng = w.seed ^ 0x51u64;
    let mut series = Vec::new();
    let mut decisions = Vec::new();
    let raider = "simulated-raider";
    for _ in 0..ticks {
        let ev = w.tick();
        let shortages = ev.iter().filter(|e| matches!(e, Event::Shortage { .. })).count();
        if w.tick % 3 == 0 {
            for (d, r) in policy::run_fallback_agents(&mut w) {
                let validation = match &r { None => "no_action".to_string(), Some(Ok(_)) => "accepted".into(), Some(Err(e)) => format!("rejected: {e}") };
                decisions.push(json!({ "tick": w.tick, "actor": d.actor, "trigger": d.trigger, "action": d.action, "rationale": d.rationale, "validation": validation }));
            }
        }
        rng = cz_economy::splitmix(rng);
        if rng % 100 < raid_pct {
            let plans = mission::available_raids(&w);
            if !plans.is_empty() {
                let p = &plans[(rng >> 20) as usize % plans.len()];
                let caller = cz_economy::Caller::Player(raider.into());
                if w.execute(&caller, &cz_economy::Action::StartRaid { target: p.target.clone(), resource: p.resource }).is_ok() {
                    let id = *w.raids.keys().last().unwrap();
                    let won = (rng >> 40) % 3 != 0;
                    let act = if won { cz_economy::Action::SettleRaid { raid: id, player: raider.into() } } else { cz_economy::Action::FailRaid { raid: id, player: raider.into() } };
                    let _ = w.execute(&cz_economy::Caller::System, &act);
                }
            }
        }
        let vg = &w.actors["vanguard"];
        series.push(json!({
            "tick": w.tick,
            "vanguard": holdings(&w, &vg.account),
            "vanguard_defense": vg.defense,
            "merchant": holdings(&w, &w.merchant().account),
            "prices": Resource::ALL.iter().map(|r| (r.name(), w.price(*r).mid)).collect::<std::collections::BTreeMap<_, _>>(),
            "guards_next_raid": mission::raid_plan(&w, "vanguard", Resource::Ammo).map(|p| p.guards.deployed()),
            "shortages": shortages,
        }));
    }
    let raids: Vec<_> = w.raids.values().filter(|r| r.player == raider).map(|r| json!({ "id": r.id, "resource": r.plan.resource.name(), "manifest": r.plan.manifest, "extracted": matches!(r.status, RaidStatus::Extracted { .. }) })).collect();
    let all_assets = [Asset::Credits, Asset::Res(Resource::Ammo), Asset::Res(Resource::Med), Asset::Res(Resource::Fuel)];
    let conserved = all_assets.iter().all(|a| w.total(*a) == 0);
    HttpResponse::Ok().json(json!({
        "simulated": true,
        "note": "Observer Mode: a copy of the economy run forward with deterministic agents and simulated raiders. Nothing here is live or settled on NEAR.",
        "from_seed": body.seed, "ticks": ticks,
        "series": series, "decisions": decisions, "simulated_raids": raids,
        "conserved": conserved,
    }))
}
