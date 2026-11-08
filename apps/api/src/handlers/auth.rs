//! Sign-in, sessions and the gas relayer. See `services::auth`.
//!
//! Every endpoint that acts for a player takes the player from the session (an
//! HttpOnly cookie, or `Authorization: Bearer` for non-browser clients), never from
//! the request body.

use actix_web::{web, HttpRequest, HttpResponse};
use base64::Engine;
use serde::Deserialize;
use serde_json::json;

use crate::handlers::missions::valid_account_id;
use crate::services::auth::{AuthError, PlayerSession, COOKIE, SESSION_DAYS};
use crate::AppState;

fn err(e: AuthError) -> HttpResponse {
    match e {
        AuthError::Denied(m) => HttpResponse::Unauthorized().json(json!({ "error": m })),
        AuthError::Bad(m) => HttpResponse::BadRequest().json(json!({ "error": m })),
        AuthError::Unavailable(m) => {
            tracing::warn!("auth unavailable: {m}");
            HttpResponse::ServiceUnavailable().json(json!({ "error": m }))
        }
        AuthError::Db(e) => {
            tracing::error!("auth storage: {e}");
            HttpResponse::InternalServerError().json(json!({ "error": "storage error" }))
        }
    }
}

fn token_of(req: &HttpRequest) -> Option<String> {
    if let Some(c) = req.cookie(COOKIE) {
        return Some(c.value().to_string());
    }
    req.headers().get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).map(str::to_string)
}

/// The signed-in player, or the response to send instead.
pub async fn player(state: &AppState, req: &HttpRequest) -> Result<PlayerSession, HttpResponse> {
    let Some(token) = token_of(req) else {
        return Err(HttpResponse::Unauthorized().json(json!({ "error": "sign in first" })));
    };
    match state.auth.session(state.world.db(), &token).await {
        Ok(Some(s)) => Ok(s),
        Ok(None) => Err(HttpResponse::Unauthorized().json(json!({ "error": "your session expired; sign in again" }))),
        Err(e) => Err(err(e)),
    }
}

/// Reject a body that names a different player than the session.
pub fn same_player(session: &PlayerSession, claimed: &str) -> Result<(), HttpResponse> {
    if !claimed.is_empty() && claimed != session.account {
        return Err(HttpResponse::Forbidden().json(json!({ "error": "you can only act as the account you signed in with" })));
    }
    Ok(())
}

fn limited(state: &AppState, req: &HttpRequest) -> Option<HttpResponse> {
    let ip = req.connection_info().realip_remote_addr().unwrap_or("unknown").to_string();
    (!state.mission_limiter.check(&ip)).then(|| HttpResponse::TooManyRequests().json(json!({ "error": "too many requests, slow down" })))
}

async fn signed_in(state: &AppState, account: &str, method: &str, provider: Option<&str>, subject: Option<&str>, public_key: Option<&str>, extra: serde_json::Value) -> HttpResponse {
    match state.auth.create_session(state.world.db(), account, method, provider, subject, public_key).await {
        Ok(token) => HttpResponse::Ok()
            .insert_header(("set-cookie", state.auth.cookie(&token, SESSION_DAYS * 86_400)))
            .json(json!({ "account": account, "method": method, "provider": provider, "profile": extra })),
        Err(e) => err(e),
    }
}

/// What the client needs to start a sign-in.
pub async fn config(state: web::Data<AppState>) -> HttpResponse {
    let a = &state.auth;
    HttpResponse::Ok().json(json!({
        "near_auth": {
            "domain": a.near_auth.domain, "client_id": a.near_auth.client_id, "fast_auth_contract": a.near_auth.fast_auth_contract,
            "mpc_contract": a.near_auth.mpc_contract, "signing_audience": a.near_auth.signing_audience,
        },
        "relayer": a.relayer.as_ref().map(|r| r.account.to_string()),
        "controller": a.controller,
        "wallet": { "message": a.signin_message(), "recipient": a.recipient },
        "dev_login": a.dev_login && state.near.is_none(),
    }))
}

pub async fn challenge(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    if let Some(r) = limited(&state, &req) {
        return r;
    }
    match state.auth.new_challenge(state.world.db()).await {
        Ok(n) => HttpResponse::Ok().json(json!({
            "nonce": base64::engine::general_purpose::STANDARD.encode(n), "message": state.auth.signin_message(), "recipient": state.auth.recipient, "expires_in_secs": 300,
        })),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
pub struct WalletSignIn {
    pub account_id: String,
    pub public_key: String,
    pub signature: String,
    /// The challenge nonce, base64.
    pub nonce: String,
}

pub async fn wallet(state: web::Data<AppState>, req: HttpRequest, body: web::Json<WalletSignIn>) -> HttpResponse {
    if let Some(r) = limited(&state, &req) {
        return r;
    }
    let b = body.into_inner();
    if !valid_account_id(&b.account_id) {
        return HttpResponse::BadRequest().json(json!({ "error": "invalid account id" }));
    }
    let Ok(nonce) = base64::engine::general_purpose::STANDARD.decode(&b.nonce) else {
        return HttpResponse::BadRequest().json(json!({ "error": "nonce must be base64" }));
    };
    if let Err(e) = state.auth.verify_wallet(state.world.db(), &b.account_id, &b.public_key, &b.signature, &nonce).await {
        return err(e);
    }
    signed_in(&state, &b.account_id, "wallet", Some("wallet"), None, Some(&b.public_key), json!({})).await
}

#[derive(Deserialize)]
pub struct NearAuthSignIn {
    pub id_token: String,
}

pub async fn near_auth(state: web::Data<AppState>, req: HttpRequest, body: web::Json<NearAuthSignIn>) -> HttpResponse {
    if let Some(r) = limited(&state, &req) {
        return r;
    }
    match state.auth.verify_near_auth(state.world.db(), &body.id_token).await {
        Ok((account, provider, sub, pk, label)) => signed_in(&state, &account, "near_auth", Some(&provider), Some(&sub), Some(&pk), json!({ "label": label })).await,
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
pub struct DevSignIn {
    pub account_id: String,
}

/// Local development only: off-chain economy AND `AUTH_DEV_LOGIN=1`. Never available
/// when settlement is on NEAR (startup refuses that combination).
pub async fn dev(state: web::Data<AppState>, body: web::Json<DevSignIn>) -> HttpResponse {
    if !state.auth.dev_login || state.near.is_some() || !valid_account_id(&body.account_id) {
        return HttpResponse::NotFound().finish();
    }
    signed_in(&state, &body.account_id, "dev", Some("dev"), None, None, json!({ "warning": "development sign-in: no proof of control" })).await
}

pub async fn session(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    match player(&state, &req).await {
        Ok(s) => HttpResponse::Ok().json(s),
        Err(r) => r,
    }
}

pub async fn logout(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    if let Some(t) = token_of(&req) {
        let _ = state.auth.revoke(state.world.db(), &t).await;
    }
    HttpResponse::Ok().insert_header(("set-cookie", state.auth.cookie("", 0))).json(json!({ "signed_out": true }))
}

#[derive(Deserialize)]
pub struct RelayRequest {
    /// borsh(SignedDelegateAction), base64.
    pub signed_delegate: String,
}

/// Pay gas for one of the signed-in player's own signed delegate actions.
pub async fn relay(state: web::Data<AppState>, req: HttpRequest, body: web::Json<RelayRequest>) -> HttpResponse {
    if let Some(r) = limited(&state, &req) {
        return r;
    }
    let s = match player(&state, &req).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    match state.auth.relay(&s.account, &body.signed_delegate).await {
        Ok(v) => HttpResponse::Ok().json(v),
        Err(e) => err(e),
    }
}

#[derive(Deserialize)]
pub struct NearAuthSignRequest {
    pub verify_payload: String,
    pub sign_payload: Vec<u8>,
}

/// NEAR Auth players: submit the MPC signature request for an allowed delegate action.
pub async fn near_auth_sign(state: web::Data<AppState>, req: HttpRequest, body: web::Json<NearAuthSignRequest>) -> HttpResponse {
    if let Some(r) = limited(&state, &req) {
        return r;
    }
    let s = match player(&state, &req).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    if s.method != "near_auth" {
        return HttpResponse::Forbidden().json(json!({ "error": "only for players signed in with Google, Apple, email or passkey" }));
    }
    match state.auth.near_auth_sign(&s, &body.verify_payload, &body.sign_payload).await {
        Ok(v) => HttpResponse::Ok().json(v),
        Err(e) => err(e),
    }
}
