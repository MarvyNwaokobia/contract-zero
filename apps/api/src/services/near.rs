//! NEAR testnet client for CZ World.
//!
//! Each economic actor signs with its own key, loaded from files OUTSIDE the
//! repository (`CZ_KEYS_DIR`, default `~/.contract-zero/keys`). Those keys are
//! function-call keys restricted to the CZ World contract and to that actor's methods,
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
    pub contract: AccountId,
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
        let Ok(contract) = std::env::var("CZ_CONTRACT") else { return Ok(None) };
        let contract: AccountId = contract.parse().map_err(|e| format!("CZ_CONTRACT: {e}"))?;
        let keys_dir = std::env::var("CZ_KEYS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".contract-zero/keys"));
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
        let rpc_url = std::env::var("NEAR_RPC_URL").unwrap_or_else(|_| "https://rpc.testnet.near.org".into());
        Ok(Some(Self { contract, rpc_url, accounts, signers, http: reqwest::Client::new(), locks }))
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
            if r["status"].get("SuccessValue").is_none() {
                return Err(format!("{tx_hash}: final status is not success: {}", r["status"]));
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

    /// Call a view method over RPC.
    pub async fn view(&self, method: &str, args: Value) -> Result<Value, String> {
        let b64 = base64_encode(&serde_json::to_vec(&args).unwrap());
        let body = json!({
            "jsonrpc": "2.0", "id": "cz", "method": "query",
            "params": { "request_type": "call_function", "finality": "final", "account_id": self.contract.to_string(), "method_name": method, "args_base64": b64 },
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
        let v = self.view("mt_batch_balance_of", json!({ "account_id": account, "token_ids": tokens })).await?;
        let arr = v.as_array().ok_or("bad balance response")?;
        Ok(tokens.iter().zip(arr).map(|(t, a)| (t.to_string(), a.as_str().and_then(|s| s.parse().ok()).unwrap_or(0))).collect())
    }
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
    }
}
