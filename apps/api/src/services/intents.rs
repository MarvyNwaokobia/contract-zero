//! The official NEAR Intents adapter (1Click API), kept apart from CONTRACT ZERO's own
//! supply orders. Those are native CZ intents settled by `world2` on testnet; this is
//! the real protocol, whose Verifier (`intents.near`) exists on mainnet only.
//!
//! What it does, against the live service:
//! - lists the assets 1Click supports (`GET /v0/tokens`) and checks a request against
//!   them (asset ids, chains), refusing CONTRACT ZERO's own tokens, which are not
//!   supported (they are testnet NEP-245 game assets with no bridge or liquidity);
//! - requests quotes (`POST /v0/quote`), DRY by default: a dry quote returns prices,
//!   fees, the minimum received and the time estimate, but no deposit address, so no
//!   funds can be sent against it;
//! - reads execution status (`GET /v0/status`) for a deposit address;
//! - keeps every protocol reference (correlation id, signature, request, response).
//!
//! Executing a swap (a non-dry quote and a deposit) moves real mainnet funds. It is
//! off unless NEAR_INTENTS_EXECUTION=mainnet-approved, and nothing in the game turns it
//! on. CZ Credits have no exchange rate to any external token, and none is invented.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;

pub const BASE_URL: &str = "https://1click.chaindefuser.com";
pub const VERIFIER: &str = "intents.near";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Token {
    #[serde(rename = "assetId")]
    pub asset_id: String,
    pub decimals: u32,
    pub blockchain: String,
    pub symbol: String,
    #[serde(default)]
    pub price: Option<f64>,
    #[serde(rename = "contractAddress", default)]
    pub contract_address: Option<String>,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum IntentsError {
    #[error("{0} is a CONTRACT ZERO game asset; NEAR Intents doesn't support it (see docs/contract-zero/INTENTS.md)")]
    GameAsset(String),
    #[error("{0} is not an asset 1Click supports")]
    Unsupported(String),
    #[error("{asset} is on {chain}, not {expected}")]
    WrongChain { asset: String, chain: String, expected: String },
    #[error("amount must be a positive whole number of base units")]
    BadAmount,
    #[error("swap execution is disabled: it settles on NEAR mainnet with real funds and needs explicit approval")]
    ExecutionDisabled,
    #[error("a live swap needs a recipient account (and it receives the output and any refund)")]
    MissingRecipient,
    #[error("quote worth ${usd} is over the approved cap of ${cap}")]
    OverCap { usd: String, cap: String },
    #[error("1Click refused the request ({status}): {message}")]
    Refused { status: u16, message: String },
    #[error("could not reach 1Click: {0}")]
    Unreachable(String),
}

/// A quote request in the game's terms; becomes the 1Click QuoteRequest.
#[derive(Clone, Debug, Deserialize)]
pub struct QuoteAsk {
    pub origin_asset: String,
    pub destination_asset: String,
    /// Base units of the origin asset (EXACT_INPUT).
    pub amount: String,
    /// Where the output goes and refunds return (a NEAR account inside Intents).
    #[serde(default)]
    pub recipient: Option<String>,
    #[serde(default = "default_slippage")]
    pub slippage_bps: u32,
    /// Expected chain of the destination asset ("near", "eth", …), checked.
    #[serde(default)]
    pub destination_chain: Option<String>,
    /// Where the deposit is made and the output delivered: "INTENTS" (balances inside
    /// the Verifier; the default for dry quotes) or "ORIGIN_CHAIN" / "DESTINATION_CHAIN"
    /// (plain token transfers on the asset's own chain).
    #[serde(default)]
    pub deposit_type: Option<String>,
    #[serde(default)]
    pub recipient_type: Option<String>,
}

fn default_slippage() -> u32 {
    100
}

/// What the game shows: verified API fields only.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct QuoteView {
    pub dry: bool,
    pub correlation_id: String,
    pub signature: Option<String>,
    pub timestamp: Option<String>,
    pub amount_in: String,
    pub amount_in_formatted: Option<String>,
    pub amount_out: String,
    pub amount_out_formatted: Option<String>,
    pub min_amount_out: Option<String>,
    pub amount_out_usd: Option<String>,
    pub time_estimate_secs: Option<u64>,
    /// The fees 1Click applied (basis points per recipient), as echoed in its request.
    pub app_fees: Value,
    /// The quote's own deadline (when its terms stop applying).
    pub deadline: String,
    pub deposit_address: Option<String>,
}

pub fn is_game_asset(asset: &str) -> bool {
    asset.contains("contract-zero") || matches!(asset, "credits" | "ammo" | "med" | "fuel") || asset.starts_with("gun:")
}

/// Check an ask against the supported list before anything leaves the server.
pub fn validate(ask: &QuoteAsk, tokens: &[Token]) -> Result<(), IntentsError> {
    for a in [&ask.origin_asset, &ask.destination_asset] {
        if is_game_asset(a) {
            return Err(IntentsError::GameAsset(a.clone()));
        }
    }
    let find = |id: &str| tokens.iter().find(|t| t.asset_id == id);
    let Some(_) = find(&ask.origin_asset) else { return Err(IntentsError::Unsupported(ask.origin_asset.clone())) };
    let Some(dest) = find(&ask.destination_asset) else { return Err(IntentsError::Unsupported(ask.destination_asset.clone())) };
    if let Some(chain) = &ask.destination_chain {
        if &dest.blockchain != chain {
            return Err(IntentsError::WrongChain { asset: dest.asset_id.clone(), chain: dest.blockchain.clone(), expected: chain.clone() });
        }
    }
    if ask.amount.is_empty() || !ask.amount.bytes().all(|b| b.is_ascii_digit()) || ask.amount.trim_start_matches('0').is_empty() {
        return Err(IntentsError::BadAmount);
    }
    Ok(())
}

/// The 1Click QuoteRequest for an ask (intents-to-intents, exact input).
pub fn quote_request(ask: &QuoteAsk, dry: bool, deadline: chrono::DateTime<chrono::Utc>) -> Value {
    // Dry quotes need no real recipient; a placeholder never receives anything.
    let who = ask.recipient.clone().unwrap_or_else(|| "contract-zero-quote.near".into());
    let deposit = ask.deposit_type.clone().filter(|t| t == "ORIGIN_CHAIN" || t == "INTENTS").unwrap_or_else(|| "INTENTS".into());
    let recipient = ask.recipient_type.clone().filter(|t| t == "DESTINATION_CHAIN" || t == "INTENTS").unwrap_or_else(|| "INTENTS".into());
    // Refunds go back the way the deposit came.
    let refund = if deposit == "ORIGIN_CHAIN" { "ORIGIN_CHAIN" } else { "INTENTS" };
    json!({
        "dry": dry, "swapType": "EXACT_INPUT", "slippageTolerance": ask.slippage_bps.min(1_000),
        "originAsset": ask.origin_asset, "depositType": deposit,
        "destinationAsset": ask.destination_asset, "amount": ask.amount,
        "refundTo": who, "refundType": refund, "recipient": who, "recipientType": recipient,
        "deadline": deadline.to_rfc3339_opts(chrono::SecondsFormat::Millis, true), "quoteWaitingTimeMs": 3_000,
    })
}

/// Read a 1Click quote response into what the game shows.
pub fn parse_quote(v: &Value) -> Option<QuoteView> {
    let q = &v["quote"];
    let r = &v["quoteRequest"];
    let s = |x: &Value| x.as_str().map(String::from);
    Some(QuoteView {
        dry: r["dry"].as_bool().unwrap_or(true),
        correlation_id: s(&v["correlationId"])?,
        signature: s(&v["signature"]),
        timestamp: s(&v["timestamp"]),
        amount_in: s(&q["amountIn"])?,
        amount_in_formatted: s(&q["amountInFormatted"]),
        amount_out: s(&q["amountOut"])?,
        amount_out_formatted: s(&q["amountOutFormatted"]),
        min_amount_out: s(&q["minAmountOut"]),
        amount_out_usd: s(&q["amountOutUsd"]),
        time_estimate_secs: q["timeEstimate"].as_u64(),
        app_fees: r["appFees"].clone(),
        deadline: s(&q["deadline"]).or_else(|| s(&r["deadline"]))?,
        deposit_address: s(&q["depositAddress"]),
    })
}

/// Has a quote's deadline passed?
pub fn expired(view: &QuoteView, now: chrono::DateTime<chrono::Utc>) -> bool {
    chrono::DateTime::parse_from_rfc3339(&view.deadline).map(|d| d.with_timezone(&chrono::Utc) <= now).unwrap_or(true)
}

/// Every execution state 1Click reports, with what it means for the player.
pub fn status_meaning(s: &str) -> &'static str {
    match s {
        "PENDING_DEPOSIT" => "waiting for the deposit",
        "KNOWN_DEPOSIT_TX" => "deposit seen, confirming",
        "INCOMPLETE_DEPOSIT" => "deposit below the quoted amount",
        "PROCESSING" => "solvers are filling it",
        "SUCCESS" => "settled by the Verifier",
        "REFUNDED" => "not filled; funds returned",
        "FAILED" => "failed",
        _ => "unknown state",
    }
}

#[derive(Clone)]
pub struct IntentsClient {
    http: reqwest::Client,
    base: String,
    api_key: Option<String>,
    execution_allowed: bool,
    /// Most a live swap may be worth, in USD (from the quote's own amountInUsd).
    max_usd: f64,
    cache: Arc<Mutex<Option<(Instant, Vec<Token>)>>>,
}

impl IntentsClient {
    pub fn from_env() -> Self {
        Self {
            http: reqwest::Client::builder().timeout(Duration::from_secs(20)).build().expect("http client"),
            base: std::env::var("ONECLICK_BASE_URL").unwrap_or_else(|_| BASE_URL.into()),
            // Optional partner key (without one 1Click adds 25 bps). Never logged.
            api_key: std::env::var("ONECLICK_API_KEY").ok().filter(|k| !k.is_empty()),
            execution_allowed: std::env::var("NEAR_INTENTS_EXECUTION").as_deref() == Ok("mainnet-approved"),
            max_usd: std::env::var("NEAR_INTENTS_MAX_USD").ok().and_then(|v| v.parse().ok()).unwrap_or(1.0),
            cache: Arc::new(Mutex::new(None)),
        }
    }

    pub fn status(&self) -> Value {
        json!({
            "service": self.base, "verifier": VERIFIER, "network": "near-mainnet",
            "testnet_verifier": false, "authenticated": self.api_key.is_some(),
            "execution": if self.execution_allowed { format!("enabled (mainnet, approved by configuration, at most ${} per swap)", self.max_usd) } else { "disabled".into() },
            "quotes": "dry: prices and fees only, no deposit address",
        })
    }

    fn req(&self, r: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.api_key {
            Some(k) => r.header("X-API-Key", k),
            None => r,
        }
    }

    /// Supported assets (cached ten minutes).
    pub async fn tokens(&self) -> Result<Vec<Token>, IntentsError> {
        let mut c = self.cache.lock().await;
        if let Some((at, t)) = c.as_ref() {
            if at.elapsed() < Duration::from_secs(600) {
                return Ok(t.clone());
            }
        }
        let r = self.http.get(format!("{}/v0/tokens", self.base)).send().await.map_err(|e| IntentsError::Unreachable(e.to_string()))?;
        if !r.status().is_success() {
            return Err(IntentsError::Refused { status: r.status().as_u16(), message: r.text().await.unwrap_or_default() });
        }
        let t: Vec<Token> = r.json().await.map_err(|e| IntentsError::Unreachable(e.to_string()))?;
        *c = Some((Instant::now(), t.clone()));
        Ok(t)
    }

    /// A quote. `execute` asks for a real (non-dry) quote, refused unless execution was
    /// explicitly enabled.
    pub async fn quote(&self, ask: &QuoteAsk, execute: bool) -> Result<(QuoteView, Value, Value), IntentsError> {
        if execute && !self.execution_allowed {
            return Err(IntentsError::ExecutionDisabled);
        }
        if execute && ask.recipient.is_none() {
            return Err(IntentsError::MissingRecipient);
        }
        let tokens = self.tokens().await?;
        validate(ask, &tokens)?;
        let body = quote_request(ask, !execute, chrono::Utc::now() + chrono::Duration::minutes(30));
        let r = self.req(self.http.post(format!("{}/v0/quote", self.base)).json(&body)).send().await.map_err(|e| IntentsError::Unreachable(e.to_string()))?;
        let status = r.status().as_u16();
        let v: Value = r.json().await.unwrap_or(Value::Null);
        if !(200..300).contains(&status) {
            return Err(IntentsError::Refused { status, message: v["message"].as_str().unwrap_or("no message").to_string() });
        }
        let view = parse_quote(&v).ok_or_else(|| IntentsError::Refused { status, message: "unexpected quote shape".into() })?;
        if execute {
            let usd: f64 = v["quote"]["amountInUsd"].as_str().and_then(|x| x.parse().ok()).unwrap_or(f64::MAX);
            if usd > self.max_usd {
                return Err(IntentsError::OverCap { usd: format!("{usd:.2}"), cap: format!("{:.2}", self.max_usd) });
            }
        }
        Ok((view, body, v))
    }

    /// Tell 1Click a deposit was sent (optional; speeds detection).
    pub async fn submit_deposit(&self, tx_hash: &str, deposit_address: &str, near_sender: Option<&str>) -> Result<Value, IntentsError> {
        let mut body = json!({ "txHash": tx_hash, "depositAddress": deposit_address });
        if let Some(s) = near_sender {
            body["nearSenderAccount"] = json!(s);
        }
        let r = self.req(self.http.post(format!("{}/v0/deposit/submit", self.base)).json(&body)).send().await.map_err(|e| IntentsError::Unreachable(e.to_string()))?;
        let status = r.status().as_u16();
        let v: Value = r.json().await.unwrap_or(Value::Null);
        if !(200..300).contains(&status) {
            return Err(IntentsError::Refused { status, message: v["message"].as_str().unwrap_or("no message").to_string() });
        }
        Ok(v)
    }

    /// Execution status of a (real) quote's deposit address.
    pub async fn execution_status(&self, deposit_address: &str) -> Result<Value, IntentsError> {
        let r = self.req(self.http.get(format!("{}/v0/status", self.base)).query(&[("depositAddress", deposit_address)])).send().await.map_err(|e| IntentsError::Unreachable(e.to_string()))?;
        let status = r.status().as_u16();
        let v: Value = r.json().await.unwrap_or(Value::Null);
        if !(200..300).contains(&status) {
            return Err(IntentsError::Refused { status, message: v["message"].as_str().unwrap_or("no message").to_string() });
        }
        Ok(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens() -> Vec<Token> {
        serde_json::from_value(json!([
            { "assetId": "nep141:wrap.near", "decimals": 24, "blockchain": "near", "symbol": "wNEAR", "price": 3.51 },
            { "assetId": "nep141:usdc.example", "decimals": 6, "blockchain": "near", "symbol": "USDC" },
            { "assetId": "nep141:eth.bridge.near", "decimals": 18, "blockchain": "eth", "symbol": "ETH" },
        ]))
        .unwrap()
    }

    fn ask(o: &str, d: &str, amount: &str) -> QuoteAsk {
        QuoteAsk { origin_asset: o.into(), destination_asset: d.into(), amount: amount.into(), recipient: None, slippage_bps: 100, destination_chain: None, deposit_type: None, recipient_type: None }
    }

    #[test]
    fn game_assets_are_refused_before_any_request() {
        for a in ["nep245:assets.contract-zero.testnet:ammo", "credits", "gun:assault_rifle"] {
            assert_eq!(validate(&ask(a, "nep141:wrap.near", "1"), &tokens()), Err(IntentsError::GameAsset(a.into())));
        }
    }

    #[test]
    fn unsupported_assets_wrong_chains_and_bad_amounts_are_refused() {
        assert_eq!(validate(&ask("nep141:nope.near", "nep141:wrap.near", "1"), &tokens()), Err(IntentsError::Unsupported("nep141:nope.near".into())));
        let mut a = ask("nep141:wrap.near", "nep141:eth.bridge.near", "10");
        a.destination_chain = Some("near".into());
        assert!(matches!(validate(&a, &tokens()), Err(IntentsError::WrongChain { .. })));
        for bad in ["", "0", "1.5", "-3", "1e9"] {
            assert_eq!(validate(&ask("nep141:wrap.near", "nep141:usdc.example", bad), &tokens()), Err(IntentsError::BadAmount), "{bad}");
        }
        assert!(validate(&ask("nep141:wrap.near", "nep141:usdc.example", "100000000000000000000000"), &tokens()).is_ok());
    }

    #[test]
    fn the_request_is_a_dry_exact_input_intents_quote() {
        let r = quote_request(&ask("nep141:wrap.near", "nep141:usdc.example", "1000"), true, chrono::DateTime::parse_from_rfc3339("2026-11-09T12:00:00Z").unwrap().with_timezone(&chrono::Utc));
        assert_eq!(r["dry"], true);
        assert_eq!(r["swapType"], "EXACT_INPUT");
        assert_eq!(r["depositType"], "INTENTS");
        assert_eq!(r["deadline"], "2026-11-09T12:00:00.000Z");
    }

    /// MOCK: the shape of a dry quote as recorded from the live API on 2026-11-09
    /// (correlation 591d308d-…); not a live call.
    #[test]
    fn a_recorded_dry_quote_parses_and_its_deadline_is_tracked() {
        let v = json!({"quote":{"amountIn":"100000000000000000000000","amountInFormatted":"0.1","amountInUsd":"0.351","minAmountIn":"100000000000000000000000","amountOut":"349037","amountOutFormatted":"0.349037","amountOutUsd":"0.3488","minAmountOut":"345546","timeEstimate":12,"refundFee":"0","withdrawFee":"0"},"quoteRequest":{"dry":true,"deadline":"2026-11-09T12:21:22.000Z","appFees":[{"recipient":"5880ad2b","fee":20}]},"signature":"ed25519:fNDu","timestamp":"2026-11-09T11:51:22.852Z","correlationId":"591d308d-8ab2-4bc0-8664-42fdb1de05c6"});
        let q = parse_quote(&v).unwrap();
        assert_eq!((q.amount_out.as_str(), q.min_amount_out.as_deref(), q.time_estimate_secs), ("349037", Some("345546"), Some(12)));
        assert!(q.dry && q.deposit_address.is_none(), "a dry quote can't be paid into");
        assert_eq!(q.app_fees[0]["fee"], 20);
        let before = chrono::DateTime::parse_from_rfc3339("2026-11-09T12:00:00Z").unwrap().with_timezone(&chrono::Utc);
        let after = chrono::DateTime::parse_from_rfc3339("2026-11-09T12:30:00Z").unwrap().with_timezone(&chrono::Utc);
        assert!(!expired(&q, before) && expired(&q, after));
    }

    #[test]
    fn a_malformed_response_is_not_shown_as_a_quote() {
        assert!(parse_quote(&json!({ "message": "tokenIn is not valid" })).is_none());
    }

    #[test]
    fn every_execution_state_has_a_meaning() {
        for s in ["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "INCOMPLETE_DEPOSIT", "PROCESSING", "SUCCESS", "REFUNDED", "FAILED"] {
            assert_ne!(status_meaning(s), "unknown state", "{s}");
        }
    }

    #[test]
    fn a_live_swap_is_a_plain_chain_transfer_with_refunds_the_same_way() {
        let mut a = ask("nep141:wrap.near", "nep141:usdc.example", "1");
        a.deposit_type = Some("ORIGIN_CHAIN".into());
        a.recipient_type = Some("DESTINATION_CHAIN".into());
        a.recipient = Some("me.near".into());
        let r = quote_request(&a, false, chrono::Utc::now());
        assert_eq!((r["depositType"].as_str(), r["refundType"].as_str(), r["recipientType"].as_str(), r["dry"].as_bool()), (Some("ORIGIN_CHAIN"), Some("ORIGIN_CHAIN"), Some("DESTINATION_CHAIN"), Some(false)));
        a.deposit_type = Some("SOMEWHERE".into());
        assert_eq!(quote_request(&a, false, chrono::Utc::now())["depositType"], "INTENTS", "unknown types fall back to the safe default");
    }

    #[tokio::test]
    async fn execution_is_refused_without_explicit_approval() {
        let c = IntentsClient { http: reqwest::Client::new(), base: "http://127.0.0.1:9".into(), api_key: None, execution_allowed: false, max_usd: 1.0, cache: Arc::new(Mutex::new(None)) };
        let r = c.quote(&ask("nep141:wrap.near", "nep141:usdc.example", "1"), true).await;
        assert_eq!(r.unwrap_err(), IntentsError::ExecutionDisabled);
    }

    #[tokio::test]
    async fn an_unreachable_service_is_reported_not_invented() {
        let c = IntentsClient { http: reqwest::Client::new(), base: "http://127.0.0.1:9".into(), api_key: None, execution_allowed: false, max_usd: 1.0, cache: Arc::new(Mutex::new(None)) };
        assert!(matches!(c.tokens().await, Err(IntentsError::Unreachable(_))));
    }
}
