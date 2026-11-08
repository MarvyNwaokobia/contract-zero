//! NEAR testnet client for the game controller (cz-world v2, `CZ_WORLD`) and the
//! NEP-245 ledger it controls (cz-assets, `CZ_ASSETS`).
//!
//! Each economic actor signs with its own key, loaded from files OUTSIDE the
//! repository (`CZ_KEYS_DIR`, default `~/.contract-zero/keys/v2`). Those keys are
//! function-call keys restricted to the controller and to that actor's methods,
//! so the server process never holds an agent's full-access key and no model ever
//! touches a key at all.
//!
//! A transaction counts as settled only after [`NearClient::verify`] has fetched it
//! from RPC at FINAL, independently of the submitting library, and confirmed that the
//! transaction and every receipt succeeded.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use near_api::types::{AccountId, NearGas, NearToken};
use near_api::{Contract, Signer};
use serde_json::{json, Value};
use tokio::sync::Mutex;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Role {
    Server,
    Vanguard,
    Vex,
}

impl Role {
    pub fn env_key(self) -> &'static str {
        match self {
            Role::Server => "CZ_SERVER_ACCOUNT",
            Role::Vanguard => "CZ_VANGUARD_ACCOUNT",
            Role::Vex => "CZ_VEX_ACCOUNT",
        }
    }
    pub fn for_actor(actor: &str) -> Option<Role> {
        match actor {
            "vanguard" => Some(Role::Vanguard),
            "vex" => Some(Role::Vex),
            _ => None,
        }
    }
}

/// What was verified about a settled transaction.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Verified {
    pub tx_hash: String,
    pub signer: String,
    pub method: String,
    pub receipts: usize,
    pub events: Vec<Value>,
    pub explorer: String,
}

pub struct NearClient {
    /// The game controller (cz-world v2) that agent and server calls go to.
    pub contract: AccountId,
    /// The NEP-245 ledger (cz-assets) that balances are read from.
    pub assets: AccountId,
    rpc_url: String,
    accounts: HashMap<Role, AccountId>,
    signers: HashMap<Role, Arc<Signer>>,
    http: reqwest::Client,
    /// One transaction at a time per signer keeps nonces in order.
    locks: HashMap<Role, Arc<Mutex<()>>>,
}

pub fn explorer_tx(hash: &str) -> String {
    format!("https://testnet.nearblocks.io/txns/{hash}")
}

impl NearClient {
    /// `None` (settlement disabled) unless the contract, every account and every key
    /// file are configured.
    pub fn from_env() -> Result<Option<Self>, String> {
        let Ok(contract) = std::env::var("CZ_WORLD") else {
            if std::env::var("CZ_CONTRACT").is_ok() {
                return Err("CZ_CONTRACT names the frozen v1 contract; set CZ_WORLD and CZ_ASSETS (see .env.example)".into());
            }
            return Ok(None);
        };
        let contract: AccountId = contract.parse().map_err(|e| format!("CZ_WORLD: {e}"))?;
        let assets: AccountId = std::env::var("CZ_ASSETS").map_err(|_| "CZ_ASSETS is not set".to_string())?.parse().map_err(|e| format!("CZ_ASSETS: {e}"))?;
        let keys_dir = std::env::var("CZ_KEYS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".contract-zero/keys/v2"));
        let mut accounts = HashMap::new();
        let mut signers = HashMap::new();
        let mut locks = HashMap::new();
        for role in [Role::Server, Role::Vanguard, Role::Vex] {
            let id: AccountId = std::env::var(role.env_key())
                .map_err(|_| format!("{} is not set", role.env_key()))?
                .parse()
                .map_err(|e| format!("{}: {e}", role.env_key()))?;
            let file = keys_dir.join(format!("{id}.json"));
            let signer = Signer::from_access_keyfile(file.clone()).map_err(|e| format!("key for {id} ({}): {e}", file.display()))?;
            accounts.insert(role, id);
            signers.insert(role, signer);
            locks.insert(role, Arc::new(Mutex::new(())));
        }
        let rpc_url = std::env::var("NEAR_RPC_URL").unwrap_or_else(|_| "https://rpc.testnet.fastnear.com".into());
        Ok(Some(Self { contract, assets, rpc_url, accounts, signers, http: reqwest::Client::new(), locks }))
    }

    pub fn account(&self, role: Role) -> &AccountId {
        &self.accounts[&role]
    }

    /// Sign and send one call as `role`, then verify it independently.
    pub async fn call(&self, role: Role, method: &str, args: Value, deposit_yocto: u128) -> Result<Verified, String> {
        let _guard = self.locks[&role].lock().await;
        let signer_id = self.accounts[&role].clone();
        let result = Contract(self.contract.clone())
            .call_function(method, args)
            .transaction()
            .gas(NearGas::from_tgas(100))
            .deposit(NearToken::from_yoctonear(deposit_yocto))
            .with_signer(signer_id.clone(), self.signers[&role].clone())
            .send_to_testnet()
            .await
            .map_err(|e| format!("{method}: send failed: {e}"))?;
        let full = result.into_full().ok_or_else(|| format!("{method}: transaction still pending"))?;
        let hash = full
            .outcomes()
            .first()
            .map(|o| o.transaction_hash.to_string())
            .ok_or_else(|| format!("{method}: no transaction outcome"))?;
        if let Err(e) = full.into_result() {
            return Err(format!("{method}: transaction {hash} failed: {e:?}"));
        }
        self.verify(&hash, &signer_id, method).await
    }

    /// Fetch the transaction at FINAL from RPC and check the transaction and every
    /// receipt succeeded. Returns the NEP-245 events it emitted.
    pub async fn verify(&self, tx_hash: &str, signer: &AccountId, method: &str) -> Result<Verified, String> {
        let body = json!({
            "jsonrpc": "2.0", "id": "cz", "method": "tx",
            "params": { "tx_hash": tx_hash, "sender_account_id": signer.to_string(), "wait_until": "FINAL" },
        });
        let mut last_err = String::new();
        for _ in 0..10 {
            let resp: Value = self.http.post(&self.rpc_url).json(&body).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
            if let Some(err) = resp.get("error") {
                last_err = err.to_string();
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                continue;
            }
            let r = &resp["result"];
            let Some(value) = r["status"].get("SuccessValue").and_then(|v| v.as_str()) else {
                return Err(format!("{tx_hash}: final status is not success: {}", r["status"]));
            };
            // cz-world v2 settlement calls end in a callback that returns false when the
            // ledger refused the operation; that is a failure even though the
            // transaction itself completed.
            if base64_decode(value).as_deref() == Some(b"false".as_slice()) {
                return Err(format!("{tx_hash}: the ledger refused the operation (callback returned false)"));
            }
            let receipts = r["receipts_outcome"].as_array().cloned().unwrap_or_default();
            for rc in &receipts {
                if rc["outcome"]["status"].get("Failure").is_some() {
                    return Err(format!("{tx_hash}: a receipt failed: {}", rc["outcome"]["status"]));
                }
            }
            let events: Vec<Value> = receipts
                .iter()
                .flat_map(|rc| rc["outcome"]["logs"].as_array().cloned().unwrap_or_default())
                .filter_map(|l| l.as_str().and_then(|s| s.strip_prefix("EVENT_JSON:")).and_then(|s| serde_json::from_str(s).ok()))
                .collect();
            return Ok(Verified { tx_hash: tx_hash.into(), signer: signer.to_string(), method: method.into(), receipts: receipts.len(), events, explorer: explorer_tx(tx_hash) });
        }
        Err(format!("{tx_hash}: could not fetch final outcome: {last_err}"))
    }

    /// Call a view method on the controller.
    pub async fn view(&self, method: &str, args: Value) -> Result<Value, String> {
        self.view_on(&self.contract.to_string(), method, args).await
    }

    /// Call a view method on the ledger.
    pub async fn view_assets(&self, method: &str, args: Value) -> Result<Value, String> {
        self.view_on(&self.assets.to_string(), method, args).await
    }

    async fn view_on(&self, contract: &str, method: &str, args: Value) -> Result<Value, String> {
        let b64 = base64_encode(&serde_json::to_vec(&args).unwrap());
        let body = json!({
            "jsonrpc": "2.0", "id": "cz", "method": "query",
            "params": { "request_type": "call_function", "finality": "final", "account_id": contract, "method_name": method, "args_base64": b64 },
        });
        let resp: Value = self.http.post(&self.rpc_url).json(&body).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
        let bytes: Vec<u8> = resp["result"]["result"]
            .as_array()
            .ok_or_else(|| format!("{method}: {}", resp.get("error").or(resp["result"].get("error")).unwrap_or(&resp)))?
            .iter()
            .map(|b| b.as_u64().unwrap_or(0) as u8)
            .collect();
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())
    }

    /// Balances of one account for every token.
    pub async fn balances(&self, account: &str) -> Result<HashMap<String, i64>, String> {
        let tokens = ["credits", "ammo", "med", "fuel"];
        let v = self.view_assets("mt_batch_balance_of", json!({ "account_id": account, "token_ids": tokens })).await?;
        let arr = v.as_array().ok_or("bad balance response")?;
        Ok(tokens.iter().zip(arr).map(|(t, a)| (t.to_string(), a.as_str().and_then(|s| s.parse().ok()).unwrap_or(0))).collect())
    }
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut buf = 0u32;
    let mut bits = 0;
    for c in s.bytes().filter(|&c| c != b'=') {
        buf = buf << 6 | T.iter().position(|&t| t == c)? as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Some(out)
}

fn base64_encode(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn base64_matches_the_standard_alphabet() {
        assert_eq!(super::base64_encode(b"{}"), "e30=");
        assert_eq!(super::base64_encode(b"abc"), "YWJj");
        assert_eq!(super::base64_encode(b"ab"), "YWI=");
        for s in [&b"false"[..], b"true", b"{}", b"abc"] {
            assert_eq!(super::base64_decode(&super::base64_encode(s)).unwrap(), s);
        }
        assert_eq!(super::base64_decode("ZmFsc2U=").unwrap(), b"false");
    }
}
