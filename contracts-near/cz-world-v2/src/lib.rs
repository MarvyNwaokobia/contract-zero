//! CONTRACT ZERO game controller (`cz-world` v2).
//!
//! Holds no balances. It decides WHETHER value may move (roles, offers, bids, raids,
//! expiry, replay) and asks `cz-assets` to move it. Every value movement is one
//! `controller_settle` / `controller_mint_burn` call that `cz-assets` applies
//! atomically; this contract then commits or restores its own state in a callback:
//!
//! - an offer, bid or raid is marked `settling` before the cross-contract call, so it
//!   cannot be accepted or submitted twice while in flight;
//! - on success the operation id is consumed and the offer/bid removed;
//! - on failure the offer/bid returns to `open` and the id is NOT consumed, so a
//!   failed settlement can be retried safely (and `cz-assets` independently refuses
//!   any id it has already applied).
//!
//! Authorization: the server settles raids and applies flows; merchants post offers
//! (they sell) and bids (they buy); only the named counterparty accepts. Agent and
//! player methods take no deposit, so they work with restricted function-call keys.
//! Player assets are protected in `cz-assets`: a leg can debit a player only when that
//! player signed the transaction.

use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearSchema, PanicOnDefault, Promise, PromiseError};

pub const MAX_AMOUNT: u128 = 100_000;
pub const MAX_TTL_SECS: u32 = 3_600;
pub const MAX_ENTRIES: usize = 32;

const GAS_REGISTER: Gas = Gas::from_tgas(10);
const GAS_SETTLE: Gas = Gas::from_tgas(30);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);

#[derive(Serialize, Deserialize, NearSchema, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct Flow {
    pub account_id: AccountId,
    pub token_id: String,
    pub amount: U128,
}

#[derive(Serialize, Deserialize, NearSchema, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct Leg {
    pub from: AccountId,
    pub to: AccountId,
    pub token_id: String,
    pub amount: U128,
}

#[ext_contract(ext_assets)]
pub trait AssetsLedger {
    fn controller_register(&mut self, account_id: AccountId);
    fn controller_settle(&mut self, op_id: String, legs: Vec<Leg>);
    fn controller_mint_burn(&mut self, op_id: String, mints: Vec<Flow>, burns: Vec<Flow>);
}

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Roles,
    Quotes,
    Used,
    Pending,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Faction,
    Merchant,
}

/// Which way a quote trades: the merchant sells (`Offer`) or buys (`Bid`).
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuoteKind {
    Offer,
    Bid,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuoteState {
    Open,
    Settling,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Quote {
    pub kind: QuoteKind,
    pub merchant: AccountId,
    /// The buyer of an offer, or the seller to a bid.
    pub counterparty: AccountId,
    pub token_id: String,
    pub amount: U128,
    pub total_credits: U128,
    pub expires_at_ns: u64,
    pub state: QuoteState,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct WorldV2 {
    owner: AccountId,
    server: AccountId,
    assets: AccountId,
    roles: LookupMap<AccountId, Role>,
    quotes: LookupMap<String, Quote>,
    /// Operation ids that settled ("raid:7", "flows:…", "offer:q", "bid:b").
    used: LookupSet<String>,
    /// Operation ids currently in flight.
    pending: LookupSet<String>,
}

fn require_amount(a: u128) {
    require!(a > 0 && a <= MAX_AMOUNT, "amount out of range");
}

#[near]
impl WorldV2 {
    #[init]
    pub fn new(owner: AccountId, server: AccountId, assets: AccountId) -> Self {
        Self { owner, server, assets, roles: LookupMap::new(Key::Roles), quotes: LookupMap::new(Key::Quotes), used: LookupSet::new(Key::Used), pending: LookupSet::new(Key::Pending) }
    }

    // ── owner ────────────────────────────────────────────────────────────────

    pub fn register_actor(&mut self, account_id: AccountId, role: Role) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can do this");
        require!(account_id != self.server && account_id != self.owner, "the server and owner are not actors");
        self.roles.insert(account_id, role);
    }

    pub fn set_server(&mut self, server: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can do this");
        self.server = server;
    }

    // ── views ────────────────────────────────────────────────────────────────

    pub fn role_of(&self, account_id: AccountId) -> Option<Role> {
        self.roles.get(&account_id).copied()
    }

    pub fn get_quote(&self, quote_id: String) -> Option<Quote> {
        self.quotes.get(&quote_id).cloned()
    }

    pub fn is_used(&self, op_id: String) -> bool {
        self.used.contains(&op_id)
    }

    pub fn is_pending(&self, op_id: String) -> bool {
        self.pending.contains(&op_id)
    }

    pub fn config(&self) -> (AccountId, AccountId, AccountId) {
        (self.owner.clone(), self.server.clone(), self.assets.clone())
    }

    // ── server ───────────────────────────────────────────────────────────────

    /// Move a validated raid's cargo (and any sponsor bounty) from the faction to the
    /// player. Registers the player for storage from the sponsorship quota first.
    pub fn settle_raid(&mut self, raid_id: String, faction: AccountId, player: AccountId, token_id: String, amount: U128, bounty: Option<(AccountId, U128)>) -> Promise {
        self.only_server();
        require!(self.roles.get(&faction) == Some(&Role::Faction), "target is not a registered faction");
        require!(self.roles.get(&player).is_none() && player != self.server && player != env::current_account_id(), "the receiver of raid cargo must be a player");
        require!(token_id != "credits", "raids move resources, not credits");
        require_amount(amount.0);
        let op = format!("raid:{raid_id}");
        self.begin(&op);
        let mut legs = vec![Leg { from: faction, to: player.clone(), token_id, amount }];
        if let Some((sponsor, credits)) = bounty {
            require!(self.roles.get(&sponsor).is_some(), "the bounty sponsor must be a registered actor");
            require_amount(credits.0);
            legs.push(Leg { from: sponsor, to: player.clone(), token_id: "credits".into(), amount: credits });
        }
        ext_assets::ext(self.assets.clone())
            .with_static_gas(GAS_REGISTER)
            .controller_register(player)
            .then(ext_assets::ext(self.assets.clone()).with_static_gas(GAS_SETTLE).controller_settle(op.clone(), legs))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_settled(op, None))
    }

    /// Mirror a batch of the economy's issuance and destruction on actor accounts.
    pub fn apply_flows(&mut self, batch_id: String, mints: Vec<Flow>, burns: Vec<Flow>) -> Promise {
        self.only_server();
        require!(mints.len() + burns.len() <= MAX_ENTRIES && !(mints.is_empty() && burns.is_empty()), "1..=32 flows");
        for f in mints.iter().chain(&burns) {
            require!(self.roles.get(&f.account_id).is_some(), "flows apply only to registered actors");
            require_amount(f.amount.0);
        }
        let op = format!("flows:{batch_id}");
        self.begin(&op);
        ext_assets::ext(self.assets.clone())
            .with_static_gas(GAS_SETTLE)
            .controller_mint_burn(op.clone(), mints, burns)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_settled(op, None))
    }

    // ── merchants ────────────────────────────────────────────────────────────

    /// The merchant offers to SELL `amount` of `token_id` to `buyer`.
    pub fn post_offer(&mut self, offer_id: String, buyer: AccountId, token_id: String, amount: U128, total_credits: U128, ttl_secs: u32) {
        self.post(QuoteKind::Offer, format!("offer:{offer_id}"), buyer, token_id, amount, total_credits, ttl_secs);
    }

    /// The merchant offers to BUY `amount` of `token_id` from `seller`.
    pub fn post_bid(&mut self, bid_id: String, seller: AccountId, token_id: String, amount: U128, total_credits: U128, ttl_secs: u32) {
        self.post(QuoteKind::Bid, format!("bid:{bid_id}"), seller, token_id, amount, total_credits, ttl_secs);
    }

    pub fn cancel_quote(&mut self, quote_id: String) {
        let q = self.quotes.get(&quote_id).cloned().unwrap_or_else(|| env::panic_str("no such quote"));
        require!(q.merchant == env::predecessor_account_id(), "not your quote");
        require!(q.state == QuoteState::Open, "the quote is settling");
        self.quotes.remove(&quote_id);
        self.used.insert(quote_id);
    }

    // ── counterparties ───────────────────────────────────────────────────────

    /// The named buyer accepts an offer, paying at most `max_total`.
    pub fn accept_offer(&mut self, offer_id: String, max_total: U128) -> Promise {
        let id = format!("offer:{offer_id}");
        let q = self.take_for_settlement(&id, QuoteKind::Offer);
        require!(q.total_credits.0 <= max_total.0, "price is above the buyer's limit");
        let legs = vec![
            Leg { from: q.merchant.clone(), to: q.counterparty.clone(), token_id: q.token_id.clone(), amount: q.amount },
            Leg { from: q.counterparty.clone(), to: q.merchant.clone(), token_id: "credits".into(), amount: q.total_credits },
        ];
        self.settle_quote(id, legs)
    }

    /// The named seller accepts a bid, receiving at least `min_total`.
    pub fn accept_bid(&mut self, bid_id: String, min_total: U128) -> Promise {
        let id = format!("bid:{bid_id}");
        let q = self.take_for_settlement(&id, QuoteKind::Bid);
        require!(q.total_credits.0 >= min_total.0, "price is below the seller's limit");
        let legs = vec![
            Leg { from: q.counterparty.clone(), to: q.merchant.clone(), token_id: q.token_id.clone(), amount: q.amount },
            Leg { from: q.merchant.clone(), to: q.counterparty.clone(), token_id: "credits".into(), amount: q.total_credits },
        ];
        self.settle_quote(id, legs)
    }

    // ── callbacks ────────────────────────────────────────────────────────────

    /// Commit or restore after `cz-assets` answered. `quote` is set for offers and bids.
    #[private]
    pub fn on_settled(&mut self, op_id: String, quote: Option<String>, #[callback_result] result: Result<(), PromiseError>) -> bool {
        self.pending.remove(&op_id);
        match result {
            Ok(()) => {
                self.used.insert(op_id.clone());
                if let Some(q) = quote {
                    self.quotes.remove(&q);
                }
                env::log_str(&format!("settled {op_id}"));
                true
            }
            Err(_) => {
                if let Some(q) = quote {
                    if let Some(mut quote) = self.quotes.get(&q).cloned() {
                        quote.state = QuoteState::Open;
                        self.quotes.insert(q, quote);
                    }
                }
                env::log_str(&format!("settlement failed, released {op_id}"));
                false
            }
        }
    }
}

// ── internals ────────────────────────────────────────────────────────────────

impl WorldV2 {
    fn only_server(&self) {
        require!(env::predecessor_account_id() == self.server, "only the game server can do this");
    }

    /// Reserve an operation id for an in-flight settlement.
    fn begin(&mut self, op: &str) {
        require!(!self.used.contains(op), "operation already applied");
        require!(self.pending.insert(op.to_string()), "operation already in flight");
    }

    #[allow(clippy::too_many_arguments)]
    fn post(&mut self, kind: QuoteKind, id: String, counterparty: AccountId, token_id: String, amount: U128, total_credits: U128, ttl_secs: u32) {
        let merchant = env::predecessor_account_id();
        require!(self.roles.get(&merchant) == Some(&Role::Merchant), "only a registered merchant posts quotes");
        require!(counterparty != merchant, "cannot trade with yourself");
        require!(token_id != "credits", "credits are the payment, not the goods");
        require_amount(amount.0);
        require!(total_credits.0 > 0 && total_credits.0 <= MAX_AMOUNT * 100, "price out of range");
        require!((1..=MAX_TTL_SECS).contains(&ttl_secs), "ttl out of range");
        require!(!self.quotes.contains_key(&id) && !self.used.contains(&id), "quote id already used");
        let expires_at_ns = env::block_timestamp() + ttl_secs as u64 * 1_000_000_000;
        self.quotes.insert(id, Quote { kind, merchant, counterparty, token_id, amount, total_credits, expires_at_ns, state: QuoteState::Open });
    }

    /// Validate the caller and the quote, then mark it settling.
    fn take_for_settlement(&mut self, id: &str, kind: QuoteKind) -> Quote {
        let mut q = self.quotes.get(id).cloned().unwrap_or_else(|| env::panic_str("no such quote"));
        require!(q.kind == kind, "wrong quote kind");
        require!(q.counterparty == env::predecessor_account_id(), "this quote is for another account");
        require!(q.state == QuoteState::Open, "the quote is already settling");
        require!(env::block_timestamp() <= q.expires_at_ns, "quote expired");
        self.begin(id);
        q.state = QuoteState::Settling;
        self.quotes.insert(id.to_string(), q.clone());
        q
    }

    fn settle_quote(&mut self, id: String, legs: Vec<Leg>) -> Promise {
        ext_assets::ext(self.assets.clone())
            .with_static_gas(GAS_SETTLE)
            .controller_settle(id.clone(), legs)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_settled(id.clone(), Some(id)))
    }
}

#[cfg(test)]
mod tests;
