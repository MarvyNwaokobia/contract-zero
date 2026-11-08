//! Player authentication, sessions, and the gas relayer.
//!
//! **A session is proof of control, never a claim.** The server issues a session for an
//! account only after the player proves, cryptographically, that they control it:
//!
//! - **Wallet** (existing NEAR users): a NEP-413 signed message over a single-use
//!   server nonce, by a key that RPC confirms is a *full-access* key of that account.
//! - **NEAR Auth** (Google / email / passkey via NEAR's MPC-backed login): an identity
//!   token signed by the NEAR Auth Auth0 tenant (verified against its JWKS). The
//!   token's subject determines, through the MPC contract's `derived_public_key`, the
//!   one key that controls the player's account. The account is the implicit account
//!   of that key, so the binding identity → key → account is computed, not looked up.
//!
//! The cookie holds a random token; the database stores only its SHA-256.
//!
//! **The relayer sponsors gas, nothing else.** It wraps a player's *signed* delegate
//! action (NEP-366) in a transaction it pays for. It cannot change what the player
//! signed, and it only relays a short allow-list: open or close a trading session, and
//! add or remove a session key scoped to the controller. It holds a gas float, no game
//! assets and no authority over any player account.
//!
//! **Trades are never relayed.** Inside a meta-transaction every contract sees the
//! *relayer* as the transaction signer (verified on testnet). `cz-assets` debits a
//! player only when the player signed, and the controller enforces a session's budget
//! by the signing key, so a trade must be a transaction the player's own key (wallet,
//! NEAR Auth MPC key, or session key) signs directly. Gas for those comes from the
//! player's account, which onboarding sponsors with a small NEAR float.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use borsh::BorshDeserialize;
use chrono::Utc;
use ed25519_dalek::{Signature as EdSig, Verifier, VerifyingKey};
use near_api::types::transaction::delegate_action::{DelegateAction, SignedDelegateAction};
use near_api::types::{AccessKeyPermission, AccountId, Action, NearGas, NearToken};
use near_api::{Signer, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tokio::sync::Mutex;

/// NEP-413 tag: 2^31 + 413.
const NEP413_TAG: u32 = (1 << 31) + 413;
/// NEP-366 tag: 2^30 + 366.
const NEP366_TAG: u32 = (1 << 30) + 366;
pub const SESSION_DAYS: i64 = 7;
pub const COOKIE: &str = "cz_session";
/// What a session key may call on the controller.
pub const SESSION_METHODS: [&str; 3] = ["accept_offer", "accept_bid", "revoke_session"];
/// The controller's `SESSION_DEPOSIT` (0.001 NEAR).
const SESSION_DEPOSIT: u128 = 1_000_000_000_000_000_000_000;
/// Gas allowance cap for a session key we agree to relay an AddKey for.
const MAX_KEY_ALLOWANCE: u128 = 250_000_000_000_000_000_000_000; // 0.25 NEAR

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("{0}")]
    Denied(String),
    #[error("{0}")]
    Bad(String),
    #[error("{0}")]
    Unavailable(String),
    #[error("storage: {0}")]
    Db(#[from] sqlx::Error),
}

fn denied(m: impl Into<String>) -> AuthError {
    AuthError::Denied(m.into())
}

/// NEAR Auth (FastAuth) configuration. Defaults are NEAR's published *testnet*
/// values, including the shared development client id.
#[derive(Clone, Debug)]
pub struct NearAuthConfig {
    pub domain: String,
    pub client_id: String,
    pub signing_audience: String,
    pub fast_auth_contract: String,
    pub mpc_contract: String,
}

impl NearAuthConfig {
    fn from_env() -> Self {
        let e = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
        Self {
            domain: e("NEAR_AUTH_DOMAIN", "login.testnet.fast-auth.com"),
            client_id: e("NEAR_AUTH_CLIENT_ID", "np8paqIpMWmNbzT4xAvOOapZBjsOpptl"),
            signing_audience: e("NEAR_AUTH_SIGNING_AUDIENCE", "auth0.jwt.fast-auth.testnet"),
            fast_auth_contract: e("NEAR_AUTH_CONTRACT", "fast-auth.testnet"),
            mpc_contract: e("NEAR_AUTH_MPC", "v1.signer-prod.testnet"),
        }
    }
    pub fn issuer(&self) -> String {
        format!("https://{}/", self.domain)
    }
    /// The MPC derivation path for an identity (as the NEAR Auth provider builds it).
    pub fn path(&self, sub: &str) -> String {
        format!("jwt#https://{}/#{sub}", self.domain)
    }
}

/// The relayer: a funded account that pays gas for players' signed delegate actions
/// and sponsors new accounts. Its key is read from a file outside the repository.
pub struct Relayer {
    pub account: AccountId,
    signer: Arc<Signer>,
    lock: Mutex<()>,
}

pub struct AuthService {
    pub rpc_url: String,
    http: reqwest::Client,
    pub near_auth: NearAuthConfig,
    /// Message/recipient a wallet signs at sign-in.
    pub recipient: String,
    pub relayer: Option<Relayer>,
    /// The controller the relayer may call (cz-world v2).
    pub controller: Option<String>,
    /// NEAR sponsored to a new NEAR Auth account (covers its storage and session deposits).
    pub sponsor_yocto: u128,
    pub dev_login: bool,
    pub cookie_secure: bool,
    jwks: Mutex<Option<(Instant, HashMap<String, (String, String)>)>>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct PlayerSession {
    pub account: String,
    pub method: String,
    pub provider: Option<String>,
    pub subject: Option<String>,
    pub public_key: Option<String>,
    pub expires_at: chrono::DateTime<Utc>,
}

#[derive(Deserialize)]
struct IdClaims {
    sub: String,
    iat: i64,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
struct SignClaims {
    sub: String,
    #[serde(default)]
    fatxn: Option<Vec<u8>>,
}

impl AuthService {
    pub fn from_env(controller: Option<String>) -> Result<Self, String> {
        let rpc_url = std::env::var("NEAR_RPC_URL").unwrap_or_else(|_| "https://rpc.testnet.fastnear.com".into());
        let relayer = match (std::env::var("CZ_RELAYER_ACCOUNT"), std::env::var("CZ_RELAYER_KEY_FILE")) {
            (Ok(a), Ok(f)) => {
                let account: AccountId = a.parse().map_err(|e| format!("CZ_RELAYER_ACCOUNT: {e}"))?;
                let signer = Signer::from_access_keyfile(f.clone().into()).map_err(|e| format!("relayer key ({f}): {e}"))?;
                Some(Relayer { account, signer, lock: Mutex::new(()) })
            }
            _ => None,
        };
        Ok(Self {
            rpc_url,
            http: reqwest::Client::new(),
            near_auth: NearAuthConfig::from_env(),
            recipient: std::env::var("AUTH_RECIPIENT").unwrap_or_else(|_| "contract-zero".into()),
            relayer,
            controller,
            // 0.1 NEAR: account storage, the session deposit, and the up-front gas
            // reservation of a few trades (mostly refunded).
            sponsor_yocto: std::env::var("AUTH_SPONSOR_YOCTO").ok().and_then(|v| v.parse().ok()).unwrap_or(100_000_000_000_000_000_000_000),
            dev_login: std::env::var("AUTH_DEV_LOGIN").as_deref() == Ok("1"),
            cookie_secure: std::env::var("AUTH_COOKIE_SECURE").as_deref() == Ok("1"),
            jwks: Mutex::new(None),
        })
    }

    // ── RPC helpers ──────────────────────────────────────────────────────────

    async fn rpc(&self, method: &str, params: Value) -> Result<Value, AuthError> {
        let body = json!({ "jsonrpc": "2.0", "id": "cz", "method": method, "params": params });
        let r: Value = self.http.post(&self.rpc_url).json(&body).send().await.map_err(|e| AuthError::Unavailable(e.to_string()))?.json().await.map_err(|e| AuthError::Unavailable(e.to_string()))?;
        Ok(r)
    }

    /// `Some(true)` full access, `Some(false)` function-call key, `None` not a key of the account.
    pub async fn key_permission(&self, account: &str, public_key: &str) -> Result<Option<bool>, AuthError> {
        let r = self.rpc("query", json!({ "request_type": "view_access_key", "finality": "final", "account_id": account, "public_key": public_key })).await?;
        if let Some(p) = r["result"].get("permission") {
            return Ok(Some(p.as_str() == Some("FullAccess")));
        }
        Ok(None)
    }

    pub async fn account_exists(&self, account: &str) -> Result<bool, AuthError> {
        let r = self.rpc("query", json!({ "request_type": "view_account", "finality": "final", "account_id": account })).await?;
        if r["result"].get("amount").is_some() {
            return Ok(true);
        }
        let cause = r["error"]["cause"]["name"].as_str().unwrap_or_default();
        if cause == "UNKNOWN_ACCOUNT" {
            return Ok(false);
        }
        Err(AuthError::Unavailable(format!("view_account: {}", r["error"])))
    }

    async fn view(&self, contract: &str, method: &str, args: Value) -> Result<Value, AuthError> {
        let b64 = base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&args).unwrap());
        let r = self.rpc("query", json!({ "request_type": "call_function", "finality": "final", "account_id": contract, "method_name": method, "args_base64": b64 })).await?;
        let bytes: Vec<u8> = r["result"]["result"].as_array().ok_or_else(|| AuthError::Unavailable(format!("{method}: {}", r)))?.iter().map(|b| b.as_u64().unwrap_or(0) as u8).collect();
        serde_json::from_slice(&bytes).map_err(|e| AuthError::Unavailable(e.to_string()))
    }

    // ── wallet: NEP-413 ──────────────────────────────────────────────────────

    pub fn signin_message(&self) -> String {
        "Sign in to CONTRACT ZERO".into()
    }

    pub async fn new_challenge(&self, db: &PgPool) -> Result<[u8; 32], AuthError> {
        let nonce: [u8; 32] = rand::random();
        sqlx::query("INSERT INTO auth_challenges (nonce, expires_at) VALUES ($1, now() + interval '5 minutes')").bind(hex::encode(nonce)).execute(db).await?;
        Ok(nonce)
    }

    /// Verify a NEP-413 sign-in and consume its nonce. Returns the proven account.
    pub async fn verify_wallet(&self, db: &PgPool, account: &str, public_key: &str, signature_b64: &str, nonce: &[u8]) -> Result<(), AuthError> {
        let nonce: [u8; 32] = nonce.try_into().map_err(|_| AuthError::Bad("nonce must be 32 bytes".into()))?;
        let pk = parse_ed25519(public_key)?;
        let sig = decode_signature(signature_b64)?;
        let hash = nep413_hash(&self.signin_message(), &nonce, &self.recipient, None);
        pk.verify(&hash, &sig).map_err(|_| denied("signature does not match"))?;
        // Single use: the nonce must be ours, unexpired and unused.
        let n = sqlx::query("UPDATE auth_challenges SET used_at = now() WHERE nonce = $1 AND used_at IS NULL AND expires_at > now()").bind(hex::encode(nonce)).execute(db).await?.rows_affected();
        if n != 1 {
            return Err(denied("unknown, expired or already used sign-in challenge"));
        }
        // The key must control the account: full access, not a scoped key.
        match self.key_permission(account, public_key).await? {
            Some(true) => Ok(()),
            Some(false) => Err(denied("that key is a limited key; sign in with the account's own key")),
            None => Err(denied("that key does not belong to the account")),
        }
    }

    // ── NEAR Auth: identity token → derived key → account ───────────────────

    async fn jwks_key(&self, kid: &str) -> Result<(String, String), AuthError> {
        {
            let g = self.jwks.lock().await;
            if let Some((at, keys)) = g.as_ref() {
                if at.elapsed() < Duration::from_secs(3600) {
                    if let Some(k) = keys.get(kid) {
                        return Ok(k.clone());
                    }
                }
            }
        }
        let url = format!("https://{}/.well-known/jwks.json", self.near_auth.domain);
        let v: Value = self.http.get(&url).send().await.map_err(|e| AuthError::Unavailable(e.to_string()))?.json().await.map_err(|e| AuthError::Unavailable(e.to_string()))?;
        let keys: HashMap<String, (String, String)> = v["keys"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|k| Some((k["kid"].as_str()?.to_string(), (k["n"].as_str()?.to_string(), k["e"].as_str()?.to_string()))))
            .collect();
        let found = keys.get(kid).cloned();
        *self.jwks.lock().await = Some((Instant::now(), keys));
        found.ok_or_else(|| denied("token signed by an unknown key"))
    }

    async fn decode_jwt<T: serde::de::DeserializeOwned>(&self, token: &str, audience: &str) -> Result<T, AuthError> {
        use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
        let header = decode_header(token).map_err(|_| AuthError::Bad("malformed token".into()))?;
        if header.alg != Algorithm::RS256 {
            return Err(denied("unexpected token algorithm"));
        }
        let kid = header.kid.ok_or_else(|| denied("token has no key id"))?;
        let (n, e) = self.jwks_key(&kid).await?;
        let key = DecodingKey::from_rsa_components(&n, &e).map_err(|_| AuthError::Unavailable("bad JWKS key".into()))?;
        let mut v = Validation::new(Algorithm::RS256);
        v.set_audience(&[audience]);
        v.set_issuer(&[self.near_auth.issuer()]);
        v.leeway = 30;
        Ok(decode::<T>(token, &key, &v).map_err(|e| denied(format!("token rejected: {e}")))?.claims)
    }

    /// The key NEAR Auth's MPC network derives for an identity.
    pub async fn derived_key(&self, sub: &str) -> Result<String, AuthError> {
        let v = self
            .view(&self.near_auth.mpc_contract, "derived_public_key", json!({ "path": self.near_auth.path(sub), "predecessor": self.near_auth.fast_auth_contract, "domain_id": 1 }))
            .await?;
        v.as_str().map(str::to_string).ok_or_else(|| AuthError::Unavailable(format!("derived_public_key: {v}")))
    }

    /// Verify a fresh NEAR Auth ID token; derive the player's key and account; make
    /// sure the account exists (sponsoring it once if not).
    pub async fn verify_near_auth(&self, db: &PgPool, id_token: &str) -> Result<(String, String, String, String, Option<String>), AuthError> {
        let c: IdClaims = self.decode_jwt(id_token, &self.near_auth.client_id.clone()).await?;
        if Utc::now().timestamp() - c.iat > 600 {
            return Err(denied("sign-in token is too old; sign in again"));
        }
        let provider = provider_of(&c.sub);
        let public_key = self.derived_key(&c.sub).await?;
        let account = implicit_account(&public_key)?;
        let label = c.email.or(c.name);
        let mut sponsor_tx = None;
        if !self.account_exists(&account).await? {
            sponsor_tx = Some(self.sponsor(&account).await?);
        }
        sqlx::query("INSERT INTO auth_identities (subject, provider, public_key, account, sponsor_tx) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (subject) DO NOTHING")
            .bind(&c.sub)
            .bind(&provider)
            .bind(&public_key)
            .bind(&account)
            .bind(&sponsor_tx)
            .execute(db)
            .await?;
        // An implicit account is controlled by exactly the key its id encodes; confirm
        // the chain agrees before trusting it.
        if self.key_permission(&account, &public_key).await? != Some(true) {
            return Err(AuthError::Unavailable("the account is not controlled by the derived key yet; try again shortly".into()));
        }
        Ok((account, provider, c.sub, public_key, label))
    }

    // ── sessions ─────────────────────────────────────────────────────────────

    pub async fn create_session(&self, db: &PgPool, account: &str, method: &str, provider: Option<&str>, subject: Option<&str>, public_key: Option<&str>) -> Result<String, AuthError> {
        let token: [u8; 32] = rand::random();
        let token = hex::encode(token);
        sqlx::query("INSERT INTO auth_sessions (token_hash, account, method, provider, subject, public_key, expires_at) VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7))")
            .bind(hash_token(&token))
            .bind(account)
            .bind(method)
            .bind(provider)
            .bind(subject)
            .bind(public_key)
            .bind(SESSION_DAYS as i32)
            .execute(db)
            .await?;
        Ok(token)
    }

    pub async fn session(&self, db: &PgPool, token: &str) -> Result<Option<PlayerSession>, AuthError> {
        type Row = (String, String, Option<String>, Option<String>, Option<String>, chrono::DateTime<Utc>);
        let r: Option<Row> = sqlx::query_as("SELECT account, method, provider, subject, public_key, expires_at FROM auth_sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()")
            .bind(hash_token(token))
            .fetch_optional(db)
            .await?;
        Ok(r.map(|(account, method, provider, subject, public_key, expires_at)| PlayerSession { account, method, provider, subject, public_key, expires_at }))
    }

    pub async fn revoke(&self, db: &PgPool, token: &str) -> Result<(), AuthError> {
        sqlx::query("UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = $1").bind(hash_token(token)).execute(db).await?;
        Ok(())
    }

    pub fn cookie(&self, token: &str, max_age_secs: i64) -> String {
        format!("{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age_secs}{}", if self.cookie_secure { "; Secure" } else { "" })
    }

    // ── relayer ──────────────────────────────────────────────────────────────

    fn relayer(&self) -> Result<&Relayer, AuthError> {
        self.relayer.as_ref().ok_or_else(|| AuthError::Unavailable("gas relayer not configured (CZ_RELAYER_ACCOUNT, CZ_RELAYER_KEY_FILE)".into()))
    }

    async fn submit(&self, receiver: &str, actions: Vec<Action>) -> Result<(String, Value), AuthError> {
        let r = self.relayer()?;
        let _g = r.lock.lock().await;
        let receiver: AccountId = receiver.parse().map_err(|e| AuthError::Bad(format!("receiver: {e}")))?;
        let res = Transaction::construct(r.account.clone(), receiver)
            .add_actions(actions)
            .with_signer(r.signer.clone())
            .send_to_testnet()
            .await
            .map_err(|e| AuthError::Unavailable(format!("relay send failed: {e}")))?;
        let full = res.into_full().ok_or_else(|| AuthError::Unavailable("relay: transaction still pending".into()))?;
        let hash = full.outcomes().first().map(|o| o.transaction_hash.to_string()).ok_or_else(|| AuthError::Unavailable("relay: no outcome".into()))?;
        let outcome = self.final_outcome(&hash, &r.account.to_string()).await?;
        Ok((hash, outcome))
    }

    /// The transaction's FINAL outcome from RPC (independent of the submitting library).
    pub async fn final_outcome(&self, hash: &str, signer: &str) -> Result<Value, AuthError> {
        for _ in 0..10 {
            let r = self.rpc("tx", json!({ "tx_hash": hash, "sender_account_id": signer, "wait_until": "FINAL" })).await?;
            if r.get("error").is_some() {
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
            return Ok(r["result"].clone());
        }
        Err(AuthError::Unavailable(format!("{hash}: no final outcome")))
    }

    /// Fund a new implicit account so it exists and can pay its session deposit.
    async fn sponsor(&self, account: &str) -> Result<String, AuthError> {
        let (hash, out) = self.submit(account, vec![Action::Transfer(near_api::types::transaction::actions::TransferAction { deposit: NearToken::from_yoctonear(self.sponsor_yocto) })]).await?;
        if out["status"].get("SuccessValue").is_none() {
            return Err(AuthError::Unavailable(format!("sponsoring the account failed: {}", out["status"])));
        }
        Ok(hash)
    }

    /// Check a player's signed delegate action: their own, correctly signed, and on
    /// the relay allow-list.
    pub fn check_delegate(&self, player: &str, sd: &SignedDelegateAction) -> Result<&'static str, AuthError> {
        let kind = self.check_shape(player, &sd.delegate_action)?;
        let d = &sd.delegate_action;
        let pk = parse_ed25519(&d.public_key.to_string())?;
        let sig = parse_near_signature(&sd.signature.to_string())?;
        pk.verify(&nep366_hash(d), &sig).map_err(|_| denied("delegate signature does not match"))?;
        Ok(kind)
    }

    /// The allow-list: what the relayer pays for, for `player`.
    pub fn check_shape(&self, player: &str, d: &DelegateAction) -> Result<&'static str, AuthError> {
        if d.sender_id.as_str() != player {
            return Err(denied("you can only relay your own actions"));
        }
        let controller = self.controller.as_deref().ok_or_else(|| AuthError::Unavailable("no controller configured".into()))?;
        if d.actions.len() != 1 {
            return Err(denied("one action per relayed request"));
        }
        let action: &Action = &d.actions[0];
        let receiver = d.receiver_id.as_str();
        match action {
            Action::FunctionCall(f) if receiver == controller => {
                let m = f.method_name.as_str();
                let dep = f.deposit.as_yoctonear();
                if m == "revoke_session" && dep == 0 && f.gas <= NearGas::from_tgas(30) {
                    return Ok("revoke_session");
                }
                if m == "register_session" && dep == SESSION_DEPOSIT && f.gas <= NearGas::from_tgas(30) {
                    return Ok("register_session");
                }
                if m == "accept_offer" || m == "accept_bid" {
                    return Err(denied("trades are signed directly by the player's key, not relayed (in a relayed call the chain cannot see who signed)"));
                }
                Err(denied(format!("the relayer does not pay for {m}")))
            }
            Action::AddKey(k) if receiver == player => match &k.access_key.permission {
                AccessKeyPermission::FunctionCall(p)
                    if p.receiver_id == controller
                        && !p.method_names.is_empty()
                        && p.method_names.iter().all(|m| SESSION_METHODS.contains(&m.as_str()))
                        && p.allowance.is_some_and(|a| a.as_yoctonear() <= MAX_KEY_ALLOWANCE) =>
                {
                    Ok("add_session_key")
                }
                _ => Err(denied("only a session key scoped to the game controller can be added")),
            },
            Action::DeleteKey(_) if receiver == player => Ok("delete_key"),
            _ => Err(denied("the relayer does not pay for that action")),
        }
    }

    /// A transaction the player signs and sends themselves through NEAR Auth: only a
    /// trade acceptance (or session sign-out) on the controller, from their account.
    pub fn check_trade_tx(&self, player: &str, tx: &near_api::types::transaction::Transaction) -> Result<(), AuthError> {
        let controller = self.controller.as_deref().ok_or_else(|| AuthError::Unavailable("no controller configured".into()))?;
        if tx.signer_id().as_str() != player || tx.receiver_id().as_str() != controller || tx.actions().len() != 1 {
            return Err(denied("only your own trades on the game controller are signed through the game"));
        }
        match &tx.actions()[0] {
            Action::FunctionCall(f) if SESSION_METHODS.contains(&f.method_name.as_str()) && f.deposit.as_yoctonear() == 0 && f.gas <= NearGas::from_tgas(100) => Ok(()),
            _ => Err(denied("only trade acceptances are signed through the game")),
        }
    }

    /// Relay a player's signed delegate action; returns the transaction hash and its
    /// decoded final result.
    pub async fn relay(&self, player: &str, signed_b64: &str) -> Result<Value, AuthError> {
        let bytes = base64::engine::general_purpose::STANDARD.decode(signed_b64).map_err(|_| AuthError::Bad("signed_delegate must be base64".into()))?;
        let sd = SignedDelegateAction::try_from_slice(&bytes).map_err(|e| AuthError::Bad(format!("not a signed delegate action: {e}")))?;
        let kind = self.check_delegate(player, &sd)?;
        let (hash, out) = self.submit(player, vec![Action::Delegate(Box::new(sd))]).await?;
        Ok(summarize_outcome(&hash, kind, &out))
    }

    /// NEAR Auth signing: forward the player's MPC signature request to the NEAR Auth
    /// contract, paying its gas. The JWT binds the exact payload to the identity; the
    /// payload must be one of the player's own delegate actions on the allow-list.
    pub async fn near_auth_sign(&self, session: &PlayerSession, verify_payload: &str, sign_payload: &[u8]) -> Result<Value, AuthError> {
        let c: SignClaims = self.decode_jwt(verify_payload, &self.near_auth.signing_audience.clone()).await?;
        if Some(&c.sub) != session.subject.as_ref() {
            return Err(denied("the signing token belongs to another identity"));
        }
        if c.fatxn.as_deref() != Some(sign_payload) {
            return Err(denied("the payload is not the one the token authorizes"));
        }
        // Either a delegate action for the relayer (tag ++ borsh(DelegateAction)) or a
        // transaction the player sends themselves (borsh(Transaction)).
        if sign_payload.len() >= 4 && u32::from_le_bytes(sign_payload[..4].try_into().unwrap()) == NEP366_TAG {
            let d = DelegateAction::try_from_slice(&sign_payload[4..]).map_err(|e| AuthError::Bad(format!("bad delegate action: {e}")))?;
            // The allow-list (no signature yet: this request is what produces it).
            self.check_shape(&session.account, &d)?;
        } else {
            let tx = near_api::types::transaction::Transaction::try_from_slice(sign_payload).map_err(|e| AuthError::Bad(format!("not a transaction or delegate action: {e}")))?;
            self.check_trade_tx(&session.account, &tx)?;
        }
        let deposit: u128 = std::env::var("NEAR_AUTH_SIGN_DEPOSIT").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
        let args = json!({ "guard_id": format!("jwt#https://{}/", self.near_auth.domain), "verify_payload": verify_payload, "sign_payload": sign_payload, "algorithm": "eddsa" });
        let (hash, out) = self
            .submit(
                &self.near_auth.fast_auth_contract.clone(),
                vec![Action::FunctionCall(Box::new(near_api::types::transaction::actions::FunctionCallAction {
                    method_name: "sign".into(),
                    args: serde_json::to_vec(&args).unwrap(),
                    gas: NearGas::from_tgas(300),
                    deposit: NearToken::from_yoctonear(deposit),
                }))],
            )
            .await?;
        let value = out["status"]["SuccessValue"].as_str().map(str::to_string);
        Ok(json!({ "tx_hash": hash, "signature_b64": value, "status": out["status"] }))
    }

}

fn summarize_outcome(hash: &str, kind: &str, out: &Value) -> Value {
    let receipts = out["receipts_outcome"].as_array().cloned().unwrap_or_default();
    let failed: Vec<Value> = receipts.iter().filter_map(|r| r["outcome"]["status"].get("Failure").cloned()).collect();
    // The inner call's result is the receipt executed on the receiver (the last
    // non-refund receipt with a SuccessValue).
    json!({
        "tx_hash": hash, "kind": kind, "explorer": super::near::explorer_tx(hash),
        "ok": failed.is_empty(), "failures": failed,
        "status": out["status"],
    })
}

// ── crypto helpers ───────────────────────────────────────────────────────────

pub fn hash_token(t: &str) -> String {
    hex::encode(Sha256::digest(t.as_bytes()))
}

fn provider_of(sub: &str) -> String {
    match sub.split('|').next().unwrap_or_default() {
        "google-oauth2" => "google",
        "apple" => "apple",
        _ => "email",
    }
    .into()
}

fn parse_ed25519(pk: &str) -> Result<VerifyingKey, AuthError> {
    let b58 = pk.strip_prefix("ed25519:").ok_or_else(|| AuthError::Bad("only ed25519 keys are supported".into()))?;
    let bytes = bs58::decode(b58).into_vec().map_err(|_| AuthError::Bad("bad public key".into()))?;
    let arr: [u8; 32] = bytes.try_into().map_err(|_| AuthError::Bad("bad public key length".into()))?;
    VerifyingKey::from_bytes(&arr).map_err(|_| AuthError::Bad("invalid ed25519 key".into()))
}

/// The implicit account id of an ed25519 key: the hex of its 32 bytes.
pub fn implicit_account(pk: &str) -> Result<String, AuthError> {
    Ok(hex::encode(parse_ed25519(pk)?.to_bytes()))
}

/// A wallet's NEP-413 signature: base64 (most wallets) or "ed25519:<base58>".
fn decode_signature(s: &str) -> Result<EdSig, AuthError> {
    if s.starts_with("ed25519:") {
        return parse_near_signature(s);
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(s).map_err(|_| AuthError::Bad("bad signature encoding".into()))?;
    let arr: [u8; 64] = bytes.try_into().map_err(|_| AuthError::Bad("bad signature length".into()))?;
    Ok(EdSig::from_bytes(&arr))
}

fn parse_near_signature(s: &str) -> Result<EdSig, AuthError> {
    let b58 = s.strip_prefix("ed25519:").ok_or_else(|| AuthError::Bad("only ed25519 signatures".into()))?;
    let bytes = bs58::decode(b58).into_vec().map_err(|_| AuthError::Bad("bad signature".into()))?;
    let arr: [u8; 64] = bytes.try_into().map_err(|_| AuthError::Bad("bad signature length".into()))?;
    Ok(EdSig::from_bytes(&arr))
}

/// SHA-256 of the NEP-413 payload: tag ++ borsh({message, nonce, recipient, callback_url}).
pub fn nep413_hash(message: &str, nonce: &[u8; 32], recipient: &str, callback_url: Option<&str>) -> [u8; 32] {
    #[derive(borsh::BorshSerialize)]
    struct Payload<'a> {
        message: &'a str,
        nonce: [u8; 32],
        recipient: &'a str,
        callback_url: Option<&'a str>,
    }
    let mut bytes = borsh::to_vec(&NEP413_TAG).unwrap();
    bytes.extend(borsh::to_vec(&Payload { message, nonce: *nonce, recipient, callback_url }).unwrap());
    Sha256::digest(&bytes).into()
}

/// SHA-256 of the NEP-366 signable message for a delegate action.
fn nep366_hash(d: &DelegateAction) -> [u8; 32] {
    let mut bytes = borsh::to_vec(&NEP366_TAG).unwrap();
    bytes.extend(borsh::to_vec(d).unwrap());
    Sha256::digest(&bytes).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer as _, SigningKey};

    fn key() -> (SigningKey, String) {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pk = format!("ed25519:{}", bs58::encode(sk.verifying_key().to_bytes()).into_string());
        (sk, pk)
    }

    #[test]
    fn nep413_signatures_verify_and_bind_every_field() {
        let (sk, pk) = key();
        let nonce = [9u8; 32];
        let h = nep413_hash("Sign in to CONTRACT ZERO", &nonce, "contract-zero", None);
        let sig = sk.sign(&h);
        let vk = parse_ed25519(&pk).unwrap();
        assert!(vk.verify(&h, &sig).is_ok());
        let b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());
        assert!(vk.verify(&h, &decode_signature(&b64).unwrap()).is_ok());
        // Any change to message, nonce or recipient breaks it.
        for other in [
            nep413_hash("Sign in to CONTRACT ZERO!", &nonce, "contract-zero", None),
            nep413_hash("Sign in to CONTRACT ZERO", &[8u8; 32], "contract-zero", None),
            nep413_hash("Sign in to CONTRACT ZERO", &nonce, "evil.example", None),
        ] {
            assert!(vk.verify(&other, &sig).is_err());
        }
    }

    #[test]
    fn nep413_tag_is_two_to_the_31_plus_413() {
        assert_eq!(NEP413_TAG, 2_147_484_061);
        assert_eq!(NEP366_TAG, 1_073_742_190);
    }

    #[test]
    fn implicit_account_is_the_hex_of_the_key() {
        let (_, pk) = key();
        let a = implicit_account(&pk).unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn providers_come_from_the_subject() {
        assert_eq!(provider_of("google-oauth2|123"), "google");
        assert_eq!(provider_of("apple|1"), "apple");
        assert_eq!(provider_of("auth0|abc"), "email");
    }

    #[test]
    fn session_tokens_are_stored_hashed() {
        let h = hash_token("abc");
        assert_ne!(h, "abc");
        assert_eq!(h.len(), 64);
    }
}
