//! Mission sessions: the only path from a fight to the economy.
//!
//! `POST /missions/start` locks in a raid plan from the live economy and issues a
//! single-use session. `POST /missions/{id}/complete` reports the outcome; the server
//! measures the elapsed time itself, checks it against what the mission physically
//! takes, and only then settles the raid (cargo to the player) or fails it.
//! Completing twice returns the stored result: a replay can never settle twice.
//!
//! Identity: until NEAR sign-in lands, the player is the NEAR account id in the
//! request, validated for format only.

use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{DateTime, Utc};
use cz_economy::mission::load_seconds;
use cz_economy::{Action, Caller, Event, RaidStatus, Resource};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

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
    pub player: String,
    pub target: String,
    pub resource: Resource,
}

pub async fn start(state: web::Data<AppState>, req: HttpRequest, body: web::Json<StartRequest>) -> HttpResponse {
    let ip = req.connection_info().realip_remote_addr().unwrap_or("unknown").to_string();
    if !state.mission_limiter.check(&ip) {
        return HttpResponse::TooManyRequests().json(json!({ "error": "too many deployments, slow down" }));
    }
    if !valid_account_id(&body.player) {
        return HttpResponse::BadRequest().json(json!({ "error": "invalid NEAR account id" }));
    }
    let body = body.into_inner();
    let session = Uuid::new_v4();
    let res = state
        .world
        .transact(async move |w, db| {
            let ev = w.execute(&Caller::Player(body.player.clone()), &Action::StartRaid { target: body.target.clone(), resource: body.resource })?;
            let raid = *w.raids.keys().last().expect("raid just created");
            let plan = w.raids[&raid].plan.clone();
            let min_secs = load_seconds(plan.manifest) as f64 + MIN_TRAVERSAL_SECS;
            sqlx::query(
                "INSERT INTO mission_sessions (id, player, raid_id, min_secs, expires_at)
                 VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))",
            )
            .bind(session)
            .bind(&body.player)
            .bind(raid as i64)
            .bind(min_secs)
            .bind(SESSION_TTL_SECS as f64)
            .execute(db)
            .await?;
            log_event(db, w.tick, &format!("player:{}", body.player), "mission", &json!({ "phase": "start", "session": session, "raid": raid, "plan": plan, "events": summarize(&ev) })).await?;
            Ok(json!({ "session": session, "raid": raid, "min_secs": min_secs, "mission": crate::handlers::world::mission_json(w, &plan, Some(raid)) }))
        })
        .await;
    respond(res)
}

#[derive(Deserialize)]
pub struct CompleteRequest {
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

pub async fn complete(state: web::Data<AppState>, path: web::Path<Uuid>, body: web::Json<CompleteRequest>) -> HttpResponse {
    let session = path.into_inner();
    let body = body.into_inner();
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
                (Some(n), "extracted") => crate::services::settlement::queue_raid(w, db, n, raid)
                    .await?
                    .map(|op| json!({ "op_id": op, "status": "queued" })),
                _ => None,
            };
            let result = json!({
                "outcome": outcome,
                "reason": verdict,
                "elapsed_secs": elapsed,
                "min_secs": min_secs,
                "raid": raid,
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

fn respond(res: Result<Value, WorldError>) -> HttpResponse {
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
