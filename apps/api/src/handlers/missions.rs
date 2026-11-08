//! Mission sessions: the only path from a fight to the economy.
//!
//! `POST /missions/start` locks in a raid plan from the live economy and issues a
//! single-use session. `POST /missions/{id}/complete` reports the outcome; the server
//! measures the elapsed time itself, checks it against what the mission physically
//! takes, and only then settles the raid (cargo to the player) or fails it.
//! Completing twice returns the stored result: a replay can never settle twice.
//!
//! Identity: the player is the account of the signed-in session (see
//! `handlers::auth`). A `player` in the body is optional and must match it.

use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{DateTime, Utc};
use cz_economy::mission::load_seconds;
use cz_economy::{Action, Caller, Event, RaidStatus, Resource};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::services::story;
use crate::services::world::{log_event, summarize, WorldError};
use crate::AppState;

/// Time to walk the compound in and back out, on top of loading the cargo.
pub const MIN_TRAVERSAL_SECS: f64 = 25.0;
/// A session older than this can no longer be completed.
pub const SESSION_TTL_SECS: i64 = 30 * 60;
/// Slack for reinforcements beyond the planned guards when capping reported kills.
const KILL_SLACK: i64 = 40;

/// NEAR account id: 2–64 chars of `a-z 0-9 _ - .`, no leading/trailing or doubled
/// separators, or a 64-char implicit (hex) account.
pub fn valid_account_id(id: &str) -> bool {
    let len_ok = (2..=64).contains(&id.len());
    let chars_ok = id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-' | b'.'));
    let sep = |b: u8| matches!(b, b'_' | b'-' | b'.');
    let bytes = id.as_bytes();
    let edges_ok = !bytes.is_empty() && !sep(bytes[0]) && !sep(bytes[bytes.len() - 1]);
    let doubled = bytes.windows(2).any(|p| sep(p[0]) && sep(p[1]));
    len_ok && chars_ok && edges_ok && !doubled
}

/// Pure plausibility check of a reported extraction against server-measured time.
pub fn validate_extraction(elapsed_secs: f64, min_secs: f64, kills: i64, max_kills: i64) -> Result<(), &'static str> {
    if elapsed_secs > SESSION_TTL_SECS as f64 {
        return Err("session expired");
    }
    if elapsed_secs + 1.0 < min_secs {
        return Err("extracted faster than the mission physically takes");
    }
    if kills < 0 || kills > max_kills {
        return Err("kill count implausible");
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct StartRequest {
    #[serde(default)]
    pub player: String,
    pub target: String,
    pub resource: Resource,
    /// raid (default), sabotage or recovery.
    #[serde(default)]
    pub kind: cz_economy::OpKind,
}

/// Seconds to plant one sabotage charge (two per op).
pub const PLANT_SECS: f64 = 5.0;

pub async fn start(state: web::Data<AppState>, req: HttpRequest, body: web::Json<StartRequest>) -> HttpResponse {
    let ip = req.connection_info().realip_remote_addr().unwrap_or("unknown").to_string();
    if !state.mission_limiter.check(&ip) {
        return HttpResponse::TooManyRequests().json(json!({ "error": "too many deployments, slow down" }));
    }
    let who = match crate::handlers::auth::player(&state, &req).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    if let Err(r) = crate::handlers::auth::same_player(&who, &body.player) {
        return r;
    }
    let mut body = body.into_inner();
    body.player = who.account;
    let session = Uuid::new_v4();
    let res = state
        .world
        .transact(async move |w, db| {
            let action = match body.kind {
                cz_economy::OpKind::Raid => Action::StartRaid { target: body.target.clone(), resource: body.resource },
                kind => Action::StartOperation { kind, target: body.target.clone(), resource: body.resource },
            };
            let ev = w.execute(&Caller::Player(body.player.clone()), &action)?;
            let raid = *w.raids.keys().last().expect("raid just created");
            let plan = w.raids[&raid].plan.clone();
            // What the op physically takes: loading cargo, or planting two charges.
            let min_secs = match plan.kind {
                cz_economy::OpKind::Sabotage => 2.0 * PLANT_SECS + MIN_TRAVERSAL_SECS,
                _ => load_seconds(plan.manifest) as f64 + MIN_TRAVERSAL_SECS,
            };
            let mut facts = story::facts(w, &plan, &body.player);
            facts.callsign = sqlx::query_scalar("SELECT callsign FROM player_profiles WHERE account = $1").bind(&body.player).fetch_optional(db).await?;
            if let Some(sponsor) = &facts.sponsor {
                // The sponsor's own logged reason for posting this contract.
                facts.sponsor_reason = sqlx::query_scalar(
                    "SELECT payload->>'rationale' FROM world_events
                     WHERE kind = 'agent_decision' AND source = $1 AND payload->>'validation' = 'accepted'
                       AND payload->'action'->>'target' = $2 AND payload->'action'->>'resource' = $3
                       AND payload->'action'->>'action' IN ('post_bounty', 'post_contract')
                     ORDER BY seq DESC LIMIT 1",
                ).bind(sponsor).bind(&plan.target).bind(plan.resource.name()).fetch_optional(db).await?.flatten();
            }
            let tale = story::authored(&facts);
            sqlx::query(
                "INSERT INTO mission_sessions (id, player, raid_id, min_secs, expires_at, story)
                 VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5), $6)",
            )
            .bind(session)
            .bind(&body.player)
            .bind(raid as i64)
            .bind(min_secs)
            .bind(SESSION_TTL_SECS as f64)
            .bind(json!({ "facts": facts, "story": tale, "voiced": false }))
            .execute(db)
            .await?;
            log_event(db, w.tick, &format!("player:{}", body.player), "mission", &json!({ "phase": "start", "session": session, "raid": raid, "plan": plan, "events": summarize(&ev) })).await?;
            Ok(json!({ "session": session, "raid": raid, "min_secs": min_secs, "mission": crate::handlers::world::mission_json(w, &plan, Some(raid)), "story": tale }))
        })
        .await;
    respond(res)
}

#[derive(Deserialize)]
pub struct CompleteRequest {
    #[serde(default)]
    pub player: String,
    pub outcome: Outcome,
    #[serde(default)]
    pub kills: i64,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Extracted,
    Killed,
}

type SessionRow = (String, i64, f64, DateTime<Utc>, Option<DateTime<Utc>>, Option<Value>);

pub async fn complete(state: web::Data<AppState>, req: HttpRequest, path: web::Path<Uuid>, body: web::Json<CompleteRequest>) -> HttpResponse {
    let who = match crate::handlers::auth::player(&state, &req).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    if let Err(r) = crate::handlers::auth::same_player(&who, &body.player) {
        return r;
    }
    let session = path.into_inner();
    let mut body = body.into_inner();
    body.player = who.account;
    let near = state.world.near();
    let res = state
        .world
        .transact(async move |w, db| {
            let row: Option<SessionRow> = sqlx::query_as(
                "SELECT player, raid_id, min_secs, started_at, completed_at, result FROM mission_sessions WHERE id = $1",
            )
            .bind(session)
            .fetch_optional(db)
            .await?;
            let Some((player, raid_id, min_secs, started_at, completed_at, stored)) = row else {
                return Err(WorldError::Other("unknown session".into()));
            };
            if player != body.player {
                return Err(WorldError::Other("session belongs to another player".into()));
            }
            // Idempotent: a repeated completion returns what the first one decided.
            if completed_at.is_some() {
                return Ok(json!({ "replayed": true, "result": stored }));
            }
            let raid = raid_id as u64;
            let plan = w.raids.get(&raid).map(|r| r.plan.clone()).ok_or_else(|| WorldError::Other("raid not found".into()))?;
            let elapsed = (Utc::now() - started_at).num_milliseconds() as f64 / 1000.0;
            let max_kills = plan.guards.deployed() + KILL_SLACK;

            let (outcome, verdict, ev) = match body.outcome {
                Outcome::Extracted => match validate_extraction(elapsed, min_secs, body.kills, max_kills) {
                    Ok(()) => ("extracted", None, w.execute(&Caller::System, &Action::SettleRaid { raid, player: player.clone() })?),
                    Err(why) => ("rejected", Some(why), w.execute(&Caller::System, &Action::FailRaid { raid, player: player.clone() })?),
                },
                Outcome::Killed => ("killed", None, w.execute(&Caller::System, &Action::FailRaid { raid, player: player.clone() })?),
            };
            let (units, bounty) = match &w.raids[&raid].status {
                RaidStatus::Extracted { units, bounty } => (*units, *bounty),
                _ => (0, 0),
            };
            // On-chain settlement is queued here and confirmed later by the worker; the
            // response says "queued", never "settled".
            let settlement = match (&near, outcome) {
                (Some(n), "extracted") => match plan.kind {
                    cz_economy::OpKind::Raid => crate::services::settlement::queue_raid(w, db, n, raid).await?,
                    _ => crate::services::settlement::queue_operation(w, db, n, raid).await?,
                }
                .map(|op| json!({ "op_id": op, "status": "queued" })),
                _ => None,
            };
            let result = json!({
                "outcome": outcome,
                "reason": verdict,
                "elapsed_secs": elapsed,
                "min_secs": min_secs,
                "raid": raid,
                "kind": plan.kind.name(),
                "target": plan.target,
                "resource": plan.resource.name(),
                "extracted_units": units,
                "bounty": bounty,
                "player_holdings": {
                    "credits": w.balance(&cz_economy::player_account(&player), cz_economy::Asset::Credits),
                    "cargo": w.balance(&cz_economy::player_account(&player), cz_economy::Asset::Res(plan.resource)),
                },
                "events": summarize(&ev).into_iter().filter(|e| !matches!(e, Event::Transfer(_))).collect::<Vec<_>>(),
                "settlement": settlement,
            });
            let mut result = result;
            let stored_story: Option<Value> = sqlx::query_scalar("SELECT story FROM mission_sessions WHERE id = $1").bind(session).fetch_one(db).await?;
            if let Some(f) = stored_story.as_ref().and_then(|s| serde_json::from_value::<story::Facts>(s["facts"].clone()).ok()) {
                let after = w.memory.get(&plan.target).and_then(|m| m.players.get(&player));
                result["debrief"] = json!(story::debrief(&f, &result, after));
                result["codename"] = stored_story.as_ref().map(|s| s["story"]["codename"].clone()).unwrap_or(Value::Null);
            }
            sqlx::query("UPDATE mission_sessions SET completed_at = now(), outcome = $2, result = $3 WHERE id = $1")
                .bind(session)
                .bind(outcome)
                .bind(&result)
                .execute(db)
                .await?;
            log_event(db, w.tick, &format!("player:{player}"), "mission", &json!({ "phase": "complete", "session": session, "result": result })).await?;
            Ok(json!({ "replayed": false, "result": result }))
        })
        .await;
    respond(res)
}

/// The mission's story. With the NEAR AI planner configured, the first request asks
/// the model to voice the authored lines (checked line by line, outside the world
/// lock) and stores the result, so every later request sees the same story.
pub async fn story(state: web::Data<AppState>, req: HttpRequest, path: web::Path<Uuid>) -> HttpResponse {
    let who = match crate::handlers::auth::player(&state, &req).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let session = path.into_inner();
    let db = state.world.db();
    let row: Option<(String, Option<Value>)> = match sqlx::query_as("SELECT player, story FROM mission_sessions WHERE id = $1").bind(session).fetch_optional(db).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("story lookup failed: {e}");
            return HttpResponse::InternalServerError().json(json!({ "error": "storage error" }));
        }
    };
    let Some((player, Some(stored))) = row else { return HttpResponse::NotFound().json(json!({ "error": "no story for this session" })) };
    if player != who.account {
        return HttpResponse::Forbidden().json(json!({ "error": "session belongs to another player" }));
    }
    let (Ok(mut tale), Ok(facts)) = (serde_json::from_value::<story::Story>(stored["story"].clone()), serde_json::from_value::<story::Facts>(stored["facts"].clone())) else {
        return HttpResponse::InternalServerError().json(json!({ "error": "story unreadable" }));
    };
    if stored["voiced"] != true {
        if let Some(planner) = crate::services::planner::Planner::from_env() {
            let call = story::rewrite(&planner, &mut tale, &facts).await;
            let tick = state.world.read(|w| w.tick).await;
            let _ = log_event(db, tick, &format!("player:{player}"), "story_call", &json!({ "session": session, "model": planner.model, "call": call, "rewrites": tale.rewrites })).await;
            let _ = sqlx::query("UPDATE mission_sessions SET story = $2 WHERE id = $1")
                .bind(session).bind(json!({ "facts": facts, "story": tale, "voiced": true })).execute(db).await;
        }
    }
    HttpResponse::Ok().json(json!({ "story": tale, "facts": facts }))
}

/// Fail raids whose session timed out, so the depot is not held forever.
pub async fn expire_stale_sessions(state: &AppState) -> Result<usize, WorldError> {
    state
        .world
        .transact(async move |w, db| {
            let stale: Vec<(Uuid, String, i64)> = sqlx::query_as(
                "SELECT id, player, raid_id FROM mission_sessions WHERE completed_at IS NULL AND expires_at < now()",
            )
            .fetch_all(db)
            .await?;
            for (id, player, raid) in &stale {
                let _ = w.execute(&Caller::System, &Action::FailRaid { raid: *raid as u64, player: player.clone() });
                sqlx::query("UPDATE mission_sessions SET completed_at = now(), outcome = 'expired' WHERE id = $1").bind(id).execute(db).await?;
            }
            Ok(stale.len())
        })
        .await
}

pub(crate) fn respond(res: Result<Value, WorldError>) -> HttpResponse {
    match res {
        Ok(v) => HttpResponse::Ok().json(v),
        Err(WorldError::Econ(e)) => HttpResponse::Conflict().json(json!({ "error": e.to_string(), "detail": e })),
        Err(WorldError::Other(m)) => HttpResponse::BadRequest().json(json!({ "error": m })),
        Err(WorldError::Db(e)) => {
            tracing::error!("mission storage error: {e}");
            HttpResponse::InternalServerError().json(json!({ "error": "storage error" }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn near_account_ids() {
        for ok in ["raider.testnet", "vex-exchange.near", "a1", &"a".repeat(64)] {
            assert!(valid_account_id(ok), "{ok}");
        }
        for bad in ["", "a", "Raider.testnet", "raider..testnet", ".raider", "raider.", "raider testnet", &"a".repeat(65)] {
            assert!(!valid_account_id(bad), "{bad}");
        }
    }

    #[test]
    fn extraction_is_checked_against_server_time() {
        assert!(validate_extraction(60.0, 35.0, 8, 50).is_ok());
        assert_eq!(validate_extraction(10.0, 35.0, 8, 50), Err("extracted faster than the mission physically takes"));
        assert_eq!(validate_extraction(60.0, 35.0, 51, 50), Err("kill count implausible"));
        assert_eq!(validate_extraction(60.0, 35.0, -1, 50), Err("kill count implausible"));
        assert_eq!(validate_extraction((SESSION_TTL_SECS + 1) as f64, 35.0, 8, 50), Err("session expired"));
    }
}
