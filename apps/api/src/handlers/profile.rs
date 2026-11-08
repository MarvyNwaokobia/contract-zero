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
