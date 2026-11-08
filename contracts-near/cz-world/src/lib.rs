//! CONTRACT ZERO settlement contract ("CZ World").
//!
//! One contract holds every economic asset as a NEP-245 multi-token (`credits`,
//! `ammo`, `med`, `fuel`) and settles the transactions that matter:
//!
//! - **Agent trades** (`post_offer` / `accept_offer`): the merchant publishes a priced
//!   offer to a named buyer; the buyer accepts it with a price ceiling. Each side signs
//!   with its own account, and the swap is atomic inside one receipt.
//! - **Raid settlement** (`settle_raid`): the game server moves a validated raid's
//!   cargo from the faction to the player (and pays any sponsor's bounty).
//! - **Issuance and destruction** (`apply_flows`): the game server mirrors the
//!   economy's sources and sinks as bounded, batched mints and burns on actor accounts.
//! - **NEP-245 core**: `mt_transfer`, `mt_batch_transfer`, `mt_transfer_call`,
//!   `mt_batch_transfer_call` (each requires exactly 1 yoctoNEAR) and the views
//!   `mt_balance_of`, `mt_batch_balance_of`, `mt_supply`, `mt_batch_supply`, `mt_token`.
//!
//! **Authorization.** Only the owner (game server) settles raids, applies flows and
//! registers accounts. Only a registered merchant posts offers; only the named buyer
//! accepts. Agent methods take no deposit, so agents run on function-call keys
//! restricted to this contract; NEP-245 transfers need 1 yoctoNEAR, which a
//! function-call key cannot attach, so a leaked agent key cannot move tokens directly.
//!
//! **Replay protection.** Every operation id (raid, flow batch, offer) is consumed once.
//!
//! **Storage.** The contract pays for its own storage. To keep that bounded, tokens can
//! only be held by registered accounts (actors, and players the server registers when
//! they first receive cargo), and mints and burns are capped per entry and per batch.

use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearSchema, PanicOnDefault, PromiseError, PromiseOrValue};

pub const TOKENS: [&str; 4] = ["credits", "ammo", "med", "fuel"];
/// Raw storage key of the migration freeze flag (outside the borsh state).
const FROZEN_KEY: &[u8] = b"__frozen";
/// Largest single mint, burn or raid settlement.
pub const MAX_AMOUNT: u128 = 100_000;
/// Most entries in one `apply_flows` batch (mints + burns).
pub const MAX_FLOWS: usize = 32;
/// Total supply ceiling per token.
pub const MAX_SUPPLY: u128 = 100_000_000;
/// Offer lifetime bounds.
pub const MAX_OFFER_TTL_SECS: u32 = 3_600;

const GAS_FOR_RESOLVE: Gas = Gas::from_tgas(10);
const GAS_FOR_ON_TRANSFER: Gas = Gas::from_tgas(25);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Balances,
    Supply,
    Roles,
    Holders,
    Offers,
    Used,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Faction,
    Merchant,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Offer {
    pub seller: AccountId,
    pub buyer: AccountId,
    pub token_id: String,
    pub amount: U128,
    pub total_credits: U128,
    pub expires_at_ns: u64,
}

#[derive(Serialize, Deserialize, NearSchema, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct Flow {
    pub account_id: AccountId,
    pub token_id: String,
    pub amount: U128,
}

/// NEP-245 `Token` (fungible-style tokens have no single owner).
#[derive(Serialize, Deserialize, NearSchema, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct Token {
    pub token_id: String,
    pub owner_id: Option<AccountId>,
}

#[ext_contract(ext_mt_receiver)]
pub trait MultiTokenReceiver {
    fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>>;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct World {
    /// The game server: settles raids, applies flows, registers accounts.
    owner: AccountId,
    balances: LookupMap<String, u128>,
    supply: LookupMap<String, u128>,
    roles: LookupMap<AccountId, Role>,
    /// Accounts allowed to hold tokens (actors and registered players).
    holders: LookupSet<AccountId>,
    offers: LookupMap<String, Offer>,
    /// Every operation id ever consumed ("raid:7", "flows:42", "offer:…").
    used: LookupSet<String>,
}

fn key(token_id: &str, account: &AccountId) -> String {
    format!("{token_id}:{account}")
}

fn require_token(token_id: &str) {
    require!(TOKENS.contains(&token_id), "unknown token");
}

fn require_amount(amount: u128) {
    require!(amount > 0, "amount must be positive");
    require!(amount <= MAX_AMOUNT, "amount over the per-operation limit");
}

/// NEP-245 event log with one or more data entries. A receipt's logs are capped at
/// 16 KB, so batched operations emit ONE event carrying all their entries.
fn emit_all(event: &str, data: Vec<near_sdk::serde_json::Value>) {
    if data.is_empty() {
        return;
    }
    let body = near_sdk::serde_json::json!({ "standard": "nep245", "version": "1.0.0", "event": event, "data": data });
    env::log_str(&format!("EVENT_JSON:{body}"));
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    emit_all(event, vec![data]);
}

#[near]
impl World {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            balances: LookupMap::new(Key::Balances),
            supply: LookupMap::new(Key::Supply),
            roles: LookupMap::new(Key::Roles),
            holders: LookupSet::new(Key::Holders),
            offers: LookupMap::new(Key::Offers),
            used: LookupSet::new(Key::Used),
        }
    }

    // ── administration (owner) ───────────────────────────────────────────────

    pub fn register_actor(&mut self, account_id: AccountId, role: Role) {
        self.require_live();
        self.only_owner();
        require!(account_id != self.owner && account_id != env::current_account_id(), "the server and the contract are not actors");
        self.roles.insert(account_id.clone(), role);
        self.holders.insert(account_id);
    }

    /// Allow a player account to hold tokens (the server does this before paying one).
    pub fn register_player(&mut self, account_id: AccountId) {
        self.require_live();
        self.only_owner();
        require!(self.roles.get(&account_id).is_none(), "actors are not players");
        self.holders.insert(account_id);
    }

    pub fn role_of(&self, account_id: AccountId) -> Option<Role> {
        self.roles.get(&account_id).copied()
    }

    pub fn is_holder(&self, account_id: AccountId) -> bool {
        self.holders.contains(&account_id)
    }

    pub fn owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn is_used(&self, op_id: String) -> bool {
        self.used.contains(&op_id)
    }

    pub fn storage_usage(&self) -> u64 {
        env::storage_usage()
    }

    /// Retire this contract after migrating to cz-assets + cz-world v2: every
    /// value-moving method is refused from now on, so the old and new contracts can
    /// never settle the same economic event. Stored as a raw flag so the state layout
    /// (and therefore every balance) is untouched by this upgrade. Irreversible.
    pub fn freeze(&mut self) {
        self.only_owner();
        env::storage_write(FROZEN_KEY, &[1]);
        env::log_str("frozen: migrated to cz-assets + cz-world v2");
    }

    pub fn is_frozen(&self) -> bool {
        env::storage_has_key(FROZEN_KEY)
    }

    // ── NEP-245 views ────────────────────────────────────────────────────────

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(self.bal(&token_id, &account_id))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids.iter().map(|t| U128(self.bal(t, &account_id))).collect()
    }

    pub fn mt_supply(&self, token_id: String) -> Option<U128> {
        TOKENS.contains(&token_id.as_str()).then(|| U128(self.supply.get(&token_id).copied().unwrap_or(0)))
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<String>) -> Vec<Option<U128>> {
        token_ids.into_iter().map(|t| self.mt_supply(t)).collect()
    }

    pub fn mt_token(&self, token_ids: Vec<String>) -> Vec<Option<Token>> {
        token_ids
            .into_iter()
            .map(|t| TOKENS.contains(&t.as_str()).then(|| Token { token_id: t, owner_id: None }))
            .collect()
    }

    // ── NEP-245 transfers (1 yoctoNEAR each) ─────────────────────────────────

    #[payable]
    pub fn mt_transfer(&mut self, receiver_id: AccountId, token_id: String, amount: U128, approval: Option<(AccountId, u64)>, memo: Option<String>) {
        self.require_live();
        near_sdk::assert_one_yocto();
        require!(approval.is_none(), "approvals are not supported");
        let sender = env::predecessor_account_id();
        self.require_holder(&receiver_id);
        self.move_tokens(&token_id, &sender, &receiver_id, amount.0, memo.as_deref());
    }

    #[payable]
    pub fn mt_batch_transfer(&mut self, receiver_id: AccountId, token_ids: Vec<String>, amounts: Vec<U128>, approvals: Option<Vec<Option<(AccountId, u64)>>>, memo: Option<String>) {
        self.require_live();
        near_sdk::assert_one_yocto();
        require!(approvals.is_none(), "approvals are not supported");
        require!(!token_ids.is_empty() && token_ids.len() == amounts.len(), "token_ids and amounts must be non-empty and the same length");
        let sender = env::predecessor_account_id();
        self.require_holder(&receiver_id);
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
        self.require_live();
        near_sdk::assert_one_yocto();
        require!(approvals.is_none(), "approvals are not supported");
        require!(!token_ids.is_empty() && token_ids.len() == amounts.len(), "token_ids and amounts must be non-empty and the same length");
        require!(env::prepaid_gas() > GAS_FOR_ON_TRANSFER.saturating_add(GAS_FOR_RESOLVE).saturating_add(Gas::from_tgas(10)), "attach more gas");
        let sender = env::predecessor_account_id();
        self.require_holder(&receiver_id);
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

    /// Settles a `*_transfer_call`: refunds whatever the receiver returned as unused
    /// (everything, if the receiver failed), capped by what the receiver still holds.
    /// Returns the amounts finally kept by the receiver.
    #[private]
    pub fn mt_resolve_transfer(&mut self, previous_owner_ids: Vec<AccountId>, receiver_id: AccountId, token_ids: Vec<String>, amounts: Vec<U128>) -> Vec<U128> {
        let unused: Vec<U128> = match env::promise_result_checked(0, 4_096) {
            Ok(v) => near_sdk::serde_json::from_slice::<Vec<U128>>(&v)
                .ok()
                .filter(|u| u.len() == amounts.len())
                .unwrap_or_else(|| amounts.clone()),
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

    // ── game settlement (owner = game server) ────────────────────────────────

    /// Mint (sources) and burn (sinks) mirroring a batch of the economy's issuance and
    /// destruction. Only on registered actors, bounded per entry, per batch and per
    /// token supply, and each `batch_id` applies once.
    pub fn apply_flows(&mut self, batch_id: String, mints: Vec<Flow>, burns: Vec<Flow>) {
        self.require_live();
        self.only_owner();
        require!(mints.len() + burns.len() <= MAX_FLOWS, "too many flows in one batch");
        require!(!mints.is_empty() || !burns.is_empty(), "empty batch");
        self.consume(format!("flows:{batch_id}"));
        let memo = format!("flows:{batch_id}");
        let entry = |f: &Flow| near_sdk::serde_json::json!({ "owner_id": f.account_id, "token_ids": [f.token_id], "amounts": [f.amount], "memo": memo });
        for f in &mints {
            self.check_flow(f);
            self.credit(&f.token_id, &f.account_id, f.amount.0);
            self.add_supply(&f.token_id, f.amount.0 as i128);
        }
        for f in &burns {
            self.check_flow(f);
            self.debit(&f.token_id, &f.account_id, f.amount.0);
            self.add_supply(&f.token_id, -(f.amount.0 as i128));
        }
        emit_all("mt_mint", mints.iter().map(entry).collect());
        emit_all("mt_burn", burns.iter().map(entry).collect());
    }

    /// Move a validated raid's cargo from the faction to the player, and pay the
    /// sponsor's bounty if there is one. Once per raid; the player is registered as a
    /// holder if it was not already.
    pub fn settle_raid(&mut self, raid_id: String, faction: AccountId, player: AccountId, token_id: String, amount: U128, bounty: Option<(AccountId, U128)>) {
        self.require_live();
        self.only_owner();
        require!(self.roles.get(&faction) == Some(&Role::Faction), "target is not a registered faction");
        require!(self.roles.get(&player).is_none(), "the receiver of raid cargo must be a player, not an actor");
        require!(player != self.owner && player != env::current_account_id(), "invalid player");
        require!(token_id != "credits", "raids move resources, not credits");
        require_amount(amount.0);
        self.consume(format!("raid:{raid_id}"));
        self.holders.insert(player.clone());
        let memo = format!("raid:{raid_id}");
        self.move_tokens(&token_id, &faction, &player, amount.0, Some(&memo));
        if let Some((sponsor, credits)) = bounty {
            require!(self.roles.get(&sponsor).is_some(), "the bounty sponsor must be a registered actor");
            require_amount(credits.0);
            self.move_tokens("credits", &sponsor, &player, credits.0, Some(&memo));
        }
    }

    // ── agent trades (no deposit: restricted function-call keys) ─────────────

    /// The merchant offers `amount` of `token_id` to `buyer` for `total_credits`. The
    /// merchant must hold the goods now; the offer expires after `ttl_secs`.
    pub fn post_offer(&mut self, offer_id: String, buyer: AccountId, token_id: String, amount: U128, total_credits: U128, ttl_secs: u32) {
        self.require_live();
        let seller = env::predecessor_account_id();
        require!(self.roles.get(&seller) == Some(&Role::Merchant), "only a registered merchant posts offers");
        require!(buyer != seller, "cannot sell to yourself");
        self.require_holder(&buyer);
        require_token(&token_id);
        require!(token_id != "credits", "credits are the payment, not the goods");
        require_amount(amount.0);
        require!(total_credits.0 > 0 && total_credits.0 <= MAX_AMOUNT * 100, "price out of range");
        require!((1..=MAX_OFFER_TTL_SECS).contains(&ttl_secs), "ttl out of range");
        require!(self.bal(&token_id, &seller) >= amount.0, "merchant does not hold the goods");
        require!(!self.offers.contains_key(&offer_id) && !self.used.contains(&format!("offer:{offer_id}")), "offer id already used");
        let expires_at_ns = env::block_timestamp() + (ttl_secs as u64) * 1_000_000_000;
        self.offers.insert(offer_id, Offer { seller, buyer, token_id, amount, total_credits, expires_at_ns });
    }

    pub fn get_offer(&self, offer_id: String) -> Option<Offer> {
        self.offers.get(&offer_id).cloned()
    }

    /// The named buyer accepts, paying at most `max_total` credits: goods to the buyer,
    /// credits to the merchant, in one receipt. Either both legs happen or neither does.
    pub fn accept_offer(&mut self, offer_id: String, max_total: U128) {
        self.require_live();
        let buyer = env::predecessor_account_id();
        let offer = self.offers.get(&offer_id).cloned().unwrap_or_else(|| env::panic_str("no such offer"));
        require!(offer.buyer == buyer, "this offer is for another buyer");
        require!(env::block_timestamp() <= offer.expires_at_ns, "offer expired");
        require!(offer.total_credits.0 <= max_total.0, "price is above the buyer's limit");
        // Check both legs before moving either.
        require!(self.bal("credits", &buyer) >= offer.total_credits.0, "buyer cannot pay");
        require!(self.bal(&offer.token_id, &offer.seller) >= offer.amount.0, "merchant no longer holds the goods");
        self.consume(format!("offer:{offer_id}"));
        self.offers.remove(&offer_id);
        let memo = format!("offer:{offer_id}");
        self.move_tokens(&offer.token_id, &offer.seller, &buyer, offer.amount.0, Some(&memo));
        self.move_tokens("credits", &buyer, &offer.seller, offer.total_credits.0, Some(&memo));
    }

    /// An unaccepted offer can be withdrawn by its merchant. Its id stays consumed.
    pub fn cancel_offer(&mut self, offer_id: String) {
        self.require_live();
        let offer = self.offers.get(&offer_id).cloned().unwrap_or_else(|| env::panic_str("no such offer"));
        require!(offer.seller == env::predecessor_account_id(), "not your offer");
        self.offers.remove(&offer_id);
        self.used.insert(format!("offer:{offer_id}"));
    }
}

// ── internals ────────────────────────────────────────────────────────────────

impl World {
    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the game server can do this");
    }

    fn require_live(&self) {
        require!(!env::storage_has_key(FROZEN_KEY), "frozen: this contract migrated to cz-assets + cz-world v2");
    }

    fn require_holder(&self, account: &AccountId) {
        require!(self.holders.contains(account), "receiver is not a registered holder");
    }

    fn check_flow(&self, f: &Flow) {
        require_token(&f.token_id);
        require_amount(f.amount.0);
        require!(self.roles.get(&f.account_id).is_some(), "flows apply only to registered actors");
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
        let s = self.supply.get(token_id).copied().unwrap_or(0) as i128 + delta;
        require!(s >= 0, "supply underflow");
        require!(s as u128 <= MAX_SUPPLY, "supply cap exceeded");
        self.supply.insert(token_id.to_string(), s as u128);
    }

    fn move_tokens(&mut self, token_id: &str, from: &AccountId, to: &AccountId, amount: u128, memo: Option<&str>) {
        require_token(token_id);
        require!(amount > 0, "amount must be positive");
        require!(from != to, "sender and receiver are the same");
        self.debit(token_id, from, amount);
        self.credit(token_id, to, amount);
        emit("mt_transfer", near_sdk::serde_json::json!({
            "old_owner_id": from, "new_owner_id": to, "token_ids": [token_id], "amounts": [U128(amount)], "memo": memo,
        }));
    }
}

#[cfg(test)]
mod tests;
