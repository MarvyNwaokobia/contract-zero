//! The operator profile: the callsign a player picks after their first sign-in.

use actix_web::{web, HttpRequest, HttpResponse};
use serde::Deserialize;
use serde_json::json;

use crate::handlers::auth::player;
use crate::AppState;

/// 3–16 characters: letters, digits and single dashes; stored upper-case.
pub fn normalize_callsign(raw: &str) -> Option<String> {
    let c = raw.trim().to_ascii_uppercase();
    let ok = (3..=16).contains(&c.len())
        && c.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'-')
        && !c.starts_with('-')
        && !c.ends_with('-')
        && !c.contains("--");
    ok.then_some(c)
}

pub async fn get(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    let s = match player(&state, &req).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let row: Result<Option<(String, chrono::DateTime<chrono::Utc>)>, _> = sqlx::query_as("SELECT callsign, created_at FROM player_profiles WHERE account = $1")
        .bind(&s.account)
        .fetch_optional(state.world.db())
        .await;
    match row {
        Ok(r) => HttpResponse::Ok().json(json!({
            "account": s.account, "method": s.method, "provider": s.provider,
            "callsign": r.as_ref().map(|x| x.0.clone()), "enlisted_at": r.map(|x| x.1),
        })),
        Err(e) => {
            tracing::error!("profile: {e}");
            HttpResponse::InternalServerError().json(json!({ "error": "storage error" }))
        }
    }
}

#[derive(Deserialize)]
pub struct SetProfile {
    pub callsign: String,
}

pub async fn set(state: web::Data<AppState>, req: HttpRequest, body: web::Json<SetProfile>) -> HttpResponse {
    let s = match player(&state, &req).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let Some(callsign) = normalize_callsign(&body.callsign) else {
        return HttpResponse::BadRequest().json(json!({ "error": "3–16 letters, digits or single dashes" }));
    };
    let r = sqlx::query(
        "INSERT INTO player_profiles (account, callsign) VALUES ($1, $2)
         ON CONFLICT (account) DO UPDATE SET callsign = EXCLUDED.callsign, updated_at = now()",
    )
    .bind(&s.account)
    .bind(&callsign)
    .execute(state.world.db())
    .await;
    match r {
        Ok(_) => HttpResponse::Ok().json(json!({ "callsign": callsign })),
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => HttpResponse::Conflict().json(json!({ "error": "that callsign is taken" })),
        Err(e) => {
            tracing::error!("profile: {e}");
            HttpResponse::InternalServerError().json(json!({ "error": "storage error" }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_callsign as n;

    #[test]
    fn callsigns() {
        assert_eq!(n(" kestrel-7 ").as_deref(), Some("KESTREL-7"));
        for bad in ["ab", "a".repeat(17).as_str(), "-ACE", "ACE-", "A--B", "SPACE BAR", "émile"] {
            assert!(n(bad).is_none(), "{bad}");
        }
    }
}

type MissionRow = (chrono::DateTime<chrono::Utc>, Option<String>, Option<serde_json::Value>, Option<serde_json::Value>);

/// The operator's service record: every operation (with its settlement on NEAR),
/// totals, standing with each power in the region, and owned gear. All of it is
/// read from records: mission sessions, the settlement queue and the economy.
pub async fn career(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    let s = match player(&state, &req).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let db = state.world.db();
    let rows: Vec<MissionRow> = match sqlx::query_as("SELECT started_at, outcome, result, story->'story'->'codename' FROM mission_sessions WHERE player = $1 ORDER BY started_at DESC LIMIT 100")
        .bind(&s.account).fetch_all(db).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("career: {e}");
            return HttpResponse::InternalServerError().json(json!({ "error": "storage error" }));
        }
    };
    let ops: Vec<String> = rows.iter().filter_map(|r| r.2.as_ref()?.get("settlement")?.get("op_id")?.as_str().map(String::from)).collect();
    let settled: std::collections::HashMap<String, (String, Vec<String>)> = sqlx::query_as::<_, (String, String, Vec<String>)>("SELECT op_id, status, tx_hashes FROM settlements WHERE op_id = ANY($1)")
        .bind(&ops).fetch_all(db).await.unwrap_or_default().into_iter().map(|(o, st, h)| (o, (st, h))).collect();
    let (mut extracted, mut lost, mut units, mut earned) = (0, 0, 0i64, 0i64);
    let missions: Vec<serde_json::Value> = rows.iter().map(|(at, outcome, result, codename)| {
        let r = result.clone().unwrap_or(serde_json::Value::Null);
        match outcome.as_deref() {
            Some("extracted") => {
                extracted += 1;
                units += r["extracted_units"].as_i64().unwrap_or(0);
                earned += r["bounty"].as_i64().unwrap_or(0);
            }
            Some("killed") | Some("expired") | Some("rejected") => lost += 1,
            _ => {}
        }
        let op = r["settlement"]["op_id"].as_str();
        let chain = op.and_then(|o| settled.get(o)).map(|(st, h)| json!({
            "op_id": op, "status": st, "settled_on_chain": st == "confirmed",
            "explorer": h.iter().map(|x| crate::services::near::explorer_tx(x)).collect::<Vec<_>>(),
        }));
        json!({
            "at": at, "codename": codename, "outcome": outcome.clone().unwrap_or_else(|| "in_progress".into()),
            "kind": r["kind"], "target": r["target"], "resource": r["resource"],
            "units": r["extracted_units"], "fee": r["bounty"], "secs": r["elapsed_secs"], "settlement": chain,
        })
    }).collect();
    let account = s.account.clone();
    let (standing, gear) = state.world.read(move |w| {
        let gear: Vec<serde_json::Value> = cz_economy::Gear::ALL.iter().map(|&g| json!({ "id": g.id(), "title": g.title(), "owned": w.balance(&cz_economy::player_account(&account), cz_economy::Asset::Gear(g)) })).collect();
        (w.standing(&account), gear)
    }).await;
    HttpResponse::Ok().json(json!({
        "account": s.account,
        "totals": { "operations": missions.len(), "extracted": extracted, "lost": lost, "units_moved": units, "fees_earned": earned },
        "missions": missions, "standing": standing, "gear": gear,
    }))
}
