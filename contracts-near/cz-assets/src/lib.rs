//! CONTRACT ZERO assets ledger (`cz-assets`).
//!
//! Every economic asset lives here as a NEP-245 multi-token: `credits`, the resources
//! `ammo`, `med`, `fuel`, and equipment tokens the owner registers (e.g. `gun:smg`).
//! This contract only keeps balances and enforces who may move them; all game logic
//! lives in the controller (`cz-world` v2), which can be upgraded without touching
//! the ledger.
//!
//! **Authority.**
//! - **Holders** move their own tokens with the standard `mt_*` calls (1 yoctoNEAR).
//! - **The controller** may mint/burn on registered actors within per-epoch issuance
//!   budgets, and settle multi-leg transfers atomically. A leg may move tokens out of
//!   a registered actor, or out of a player ONLY if that player signed the
//!   transaction (`env::signer_account_id()`, which carries through cross-contract
//!   calls), so neither the server nor a faulty controller can spend player holdings.
//! - **The owner** (a cold key) sets the controller, actors, tokens and budgets, can
//!   pause, and performs the one-time import of v1 balances.
//!
//! **Storage (NEP-145).** An account must be registered to receive tokens: either it
//! pays `storage_deposit`, or the controller registers it from an owner-funded
//! sponsorship quota.
//!
//! **Replay.** Every controller operation id is consumed once here, independently of
//! the controller's own replay set.

use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::{IterableMap, LookupMap, LookupSet};
use near_sdk::{env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearSchema, NearToken, PanicOnDefault, PromiseError, PromiseOrValue};

pub const BASE_TOKENS: [&str; 4] = ["credits", "ammo", "med", "fuel"];
/// Largest single mint, burn or transfer leg.
pub const MAX_AMOUNT: u128 = 100_000;
/// Most entries in one controller call.
pub const MAX_ENTRIES: usize = 32;
/// Issuance budgets reset on this rolling window.
pub const EPOCH_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
/// NEP-145: the storage deposit that registers an account.
pub const STORAGE_DEPOSIT: NearToken = NearToken::from_millinear(20);

const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(10);
const GAS_FOR_ON_TRANSFER: Gas = Gas::from_tgas(25);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Balances,
    Tokens,
    Actors,
    Storage,
    Used,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenInfo {
    pub title: String,
    pub description: String,
    pub supply: U128,
    /// Maximum mintable per epoch (0 = not mintable by the controller).
    pub epoch_budget: U128,
    pub minted_this_epoch: U128,
    pub epoch_started_ns: u64,
}

#[derive(Serialize, Deserialize, NearSchema, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Flow {
    pub account_id: AccountId,
    pub token_id: String,
    pub amount: U128,
}

/// One movement inside an atomic controller settlement.
#[derive(Serialize, Deserialize, NearSchema, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct Leg {
    pub from: AccountId,
    pub to: AccountId,
    pub token_id: String,
    pub amount: U128,
}

/// NEP-145.
#[derive(Serialize, Deserialize, NearSchema, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[derive(Serialize, Deserialize, NearSchema, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct StorageBalanceBounds {
    pub min: U128,
    pub max: Option<U128>,
}

/// NEP-245 metadata extension.
#[derive(Serialize, Deserialize, NearSchema, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct MtContractMetadata {
    pub spec: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, NearSchema, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct MtBaseTokenMetadata {
    pub name: String,
    pub id: String,
    pub symbol: Option<String>,
    pub icon: Option<String>,
    pub decimals: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub copies: Option<u64>,
    pub reference_hash: Option<String>,
}

#[derive(Serialize, Deserialize, NearSchema, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct MtTokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub media: Option<String>,
    pub media_hash: Option<String>,
    pub issued_at: Option<String>,
    pub expires_at: Option<String>,
    pub starts_at: Option<String>,
    pub updated_at: Option<String>,
    pub extra: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

#[derive(Serialize, Deserialize, NearSchema, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct MtTokenMetadataAll {
    pub base: MtBaseTokenMetadata,
    pub token: MtTokenMetadata,
}

#[derive(Serialize, Deserialize, NearSchema, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct Token {
    pub token_id: String,
    pub owner_id: Option<AccountId>,
}

#[ext_contract(ext_mt_receiver)]
pub trait MultiTokenReceiver {
    fn mt_on_transfer(&mut self, sender_id: AccountId, previous_owner_ids: Vec<AccountId>, token_ids: Vec<String>, amounts: Vec<U128>, msg: String) -> PromiseOrValue<Vec<U128>>;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Assets {
    owner: AccountId,
    controller: Option<AccountId>,
    paused: bool,
    balances: LookupMap<String, u128>,
    tokens: IterableMap<String, TokenInfo>,
    actors: LookupSet<AccountId>,
    /// NEP-145 registrations: account → deposited yoctoNEAR (0 = sponsored).
    storage: LookupMap<AccountId, u128>,
    sponsored_remaining: u32,
    used: LookupSet<String>,
    /// v1 import window: open until `seal_import`.
    import_open: bool,
}

fn key(token_id: &str, account: &AccountId) -> String {
    format!("{token_id}:{account}")
}

fn require_amount(amount: u128) {
    require!(amount > 0, "amount must be positive");
    require!(amount <= MAX_AMOUNT, "amount over the per-operation limit");
}

/// NEP-245 event log (one event, possibly many entries, so batches stay under the
/// 16 KB receipt log limit).
fn emit(event: &str, data: Vec<near_sdk::serde_json::Value>) {
    if data.is_empty() {
        return;
    }
    let body = near_sdk::serde_json::json!({ "standard": "nep245", "version": "1.0.0", "event": event, "data": data });
    env::log_str(&format!("EVENT_JSON:{body}"));
}

#[near]
impl Assets {
    #[init]
    pub fn new(owner: AccountId, sponsored_registrations: u32) -> Self {
        let mut a = Self {
            owner,
            controller: None,
            paused: false,
            balances: LookupMap::new(Key::Balances),
            tokens: IterableMap::new(Key::Tokens),
            actors: LookupSet::new(Key::Actors),
            storage: LookupMap::new(Key::Storage),
            sponsored_remaining: sponsored_registrations,
            used: LookupSet::new(Key::Used),
            import_open: true,
        };
        for t in BASE_TOKENS {
            a.tokens.insert(t.to_string(), TokenInfo { title: t.to_string(), description: String::new(), supply: U128(0), epoch_budget: U128(0), minted_this_epoch: U128(0), epoch_started_ns: 0 });
        }
        a
    }

    // ── owner ────────────────────────────────────────────────────────────────

    pub fn set_controller(&mut self, controller: AccountId) {
        self.only_owner();
        self.controller = Some(controller);
    }

    pub fn register_actor(&mut self, account_id: AccountId) {
        self.only_owner();
        require!(account_id != self.owner, "the owner is not an actor");
        self.actors.insert(account_id.clone());
        if !self.storage.contains_key(&account_id) {
            self.storage.insert(account_id, 0);
        }
    }

    /// Register a token (base resources exist from `new`). Equipment ids look like
    /// `gun:assault_rifle`.
    pub fn register_token(&mut self, token_id: String, title: String, description: String, epoch_budget: U128) {
        self.only_owner();
        require!(!token_id.is_empty() && token_id.len() <= 64 && token_id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b':'), "bad token id");
        require!(!self.tokens.contains_key(&token_id), "token exists");
        self.tokens.insert(token_id, TokenInfo { title, description, supply: U128(0), epoch_budget, minted_this_epoch: U128(0), epoch_started_ns: 0 });
    }

    pub fn set_epoch_budget(&mut self, token_id: String, epoch_budget: U128) {
        self.only_owner();
        let t = self.tokens.get_mut(&token_id).unwrap_or_else(|| env::panic_str("unknown token"));
        t.epoch_budget = epoch_budget;
    }

    pub fn set_sponsored_registrations(&mut self, remaining: u32) {
        self.only_owner();
        self.sponsored_remaining = remaining;
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.only_owner();
        self.paused = paused;
    }

    /// One-time import of balances snapshotted from the v1 contract. Each `op_id`
    /// applies once; the window closes for good with `seal_import`. Imported holders
    /// are registered (their v1 storage was already paid by v1).
    pub fn import_balances(&mut self, op_id: String, entries: Vec<Flow>) {
        self.only_owner();
        require!(self.import_open, "import window is sealed");
        require!(entries.len() <= MAX_ENTRIES, "too many entries");
        self.consume(format!("import:{op_id}"));
        let mut events = Vec::new();
        for f in &entries {
            self.require_token(&f.token_id);
            require!(f.amount.0 > 0, "amount must be positive");
            if !self.storage.contains_key(&f.account_id) {
                self.storage.insert(f.account_id.clone(), 0);
            }
            self.credit(&f.token_id, &f.account_id, f.amount.0);
            self.add_supply(&f.token_id, f.amount.0 as i128);
            events.push(near_sdk::serde_json::json!({ "owner_id": f.account_id, "token_ids": [f.token_id], "amounts": [f.amount], "memo": format!("import:{op_id}") }));
        }
        emit("mt_mint", events);
    }

    pub fn seal_import(&mut self) {
        self.only_owner();
        self.import_open = false;
    }

    // ── controller ───────────────────────────────────────────────────────────

    /// Register a player from the sponsorship quota so it can receive tokens.
    pub fn controller_register(&mut self, account_id: AccountId) {
        self.only_controller();
        if self.storage.contains_key(&account_id) {
            return;
        }
        require!(self.sponsored_remaining > 0, "no sponsored registrations left");
        self.sponsored_remaining -= 1;
        self.storage.insert(account_id, 0);
    }

    /// Mint (sources) and burn (sinks) on registered actors, within per-token epoch
    /// budgets. `op_id` applies once.
    pub fn controller_mint_burn(&mut self, op_id: String, mints: Vec<Flow>, burns: Vec<Flow>) {
        self.only_controller();
        self.not_paused();
        require!(mints.len() + burns.len() <= MAX_ENTRIES, "too many entries");
        require!(!mints.is_empty() || !burns.is_empty(), "empty batch");
        self.consume(format!("ctl:{op_id}"));
        let memo = format!("ctl:{op_id}");
        let entry = |f: &Flow| near_sdk::serde_json::json!({ "owner_id": f.account_id, "token_ids": [f.token_id], "amounts": [f.amount], "memo": memo });
        for f in &mints {
            self.check_actor_flow(f);
            self.spend_budget(&f.token_id, f.amount.0);
            self.credit(&f.token_id, &f.account_id, f.amount.0);
            self.add_supply(&f.token_id, f.amount.0 as i128);
        }
        for f in &burns {
            self.check_actor_flow(f);
            self.debit(&f.token_id, &f.account_id, f.amount.0);
            self.add_supply(&f.token_id, -(f.amount.0 as i128));
        }
        emit("mt_mint", mints.iter().map(entry).collect());
        emit("mt_burn", burns.iter().map(entry).collect());
    }

    /// Apply every leg or none (a panic reverts the receipt). A leg may debit a
    /// registered actor, or a player only when that player signed the transaction.
    /// Receivers must be registered. `op_id` applies once.
    pub fn controller_settle(&mut self, op_id: String, legs: Vec<Leg>) {
        self.only_controller();
        self.not_paused();
        require!(!legs.is_empty() && legs.len() <= MAX_ENTRIES, "1..=32 legs");
        self.consume(format!("ctl:{op_id}"));
        let signer = env::signer_account_id();
        let memo = format!("ctl:{op_id}");
        let mut events = Vec::new();
        for l in &legs {
            self.require_token(&l.token_id);
            require_amount(l.amount.0);
            require!(l.from != l.to, "sender and receiver are the same");
            require!(self.actors.contains(&l.from) || l.from == signer, "a leg may only debit an actor or the transaction signer");
            self.require_registered(&l.to);
            self.debit(&l.token_id, &l.from, l.amount.0);
            self.credit(&l.token_id, &l.to, l.amount.0);
            events.push(near_sdk::serde_json::json!({ "authorized_id": env::predecessor_account_id(), "old_owner_id": l.from, "new_owner_id": l.to, "token_ids": [l.token_id], "amounts": [l.amount], "memo": memo }));
        }
        emit("mt_transfer", events);
    }

    // ── NEP-145 storage ──────────────────────────────────────────────────────

    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        let _ = registration_only;
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        let deposit = env::attached_deposit();
        if let Some(&paid) = self.storage.get(&account) {
            // Already registered: refund the whole deposit.
            if !deposit.is_zero() {
                near_sdk::Promise::new(env::predecessor_account_id()).transfer(deposit).detach();
            }
            return StorageBalance { total: U128(paid.max(STORAGE_DEPOSIT.as_yoctonear())), available: U128(0) };
        }
        require!(deposit >= STORAGE_DEPOSIT, "attach at least the minimum storage deposit");
        let refund = deposit.saturating_sub(STORAGE_DEPOSIT);
        if !refund.is_zero() {
            near_sdk::Promise::new(env::predecessor_account_id()).transfer(refund).detach();
        }
        self.storage.insert(account, STORAGE_DEPOSIT.as_yoctonear());
        StorageBalance { total: U128(STORAGE_DEPOSIT.as_yoctonear()), available: U128(0) }
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.storage.get(&account_id).map(|_| StorageBalance { total: U128(STORAGE_DEPOSIT.as_yoctonear()), available: U128(0) })
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds { min: U128(STORAGE_DEPOSIT.as_yoctonear()), max: Some(U128(STORAGE_DEPOSIT.as_yoctonear())) }
    }

    // ── NEP-245 views ────────────────────────────────────────────────────────

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(self.bal(&token_id, &account_id))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids.iter().map(|t| U128(self.bal(t, &account_id))).collect()
    }

    pub fn mt_supply(&self, token_id: String) -> Option<U128> {
        self.tokens.get(&token_id).map(|t| t.supply)
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<String>) -> Vec<Option<U128>> {
        token_ids.into_iter().map(|t| self.mt_supply(t)).collect()
    }

    pub fn mt_token(&self, token_ids: Vec<String>) -> Vec<Option<Token>> {
        token_ids.into_iter().map(|t| self.tokens.contains_key(&t).then(|| Token { token_id: t, owner_id: None })).collect()
    }

    pub fn mt_metadata_contract(&self) -> MtContractMetadata {
        MtContractMetadata { spec: "mt-1.0.0".into(), name: "CONTRACT ZERO Assets".into() }
    }

    pub fn mt_metadata_token_all(&self, token_ids: Vec<String>) -> Vec<Option<MtTokenMetadataAll>> {
        token_ids
            .into_iter()
            .map(|id| {
                self.tokens.get(&id).map(|t| MtTokenMetadataAll {
                    base: MtBaseTokenMetadata { name: t.title.clone(), id: id.clone(), symbol: Some(id.to_uppercase()), icon: None, decimals: Some("0".into()), base_uri: None, reference: None, copies: None, reference_hash: None },
                    token: MtTokenMetadata { title: Some(t.title.clone()), description: Some(t.description.clone()), media: None, media_hash: None, issued_at: None, expires_at: None, starts_at: None, updated_at: None, extra: None, reference: None, reference_hash: None },
                })
            })
            .collect()
    }

    pub fn token_info(&self, token_id: String) -> Option<TokenInfo> {
        self.tokens.get(&token_id).cloned()
    }

    pub fn tokens(&self) -> Vec<String> {
        self.tokens.keys().cloned().collect()
    }

    pub fn controller(&self) -> Option<AccountId> {
        self.controller.clone()
    }

    pub fn owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn is_actor(&self, account_id: AccountId) -> bool {
        self.actors.contains(&account_id)
    }

    pub fn is_used(&self, op_id: String) -> bool {
        self.used.contains(&op_id)
    }

    pub fn sponsored_remaining(&self) -> u32 {
        self.sponsored_remaining
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    // ── NEP-245 transfers (holders, 1 yoctoNEAR) ─────────────────────────────

    #[payable]
    pub fn mt_transfer(&mut self, receiver_id: AccountId, token_id: String, amount: U128, approval: Option<(AccountId, u64)>, memo: Option<String>) {
        near_sdk::assert_one_yocto();
        self.not_paused();
        require!(approval.is_none(), "approvals are not supported");
        let sender = env::predecessor_account_id();
        self.move_tokens(&token_id, &sender, &receiver_id, amount.0, memo.as_deref());
    }

    #[payable]
    pub fn mt_batch_transfer(&mut self, receiver_id: AccountId, token_ids: Vec<String>, amounts: Vec<U128>, approvals: Option<Vec<Option<(AccountId, u64)>>>, memo: Option<String>) {
        near_sdk::assert_one_yocto();
        self.not_paused();
        require!(approvals.is_none(), "approvals are not supported");
        require!(!token_ids.is_empty() && token_ids.len() == amounts.len(), "token_ids and amounts must be non-empty and the same length");
        let sender = env::predecessor_account_id();
        for (t, a) in token_ids.iter().zip(&amounts) {
            self.move_tokens(t, &sender, &receiver_id, a.0, memo.as_deref());
        }
    }

    #[payable]
    pub fn mt_transfer_call(&mut self, receiver_id: AccountId, token_id: String, amount: U128, approval: Option<(AccountId, u64)>, memo: Option<String>, msg: String) -> PromiseOrValue<Vec<U128>> {
        self.mt_batch_transfer_call(receiver_id, vec![token_id], vec![amount], approval.map(|a| vec![Some(a)]), memo, msg)
    }

    #[payable]
    pub fn mt_batch_transfer_call(&mut self, receiver_id: AccountId, token_ids: Vec<String>, amounts: Vec<U128>, approvals: Option<Vec<Option<(AccountId, u64)>>>, memo: Option<String>, msg: String) -> PromiseOrValue<Vec<U128>> {
        near_sdk::assert_one_yocto();
        self.not_paused();
        require!(approvals.is_none(), "approvals are not supported");
        require!(!token_ids.is_empty() && token_ids.len() == amounts.len(), "token_ids and amounts must be non-empty and the same length");
        require!(env::prepaid_gas() > GAS_FOR_ON_TRANSFER.saturating_add(GAS_FOR_RESOLVE).saturating_add(Gas::from_tgas(10)), "attach more gas");
        let sender = env::predecessor_account_id();
        for (t, a) in token_ids.iter().zip(&amounts) {
            self.move_tokens(t, &sender, &receiver_id, a.0, memo.as_deref());
        }
        let previous = vec![sender.clone(); token_ids.len()];
        ext_mt_receiver::ext(receiver_id.clone())
            .with_static_gas(GAS_FOR_ON_TRANSFER)
            .mt_on_transfer(sender, previous.clone(), token_ids.clone(), amounts.clone(), msg)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_FOR_RESOLVE).mt_resolve_transfer(previous, receiver_id, token_ids, amounts))
            .into()
    }

    /// Refunds what the receiver returned as unused (everything if it failed), capped
    /// by what it still holds. Returns what the receiver kept.
    #[private]
    pub fn mt_resolve_transfer(&mut self, previous_owner_ids: Vec<AccountId>, receiver_id: AccountId, token_ids: Vec<String>, amounts: Vec<U128>) -> Vec<U128> {
        let unused: Vec<U128> = match env::promise_result_checked(0, 4_096) {
            Ok(v) => near_sdk::serde_json::from_slice::<Vec<U128>>(&v).ok().filter(|u| u.len() == amounts.len()).unwrap_or_else(|| amounts.clone()),
            Err(PromiseError::Failed) | Err(_) => amounts.clone(),
        };
        let mut kept = Vec::with_capacity(amounts.len());
        for i in 0..amounts.len() {
            let refund = unused[i].0.min(amounts[i].0).min(self.bal(&token_ids[i], &receiver_id));
            if refund > 0 {
                self.move_tokens(&token_ids[i], &receiver_id, &previous_owner_ids[i], refund, Some("refund"));
            }
            kept.push(U128(amounts[i].0 - refund));
        }
        kept
    }
}

// ── internals ────────────────────────────────────────────────────────────────

impl Assets {
    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can do this");
    }

    fn only_controller(&self) {
        require!(Some(env::predecessor_account_id()) == self.controller, "only the controller can do this");
    }

    fn not_paused(&self) {
        require!(!self.paused, "the ledger is paused");
    }

    fn require_token(&self, token_id: &str) {
        require!(self.tokens.contains_key(token_id), "unknown token");
    }

    fn require_registered(&self, account: &AccountId) {
        require!(self.storage.contains_key(account), "receiver is not registered (NEP-145 storage_deposit)");
    }

    fn check_actor_flow(&self, f: &Flow) {
        self.require_token(&f.token_id);
        require_amount(f.amount.0);
        require!(self.actors.contains(&f.account_id), "mints and burns apply only to registered actors");
    }

    /// Spend `amount` of the token's rolling epoch issuance budget.
    fn spend_budget(&mut self, token_id: &str, amount: u128) {
        let now = env::block_timestamp();
        let t = self.tokens.get_mut(token_id).unwrap();
        if now.saturating_sub(t.epoch_started_ns) >= EPOCH_NS {
            t.epoch_started_ns = now;
            t.minted_this_epoch = U128(0);
        }
        let used = t.minted_this_epoch.0 + amount;
        require!(used <= t.epoch_budget.0, "epoch issuance budget exceeded");
        t.minted_this_epoch = U128(used);
    }

    fn consume(&mut self, op_id: String) {
        require!(self.used.insert(op_id), "operation already applied");
    }

    fn bal(&self, token_id: &str, account: &AccountId) -> u128 {
        self.balances.get(&key(token_id, account)).copied().unwrap_or(0)
    }

    fn credit(&mut self, token_id: &str, account: &AccountId, amount: u128) {
        let k = key(token_id, account);
        let v = self.balances.get(&k).copied().unwrap_or(0).checked_add(amount).unwrap_or_else(|| env::panic_str("overflow"));
        self.balances.insert(k, v);
    }

    fn debit(&mut self, token_id: &str, account: &AccountId, amount: u128) {
        let k = key(token_id, account);
        let have = self.balances.get(&k).copied().unwrap_or(0);
        require!(have >= amount, "insufficient balance");
        self.balances.insert(k, have - amount);
    }

    fn add_supply(&mut self, token_id: &str, delta: i128) {
        let t = self.tokens.get_mut(token_id).unwrap();
        let s = t.supply.0 as i128 + delta;
        require!(s >= 0, "supply underflow");
        t.supply = U128(s as u128);
    }

    fn move_tokens(&mut self, token_id: &str, from: &AccountId, to: &AccountId, amount: u128, memo: Option<&str>) {
        self.require_token(token_id);
        require!(amount > 0, "amount must be positive");
        require!(from != to, "sender and receiver are the same");
        self.require_registered(to);
        self.debit(token_id, from, amount);
        self.credit(token_id, to, amount);
        emit("mt_transfer", vec![near_sdk::serde_json::json!({ "old_owner_id": from, "new_owner_id": to, "token_ids": [token_id], "amounts": [U128(amount)], "memo": memo })]);
    }
}

#[cfg(test)]
mod tests;
