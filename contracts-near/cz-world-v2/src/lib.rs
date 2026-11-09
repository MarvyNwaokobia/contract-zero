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
use near_sdk::{env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearSchema, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue, PublicKey};

pub const MAX_AMOUNT: u128 = 100_000;
pub const MAX_TTL_SECS: u32 = 3_600;
pub const MAX_ENTRIES: usize = 32;

const GAS_REGISTER: Gas = Gas::from_tgas(10);
const GAS_SETTLE: Gas = Gas::from_tgas(30);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
/// A fill's callback may chain the order's refund (a settle plus its own callback).
const GAS_FILL_CALLBACK: Gas = Gas::from_tgas(60);

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
    /// Trading sessions (added in v2.2; created on demand, so no state migration).
    Sessions,
    /// Supply orders and merchant proposals (added in v2.3; created on demand).
    Orders,
    Proposals,
}

/// Longest a trading session may last.
pub const MAX_SESSION_SECS: u32 = 7 * 24 * 3_600;
/// Storage deposit a player attaches to open a session; refunded when it is revoked.
pub const SESSION_DEPOSIT: u128 = 1_000_000_000_000_000_000_000; // 0.001 NEAR

/// A scoped, revocable permission for one of the player's keys (a "session key" the
/// game client holds) to accept quotes without a wallet prompt, within budgets the
/// player set when they opened it with their own full authority.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Session {
    /// Credits the key may still spend on offers.
    pub credit_budget: U128,
    /// Units the key may still sell into bids.
    pub unit_budget: U128,
    pub expires_at_ns: u64,
    /// A revoked session stays as a tombstone, so the key it names stays powerless
    /// even before the player deletes the key itself.
    pub revoked: bool,
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

fn orders() -> LookupMap<String, Order> {
    LookupMap::new(Key::Orders)
}

fn proposals() -> LookupMap<String, Proposal> {
    LookupMap::new(Key::Proposals)
}

fn proposal_key(order_id: &str, proposal_id: &str) -> String {
    format!("{order_id}|{proposal_id}")
}

/// Which way a supply order trades, from the requester's side.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderSide {
    /// The requester buys goods, escrowing `limit_credits`.
    Buy,
    /// The requester sells goods, escrowing `quantity`.
    Sell,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderState {
    /// The escrow transfer is in flight.
    Funding,
    Open,
    /// A proposal's settlement is in flight: no other fill, cancel or expiry meanwhile.
    Settling,
    /// Filled, cancelled or expired; the unused escrow is being returned.
    Refunding,
    /// Done. `close_reason` says how.
    Closed,
}

/// A supply order: a requester's bounded intent ("buy up to N ammo for at most C
/// credits by time T"), funded in escrow on the ledger. Registered merchants answer
/// with proposals; the requester accepts one, and the contract settles it from escrow
/// within the order's limits. Unused escrow returns when the order closes.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Order {
    pub requester: AccountId,
    pub side: OrderSide,
    pub token_id: String,
    pub quantity: U128,
    pub remaining: U128,
    /// Buy: the most the whole quantity may cost. Sell: the least it must fetch.
    /// Every fill is held to this pro rata, so a partial fill can't take the whole budget.
    pub limit_credits: U128,
    /// Credits paid (buy) or received (sell) so far.
    pub settled_credits: U128,
    pub allow_partial: bool,
    pub expires_at_ns: u64,
    pub state: OrderState,
    /// "filled", "cancelled" or "expired" once the order stops trading.
    pub close_reason: Option<String>,
    pub fills: u32,
}

/// A merchant's answer to an order: this quantity for this many credits, until expiry.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Proposal {
    pub merchant: AccountId,
    pub quantity: U128,
    pub total_credits: U128,
    pub expires_at_ns: u64,
}

/// Is `total` for `qty` units inside the order's limit, pro rata?
pub fn within_limit(side: OrderSide, quantity: u128, limit: u128, qty: u128, total: u128) -> bool {
    match side {
        // total / qty <= limit / quantity
        OrderSide::Buy => total * quantity <= limit * qty,
        // total / qty >= limit / quantity
        OrderSide::Sell => total * quantity >= limit * qty,
    }
}

fn sessions() -> LookupMap<String, Session> {
    LookupMap::new(Key::Sessions)
}

fn session_key(account: &AccountId, pk: &PublicKey) -> String {
    format!("{account}|{}", String::from(pk))
}

/// If the transaction was signed by one of the account's session keys, enforce that
/// session's expiry and budgets (and spend them). Any other key is the account's own
/// authority (a wallet approval) and is not limited here.
fn charge_session(account: &AccountId, credits: u128, units: u128) {
    let mut map = sessions();
    let k = session_key(account, &env::signer_account_pk());
    let Some(mut s) = map.get(&k).cloned() else { return };
    require!(!s.revoked, "this session was revoked");
    require!(env::block_timestamp() <= s.expires_at_ns, "this session has expired");
    require!(credits <= s.credit_budget.0, "over this session's credit budget");
    require!(units <= s.unit_budget.0, "over this session's sale budget");
    s.credit_budget = U128(s.credit_budget.0 - credits);
    s.unit_budget = U128(s.unit_budget.0 - units);
    map.insert(k, s);
    map.flush();
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

    pub fn get_session(&self, account_id: AccountId, public_key: PublicKey) -> Option<Session> {
        sessions().get(&session_key(&account_id, &public_key)).cloned()
    }

    // ── trading sessions ─────────────────────────────────────────────────────

    /// Open a session for `public_key` (a key the caller has added to their own
    /// account, scoped to this contract). Must be called with the account's own
    /// authority, never by the session key itself, and with `SESSION_DEPOSIT`.
    #[payable]
    pub fn register_session(&mut self, public_key: PublicKey, credit_budget: U128, unit_budget: U128, ttl_secs: u32) {
        require!(env::attached_deposit().as_yoctonear() >= SESSION_DEPOSIT, "attach 0.001 NEAR for the session's storage");
        require!(env::signer_account_pk() != public_key, "a session key cannot open its own session");
        require!((1..=MAX_SESSION_SECS).contains(&ttl_secs), "session length out of range");
        let account = env::predecessor_account_id();
        require!(self.roles.get(&account).is_none(), "sessions are for players");
        let mut map = sessions();
        let k = session_key(&account, &public_key);
        if let Some(old) = map.get(&k) {
            require!(!old.revoked, "this key was revoked; use a new key");
        }
        map.insert(k, Session { credit_budget, unit_budget, expires_at_ns: env::block_timestamp() + ttl_secs as u64 * 1_000_000_000, revoked: false });
        map.flush();
    }

    /// End a session. The player may call it with any of their keys, including the
    /// session key itself, so a game client can sign out without a wallet prompt.
    /// Refunds the storage deposit.
    pub fn revoke_session(&mut self, public_key: PublicKey) -> Promise {
        let account = env::predecessor_account_id();
        let mut map = sessions();
        let k = session_key(&account, &public_key);
        let mut s = map.get(&k).cloned().unwrap_or_else(|| env::panic_str("no such session"));
        require!(!s.revoked, "already revoked");
        s.revoked = true;
        s.credit_budget = U128(0);
        s.unit_budget = U128(0);
        map.insert(k, s);
        map.flush();
        Promise::new(account).transfer(NearToken::from_yoctonear(SESSION_DEPOSIT))
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

    /// Settle a sabotage fee or a recovery: legs that each debit a registered actor and
    /// pay a registered actor or the named player (e.g. faction → merchant cargo, and
    /// merchant → player fee). Server-only; registers the player's storage first.
    pub fn settle_operation(&mut self, op_id: String, player: AccountId, legs: Vec<Leg>) -> Promise {
        self.only_server();
        require!(self.roles.get(&player).is_none() && player != self.server && player != env::current_account_id(), "the player must not be an actor");
        require!(!legs.is_empty() && legs.len() <= 4, "1..=4 legs");
        for l in &legs {
            require!(self.roles.get(&l.from).is_some(), "operation legs debit actors only");
            require!(self.roles.get(&l.to).is_some() || l.to == player, "operation legs pay actors or the player");
            require!(l.from != l.to, "sender and receiver are the same");
            require_amount(l.amount.0);
        }
        let op = format!("op:{op_id}");
        self.begin(&op);
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
        charge_session(&q.counterparty, q.total_credits.0, 0);
        let legs = vec![
            Leg { from: q.merchant.clone(), to: q.counterparty.clone(), token_id: q.token_id.clone(), amount: q.amount },
            Leg { from: q.counterparty.clone(), to: q.merchant.clone(), token_id: "credits".into(), amount: q.total_credits },
        ];
        self.settle_quote(id, q.counterparty, legs)
    }

    /// The named seller accepts a bid, receiving at least `min_total`.
    pub fn accept_bid(&mut self, bid_id: String, min_total: U128) -> Promise {
        let id = format!("bid:{bid_id}");
        let q = self.take_for_settlement(&id, QuoteKind::Bid);
        require!(q.total_credits.0 >= min_total.0, "price is below the seller's limit");
        charge_session(&q.counterparty, 0, q.amount.0);
        let legs = vec![
            Leg { from: q.counterparty.clone(), to: q.merchant.clone(), token_id: q.token_id.clone(), amount: q.amount },
            Leg { from: q.merchant.clone(), to: q.counterparty.clone(), token_id: "credits".into(), amount: q.total_credits },
        ];
        self.settle_quote(id, q.counterparty, legs)
    }


    // ── supply orders ────────────────────────────────────────────────────────

    pub fn get_order(&self, order_id: String) -> Option<Order> {
        orders().get(&order_id).cloned()
    }

    pub fn get_proposal(&self, order_id: String, proposal_id: String) -> Option<Proposal> {
        proposals().get(&proposal_key(&order_id, &proposal_id)).cloned()
    }

    /// Place a supply order and fund it: credits (buy) or goods (sell) move from the
    /// requester into this contract's escrow, with the requester's own authority (or
    /// within a quick-trade session's budget). Players and factions may place orders;
    /// merchants fill them. `order_id` is the replay key: it can never be reused.
    pub fn place_order(&mut self, order_id: String, side: OrderSide, token_id: String, quantity: U128, limit_credits: U128, allow_partial: bool, ttl_secs: u32) -> Promise {
        let requester = env::predecessor_account_id();
        require!(self.roles.get(&requester) != Some(&Role::Merchant), "merchants fill orders; they don't place them");
        require!(requester != self.server && requester != env::current_account_id(), "the server places no orders");
        require!(!order_id.is_empty() && order_id.len() <= 64 && !order_id.contains('|'), "bad order id");
        require!(token_id != "credits", "credits are the payment, not the goods");
        require_amount(quantity.0);
        require_amount(limit_credits.0);
        require!((1..=MAX_TTL_SECS).contains(&ttl_secs), "ttl out of range");
        let id = format!("order:{order_id}");
        require!(orders().get(&order_id).is_none() && !self.used.contains(&id), "order id already used");
        match side {
            OrderSide::Buy => charge_session(&requester, limit_credits.0, 0),
            OrderSide::Sell => charge_session(&requester, 0, quantity.0),
        }
        let mut map = orders();
        map.insert(order_id.clone(), Order {
            requester: requester.clone(), side, token_id: token_id.clone(), quantity, remaining: quantity, limit_credits, settled_credits: U128(0),
            allow_partial, expires_at_ns: env::block_timestamp() + ttl_secs as u64 * 1_000_000_000, state: OrderState::Funding, close_reason: None, fills: 0,
        });
        map.flush();
        self.begin(&id);
        let (token, amount) = match side { OrderSide::Buy => ("credits".to_string(), limit_credits), OrderSide::Sell => (token_id, quantity) };
        let legs = vec![Leg { from: requester.clone(), to: env::current_account_id(), token_id: token, amount }];
        ext_assets::ext(self.assets.clone())
            .with_static_gas(GAS_REGISTER)
            .controller_register(requester)
            .then(ext_assets::ext(self.assets.clone()).with_static_gas(GAS_SETTLE).controller_settle(id.clone(), legs))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_order_step(order_id, id, None))
    }

    /// A registered merchant proposes to fill (part of) an open order. Checked against
    /// the order's limits now and again at acceptance. Merchants can't propose to
    /// themselves, and a proposal id is used once per order.
    pub fn propose(&mut self, order_id: String, proposal_id: String, quantity: U128, total_credits: U128, ttl_secs: u32) {
        let merchant = env::predecessor_account_id();
        require!(self.roles.get(&merchant) == Some(&Role::Merchant), "only a registered merchant proposes");
        let o = orders().get(&order_id).cloned().unwrap_or_else(|| env::panic_str("no such order"));
        require!(o.state == OrderState::Open || o.state == OrderState::Settling, "the order is not open");
        require!(env::block_timestamp() <= o.expires_at_ns, "order expired");
        require!(o.requester != merchant, "cannot fill your own order");
        require!(!proposal_id.is_empty() && proposal_id.len() <= 64 && !proposal_id.contains('|'), "bad proposal id");
        require_amount(quantity.0);
        require_amount(total_credits.0);
        require!(quantity.0 <= o.remaining.0, "more than the order still wants");
        require!(o.allow_partial || quantity.0 == o.remaining.0, "this order takes no partial fills");
        require!(within_limit(o.side, o.quantity.0, o.limit_credits.0, quantity.0, total_credits.0), "outside the order's price limit");
        require!((1..=MAX_TTL_SECS).contains(&ttl_secs), "ttl out of range");
        let k = proposal_key(&order_id, &proposal_id);
        let mut map = proposals();
        require!(map.get(&k).is_none() && !self.used.contains(&format!("fill:{k}")), "proposal id already used");
        map.insert(k, Proposal { merchant, quantity, total_credits, expires_at_ns: env::block_timestamp() + ttl_secs as u64 * 1_000_000_000 });
        map.flush();
    }

    /// The requester accepts one proposal. Settles atomically: the merchant's goods
    /// (buy) or credits (sell) to the requester, and the matching escrow to the
    /// merchant. Only the requester may accept; only one fill is in flight at a time.
    pub fn accept_proposal(&mut self, order_id: String, proposal_id: String) -> Promise {
        let mut map = orders();
        let mut o = map.get(&order_id).cloned().unwrap_or_else(|| env::panic_str("no such order"));
        require!(o.requester == env::predecessor_account_id(), "only the requester accepts");
        require!(o.state == OrderState::Open, "the order is not open");
        require!(env::block_timestamp() <= o.expires_at_ns, "order expired");
        let k = proposal_key(&order_id, &proposal_id);
        let p = proposals().get(&k).cloned().unwrap_or_else(|| env::panic_str("no such proposal"));
        require!(env::block_timestamp() <= p.expires_at_ns, "proposal expired");
        require!(p.quantity.0 <= o.remaining.0, "more than the order still wants");
        require!(o.allow_partial || p.quantity.0 == o.remaining.0, "this order takes no partial fills");
        require!(within_limit(o.side, o.quantity.0, o.limit_credits.0, p.quantity.0, p.total_credits.0), "outside the order's price limit");
        let op = format!("fill:{k}");
        self.begin(&op);
        o.state = OrderState::Settling;
        map.insert(order_id.clone(), o.clone());
        map.flush();
        let me = env::current_account_id();
        let legs = match o.side {
            OrderSide::Buy => vec![
                Leg { from: p.merchant.clone(), to: o.requester.clone(), token_id: o.token_id.clone(), amount: p.quantity },
                Leg { from: me, to: p.merchant.clone(), token_id: "credits".into(), amount: p.total_credits },
            ],
            OrderSide::Sell => vec![
                Leg { from: p.merchant.clone(), to: o.requester.clone(), token_id: "credits".into(), amount: p.total_credits },
                Leg { from: me, to: p.merchant.clone(), token_id: o.token_id.clone(), amount: p.quantity },
            ],
        };
        ext_assets::ext(self.assets.clone())
            .with_static_gas(GAS_SETTLE)
            .controller_settle(op.clone(), legs)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_FILL_CALLBACK).on_order_step(order_id, op, Some(proposal_id)))
    }

    /// The requester withdraws an open order; the unused escrow comes back. Refused
    /// while a fill is in flight (race-safe: the fill either lands first or fails and
    /// reopens the order).
    pub fn cancel_order(&mut self, order_id: String) -> PromiseOrValue<bool> {
        let o = orders().get(&order_id).cloned().unwrap_or_else(|| env::panic_str("no such order"));
        require!(o.requester == env::predecessor_account_id(), "only the requester cancels");
        require!(o.state == OrderState::Open, "the order is not open");
        self.close_and_refund(order_id, "cancelled")
    }

    /// Anyone may expire an open order past its deadline; the escrow returns to the
    /// requester (never to the caller).
    pub fn expire_order(&mut self, order_id: String) -> PromiseOrValue<bool> {
        let o = orders().get(&order_id).cloned().unwrap_or_else(|| env::panic_str("no such order"));
        require!(o.state == OrderState::Open, "the order is not open");
        require!(env::block_timestamp() > o.expires_at_ns, "the order has not expired");
        self.close_and_refund(order_id, "expired")
    }

    /// Retry a refund whose settlement failed (the order stays `Refunding` until it lands).
    pub fn retry_refund(&mut self, order_id: String) -> PromiseOrValue<bool> {
        let o = orders().get(&order_id).cloned().unwrap_or_else(|| env::panic_str("no such order"));
        require!(o.state == OrderState::Refunding, "nothing to refund");
        require!(!self.pending.contains(&format!("refund:{order_id}")), "a refund is in flight");
        self.send_refund(order_id, o)
    }

    /// Commit or restore one step of an order: funding, a fill, or the refund.
    #[private]
    pub fn on_order_step(&mut self, order_id: String, op_id: String, proposal_id: Option<String>, #[callback_result] result: Result<(), PromiseError>) -> PromiseOrValue<bool> {
        self.pending.remove(&op_id);
        let mut map = orders();
        let Some(mut o) = map.get(&order_id).cloned() else { return PromiseOrValue::Value(false) };
        let ok = result.is_ok();
        if ok {
            self.used.insert(op_id.clone());
        }
        env::log_str(&format!("{} {op_id}", if ok { "settled" } else { "failed" }));
        if op_id.starts_with("order:") {
            // Funding: open the order, or drop it (nothing was escrowed; the id stays free).
            if ok {
                o.state = OrderState::Open;
                map.insert(order_id, o);
            } else {
                map.remove(&order_id);
            }
            map.flush();
            return PromiseOrValue::Value(ok);
        }
        if op_id.starts_with("refund:") {
            if ok {
                o.state = OrderState::Closed;
                map.insert(order_id, o);
                map.flush();
            }
            return PromiseOrValue::Value(ok);
        }
        // A fill.
        let k = proposal_key(&order_id, proposal_id.as_deref().unwrap_or_default());
        if !ok {
            // Nothing moved (assets applies all legs or none): reopen; the proposal stays.
            o.state = OrderState::Open;
            map.insert(order_id, o);
            map.flush();
            return PromiseOrValue::Value(false);
        }
        let p = proposals().get(&k).cloned().unwrap_or_else(|| env::panic_str("proposal vanished"));
        let mut pm = proposals();
        pm.remove(&k);
        pm.flush();
        o.remaining = U128(o.remaining.0 - p.quantity.0);
        o.settled_credits = U128(o.settled_credits.0 + p.total_credits.0);
        o.fills += 1;
        o.state = OrderState::Open;
        if o.remaining.0 == 0 {
            map.insert(order_id.clone(), o);
            map.flush();
            return self.close_and_refund(order_id, "filled");
        }
        map.insert(order_id, o);
        map.flush();
        PromiseOrValue::Value(true)
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


    /// Stop an order trading and return whatever escrow it didn't use.
    fn close_and_refund(&mut self, order_id: String, reason: &str) -> PromiseOrValue<bool> {
        let mut map = orders();
        let mut o = map.get(&order_id).cloned().unwrap_or_else(|| env::panic_str("no such order"));
        o.state = OrderState::Refunding;
        o.close_reason = Some(reason.to_string());
        map.insert(order_id.clone(), o.clone());
        map.flush();
        self.send_refund(order_id, o)
    }

    fn send_refund(&mut self, order_id: String, o: Order) -> PromiseOrValue<bool> {
        let (token, amount) = match o.side {
            OrderSide::Buy => ("credits".to_string(), o.limit_credits.0 - o.settled_credits.0),
            OrderSide::Sell => (o.token_id.clone(), o.remaining.0),
        };
        let op = format!("refund:{order_id}");
        if amount == 0 {
            // Fully used: nothing to return, close at once.
            let mut map = orders();
            let mut o = o;
            o.state = OrderState::Closed;
            map.insert(order_id, o);
            map.flush();
            self.used.insert(op);
            return PromiseOrValue::Value(true);
        }
        self.pending.insert(op.clone());
        let legs = vec![Leg { from: env::current_account_id(), to: o.requester.clone(), token_id: token, amount: U128(amount) }];
        PromiseOrValue::Promise(
            ext_assets::ext(self.assets.clone())
                .with_static_gas(GAS_SETTLE)
                .controller_settle(op.clone(), legs)
                .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_order_step(order_id, op, None)),
        )
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

    /// Register the counterparty's ledger storage (a no-op once registered; a new
    /// player is covered by the sponsorship quota), then settle both legs atomically.
    fn settle_quote(&mut self, id: String, counterparty: AccountId, legs: Vec<Leg>) -> Promise {
        ext_assets::ext(self.assets.clone())
            .with_static_gas(GAS_REGISTER)
            .controller_register(counterparty)
            .then(ext_assets::ext(self.assets.clone()).with_static_gas(GAS_SETTLE).controller_settle(id.clone(), legs))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_settled(id.clone(), Some(id)))
    }
}

#[cfg(test)]
mod tests;
