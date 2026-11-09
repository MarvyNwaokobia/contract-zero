//! Account-level preferences: the portable part of Settings (controls, interface,
//! accessibility, audio levels, subtitles). Keyed by the account the session proved,
//! never by a supplied ID. The document is allow-listed and size-limited: only plain
//! numbers, booleans and short strings, a bounded depth, and the five known sections.

use actix_web::{web, HttpRequest, HttpResponse};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::handlers::auth::player;
use crate::AppState;

/// The sections a client may store. Graphics is device-specific and stays local.
pub const SECTIONS: [&str; 5] = ["controls", "interface", "access", "audio", "subtitles"];
pub const MAX_BYTES: usize = 8 * 1024;
const MAX_DEPTH: usize = 4;
const MAX_STR: usize = 32;
const MAX_KEYS: usize = 64;

fn scalar_ok(v: &Value, depth: usize) -> bool {
    match v {
        Value::Bool(_) => true,
        Value::Number(n) => n.as_f64().is_some_and(f64::is_finite),
        Value::String(s) => s.len() <= MAX_STR && s.chars().all(|c| c.is_ascii_graphic() || c == ' '),
        Value::Null => true,
        Value::Array(a) => depth < MAX_DEPTH && a.len() <= 4 && a.iter().all(|x| scalar_ok(x, depth + 1)),
        Value::Object(o) => depth < MAX_DEPTH && o.len() <= MAX_KEYS && o.iter().all(|(k, x)| key_ok(k) && scalar_ok(x, depth + 1)),
    }
}

fn key_ok(k: &str) -> bool {
    !k.is_empty() && k.len() <= MAX_STR && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Keep only the known sections, and refuse anything oversized or oddly shaped.
pub fn sanitize(raw: &Value) -> Result<Map<String, Value>, &'static str> {
    if serde_json::to_vec(raw).map(|b| b.len()).unwrap_or(usize::MAX) > MAX_BYTES {
        return Err("preferences are too large");
    }
    let obj = raw.as_object().ok_or("preferences must be an object")?;
    let mut out = Map::new();
    for (k, v) in obj {
        if !SECTIONS.contains(&k.as_str()) {
            continue; // unknown or device-only sections are dropped, not stored
        }
        if !v.is_object() || !scalar_ok(v, 1) {
            return Err("unsupported preference value");
        }
        out.insert(k.clone(), v.clone());
    }
    Ok(out)
}

pub async fn get(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    let s = match player(&state, &req).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let row: Result<Option<(i32, Value, chrono::DateTime<chrono::Utc>)>, _> =
        sqlx::query_as("SELECT version, prefs, updated_at FROM player_preferences WHERE account = $1")
            .bind(&s.account)
            .fetch_optional(state.world.db())
            .await;
    match row {
        Ok(Some((version, prefs, at))) => HttpResponse::Ok().json(json!({ "version": version, "prefs": prefs, "updated_at": at })),
        Ok(None) => HttpResponse::Ok().json(json!({ "version": null, "prefs": null, "updated_at": null })),
        Err(e) => {
            tracing::error!("preferences: {e}");
            HttpResponse::InternalServerError().json(json!({ "error": "storage error" }))
        }
    }
}

#[derive(Deserialize)]
pub struct SetPreferences {
    pub version: i32,
    pub prefs: Value,
}

pub async fn set(state: web::Data<AppState>, req: HttpRequest, body: web::Json<SetPreferences>) -> HttpResponse {
    let s = match player(&state, &req).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    if !(1..=100).contains(&body.version) {
        return HttpResponse::BadRequest().json(json!({ "error": "unknown preferences version" }));
    }
    let prefs = match sanitize(&body.prefs) {
        Ok(p) => Value::Object(p),
        Err(e) => return HttpResponse::BadRequest().json(json!({ "error": e })),
    };
    let r: Result<(chrono::DateTime<chrono::Utc>,), _> = sqlx::query_as(
        "INSERT INTO player_preferences (account, version, prefs) VALUES ($1, $2, $3)
         ON CONFLICT (account) DO UPDATE SET version = EXCLUDED.version, prefs = EXCLUDED.prefs, updated_at = now()
         RETURNING updated_at",
    )
    .bind(&s.account)
    .bind(body.version)
    .bind(&prefs)
    .fetch_one(state.world.db())
    .await;
    match r {
        Ok((at,)) => HttpResponse::Ok().json(json!({ "version": body.version, "prefs": prefs, "updated_at": at })),
        Err(e) => {
            tracing::error!("preferences: {e}");
            HttpResponse::InternalServerError().json(json!({ "error": "storage error" }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_known_sections_and_drops_the_rest() {
        let p = sanitize(&json!({ "controls": { "invertY": true, "binds": { "reload": ["KeyR", null] } }, "graphics": { "quality": "high" }, "secret": "x" })).unwrap();
        assert!(p.contains_key("controls"));
        assert!(!p.contains_key("graphics"), "device settings are not stored");
        assert!(!p.contains_key("secret"));
    }

    #[test]
    fn refuses_odd_shapes() {
        assert!(sanitize(&json!([1, 2])).is_err());
        assert!(sanitize(&json!({ "controls": 5 })).is_err());
        assert!(sanitize(&json!({ "controls": { "x": "a".repeat(33) } })).is_err(), "long strings");
        assert!(sanitize(&json!({ "controls": { "x": "<script>\n" } })).is_err(), "control characters");
        assert!(sanitize(&json!({ "controls": { "a": { "b": { "c": { "d": 1 } } } } })).is_err(), "too deep");
        assert!(sanitize(&json!({ "controls": { "bad key": 1 } })).is_err());
        let big: Map<String, Value> = (0..400).map(|i| (format!("k{i}"), json!("abcdefghijklmnopqrstuvwxyz"))).collect();
        assert!(sanitize(&json!({ "controls": big })).is_err(), "oversized");
    }
}
