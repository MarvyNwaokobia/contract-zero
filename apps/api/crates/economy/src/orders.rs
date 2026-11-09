//! Supply orders: bounded economic intents that competing merchants fill.
//!
//! A requester (a faction's commander or a player) places an order: what it wants,
//! how much, the most it will pay (or the least it will take), whether partial fills
//! are acceptable, and until when. Its side is funded into the order's escrow account
//! at once, so nothing it doesn't own can ever be promised.
//!
//! Each merchant decides independently whether to answer (`policy::merchant_proposal`)
//! and at what price, from its own stock, treasury, pricing and risk limits. A proposal
//! reserves the merchant's side in a proposal escrow, so two orders can never be
//! promised the same crate. The requester accepts the proposal it prefers; settlement
//! moves both escrows in one atomic batch. Losing proposals are released, unused order
//! escrow is refunded, and every merchant adapts its margin to how it is winning.
//!
//! All amounts are integer credits and units; price limits are checked pro rata by
//! cross-multiplication, so no rounding can let a partial fill exceed its share.

use serde::{Deserialize, Serialize};

use crate::pricing::{self, Side, Strategy, BP};
use crate::*;

/// Longest an order or a proposal may stay open, in ticks (in-game hours).
pub const MAX_ORDER_TICKS: u64 = 48;
pub const PROPOSAL_TICKS: u64 = 4;
/// Consecutive wins or losses before a merchant reprices.
pub const ADAPT_STREAK: i32 = 3;
pub const ADAPT_STEP_BP: i64 = 200;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SupplyOrder {
    pub id: u64,
    /// Actor id (a faction) or player account.
    pub requester: String,
    pub account: AccountId,
    /// From the requester's side: `Buy` = it buys goods with credits.
    pub side: Side,
    pub resource: Resource,
    pub qty: i64,
    /// Buy: most the whole quantity may cost. Sell: least it must fetch.
    pub limit_total: i64,
    pub allow_partial: bool,
    pub placed_at: u64,
    pub expires_at: u64,
    /// The requester's own counter: each order must carry a higher one (replay guard).
    pub nonce: u64,
    /// 0 routine … 3 critical. Commanders weigh coverage over price when urgent.
    pub urgency: u8,
    pub filled: i64,
    /// Credits paid (buy) or received (sell) so far.
    pub settled_total: i64,
    pub status: OrderStatus,
    pub fills: Vec<Fill>,
    /// Why it was placed, in the requester's words (shown in the War Room).
    #[serde(default)]
    pub purpose: String,
    /// The controller's id for this order when the requester placed it on chain
    /// first (players); faction orders use `o{id}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum OrderStatus {
    Open,
    Filled,
    Cancelled,
    Expired,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fill {
    pub proposal: u64,
    pub merchant: String,
    pub qty: i64,
    pub total: i64,
    pub tick: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Proposal {
    pub id: u64,
    pub order: u64,
    pub merchant: String,
    pub qty: i64,
    pub total: i64,
    pub posted_at: u64,
    pub expires_at: u64,
    pub status: ProposalStatus,
    /// The merchant's reasoning, e.g. "48 on the shelf; 22% margin".
    #[serde(default)]
    pub note: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalStatus {
    Pending,
    Accepted,
    Released,
}

/// A merchant's character as a seller and buyer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MerchantProfile {
    pub strategy: Strategy,
    /// Shelf targets per resource (pricing scarcity is measured against these).
    pub target: [i64; 3],
    /// Never sells below production cost × (1 + this).
    pub min_margin_bp: i64,
    /// Most of one shelf it will commit to a single order.
    pub max_commit_bp: i64,
    /// Treasury above this is paid out of the region.
    pub capital: i64,
    #[serde(default)]
    pub record: MerchantRecord,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MerchantRecord {
    pub proposals: u32,
    pub wins: u32,
    pub losses: u32,
    pub declined: u32,
    /// Positive: consecutive wins; negative: consecutive losses.
    pub streak: i32,
    pub units_sold: i64,
    pub units_bought: i64,
    pub revenue: i64,
}

impl SupplyOrder {
    pub fn escrow(&self) -> AccountId {
        format!("order:{}", self.id)
    }
    /// The controller's id for this order.
    pub fn chain_order_id(&self) -> String {
        self.chain_id.clone().unwrap_or_else(|| format!("o{}", self.id))
    }
    pub fn remaining(&self) -> i64 {
        self.qty - self.filled
    }
    pub fn is_open(&self) -> bool {
        self.status == OrderStatus::Open
    }
    /// What the order escrow holds while open.
    pub fn escrowed(&self) -> (Asset, i64) {
        match self.side {
            Side::Buy => (Asset::Credits, self.limit_total - self.settled_total),
            Side::Sell => (Asset::Res(self.resource), self.qty - self.filled),
        }
    }
}

impl Proposal {
    pub fn escrow(&self) -> AccountId {
        format!("proposal:{}", self.id)
    }
}

/// Is `total` for `qty` units inside the order's limit, pro rata? (Exact integers.)
pub fn within_limit(o: &SupplyOrder, qty: i64, total: i64) -> bool {
    let (q, l) = (o.qty as i128, o.limit_total as i128);
    match o.side {
        Side::Buy => total as i128 * q <= l * qty as i128,
        Side::Sell => total as i128 * q >= l * qty as i128,
    }
}

impl World {
    // ── reads ────────────────────────────────────────────────────────────────

    /// Every merchant actor's id, Vex first (it is also the instant market).
    pub fn merchant_ids(&self) -> Vec<String> {
        let mut v: Vec<String> = self.actors.values().filter(|a| a.kind == ActorKind::Merchant).map(|a| a.id.clone()).collect();
        v.sort_by_key(|id| (*id != self.market.merchant, id.clone()));
        v
    }

    /// A merchant's profile. Vex's strategy and targets are the market's own.
    pub fn profile(&self, merchant: &str) -> Option<MerchantProfile> {
        let mut p = self.merchants.get(merchant).cloned();
        if merchant == self.market.merchant {
            let mut base = p.take().unwrap_or(MerchantProfile { strategy: self.market.strategy, target: self.market.target, min_margin_bp: 1_000, max_commit_bp: 8_000, capital: MERCHANT_CAPITAL, record: MerchantRecord::default() });
            base.strategy = self.market.strategy;
            base.target = self.market.target;
            p = Some(base);
        }
        p
    }

    /// One merchant's own price for `qty` of `r`, walked unit by unit along its curve.
    pub fn merchant_quote(&self, merchant: &str, r: Resource, side: Side, qty: i64) -> Option<i64> {
        let a = self.actors.get(merchant)?;
        let p = self.profile(merchant)?;
        let stock = self.balance(&a.account, Asset::Res(r));
        pricing::walk_total(r, side, qty, stock, p.target[r.idx()], self.net_demand_24h(r), p.strategy)
    }

    pub fn open_orders(&self) -> impl Iterator<Item = &SupplyOrder> {
        self.orders.values().filter(|o| o.is_open())
    }

    pub fn pending_proposals(&self, order: u64) -> impl Iterator<Item = &Proposal> {
        self.proposals.values().filter(move |p| p.order == order && p.status == ProposalStatus::Pending)
    }

    // ── commands ─────────────────────────────────────────────────────────────

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn place_order(&mut self, requester: &str, account: &str, side: Side, r: Resource, qty: i64, limit_total: i64, allow_partial: bool, ttl_ticks: u64, nonce: u64, urgency: u8, purpose: &str, chain_id: Option<&str>) -> Result<Vec<Event>, EconError> {
        if qty <= 0 || limit_total <= 0 {
            return Err(EconError::BadQuantity);
        }
        if ttl_ticks == 0 || ttl_ticks > MAX_ORDER_TICKS {
            return Err(EconError::OrderRejected { why: format!("an order lasts 1…{MAX_ORDER_TICKS} hours") });
        }
        let last = self.order_nonces.get(requester).copied().unwrap_or(0);
        if nonce <= last {
            return Err(EconError::OrderRejected { why: format!("nonce {nonce} already used (last {last})") });
        }
        if let Some(c) = chain_id {
            if self.orders.values().any(|o| o.chain_id.as_deref() == Some(c)) {
                return Err(EconError::OrderRejected { why: format!("chain order {c} is already recorded") });
            }
        }
        if self.open_orders().any(|o| o.requester == requester && o.resource == r && o.side == side) {
            return Err(EconError::OrderRejected { why: format!("an order for {} is already open", r.name()) });
        }
        let id = self.peek_id();
        let o = SupplyOrder {
            id, requester: requester.into(), account: account.into(), side, resource: r, qty, limit_total, allow_partial,
            placed_at: self.tick, expires_at: self.tick + ttl_ticks, nonce, urgency: urgency.min(3), filled: 0, settled_total: 0,
            status: OrderStatus::Open, fills: vec![], purpose: purpose.chars().take(160).collect(), chain_id: chain_id.map(String::from),
        };
        let (asset, amount) = o.escrowed();
        let mut ev = self.apply(&[Transfer { from: account.into(), to: o.escrow(), asset, qty: amount, reason: Reason::OrderEscrow { order: id } }])?;
        self.commit_id(id);
        self.order_nonces.insert(requester.into(), nonce);
        ev.push(Event::OrderPlaced(o.clone()));
        self.orders.insert(id, o);
        Ok(ev)
    }

    pub(crate) fn propose(&mut self, merchant: &str, order: u64, qty: i64, total: i64, note: &str) -> Result<Vec<Event>, EconError> {
        let o = self.orders.get(&order).cloned().ok_or_else(|| unknown("order", &order.to_string()))?;
        if !o.is_open() {
            return Err(EconError::OrderRejected { why: "the order is not open".into() });
        }
        if o.requester == merchant {
            return Err(EconError::SelfTarget);
        }
        if qty <= 0 || total <= 0 {
            return Err(EconError::BadQuantity);
        }
        if qty > o.remaining() || (!o.allow_partial && qty != o.remaining()) {
            return Err(EconError::OrderRejected { why: "quantity doesn't fit the order".into() });
        }
        if !within_limit(&o, qty, total) {
            return Err(EconError::PriceMoved { total, limit: o.limit_total * qty / o.qty });
        }
        if self.pending_proposals(order).any(|p| p.merchant == merchant) {
            return Err(EconError::OrderRejected { why: "already proposed".into() });
        }
        let m = self.actor(merchant)?.clone();
        if m.kind != ActorKind::Merchant {
            return Err(EconError::Unauthorized { caller: merchant.into(), action: "propose".into() });
        }
        if o.side == Side::Sell && self.balance(&m.account, Asset::Credits) - total < m.credit_reserve {
            return Err(EconError::MerchantInsolvent);
        }
        let id = self.peek_id();
        let p = Proposal { id, order, merchant: merchant.into(), qty, total, posted_at: self.tick, expires_at: (self.tick + PROPOSAL_TICKS).min(o.expires_at), status: ProposalStatus::Pending, note: note.chars().take(160).collect() };
        // Reserve the merchant's side: goods it sells, or credits it pays.
        let (asset, amount) = match o.side { Side::Buy => (Asset::Res(o.resource), qty), Side::Sell => (Asset::Credits, total) };
        let mut ev = self.apply(&[Transfer { from: m.account.clone(), to: p.escrow(), asset, qty: amount, reason: Reason::ProposalHold { proposal: id } }])?;
        self.commit_id(id);
        let prof = self.profile(merchant).expect("a merchant");
        self.merchants.entry(merchant.into()).or_insert(prof).record.proposals += 1;
        ev.push(Event::ProposalPosted(p.clone()));
        self.proposals.insert(id, p);
        Ok(ev)
    }

    pub(crate) fn accept_proposal(&mut self, requester: &str, order: u64, proposal: u64) -> Result<Vec<Event>, EconError> {
        let o = self.orders.get(&order).cloned().ok_or_else(|| unknown("order", &order.to_string()))?;
        if o.requester != requester {
            return Err(EconError::Unauthorized { caller: requester.into(), action: "accept_proposal".into() });
        }
        if !o.is_open() || o.expires_at <= self.tick {
            return Err(EconError::OrderRejected { why: "the order is not open".into() });
        }
        let p = self.proposals.get(&proposal).cloned().ok_or_else(|| unknown("proposal", &proposal.to_string()))?;
        if p.order != order || p.status != ProposalStatus::Pending || p.expires_at <= self.tick {
            return Err(EconError::OrderRejected { why: "that proposal is no longer on the table".into() });
        }
        if p.qty > o.remaining() || (!o.allow_partial && p.qty != o.remaining()) || !within_limit(&o, p.qty, p.total) {
            return Err(EconError::OrderRejected { why: "the proposal doesn't fit the order".into() });
        }
        let merchant_acct = self.actor(&p.merchant)?.account.clone();
        let reason = Reason::OrderFill { order, proposal };
        let batch = match o.side {
            Side::Buy => vec![
                Transfer { from: p.escrow(), to: o.account.clone(), asset: Asset::Res(o.resource), qty: p.qty, reason: reason.clone() },
                Transfer { from: o.escrow(), to: merchant_acct, asset: Asset::Credits, qty: p.total, reason },
            ],
            Side::Sell => vec![
                Transfer { from: p.escrow(), to: o.account.clone(), asset: Asset::Credits, qty: p.total, reason: reason.clone() },
                Transfer { from: o.escrow(), to: merchant_acct, asset: Asset::Res(o.resource), qty: p.qty, reason },
            ],
        };
        let mut ev = self.apply(&batch)?;
        let trade = self.peek_id();
        self.commit_id(trade);
        let rec = TradeRecord { id: trade, tick: self.tick, party: o.account.clone(), resource: o.resource, side: o.side, qty: p.qty, total: p.total, gear: None, merchant: Some(p.merchant.clone()), order: Some(order) };
        self.trades.push(rec.clone());
        ev.push(Event::Traded(rec));
        {
            let o = self.orders.get_mut(&order).unwrap();
            o.filled += p.qty;
            o.settled_total += p.total;
            o.fills.push(Fill { proposal, merchant: p.merchant.clone(), qty: p.qty, total: p.total, tick: self.tick });
        }
        self.proposals.get_mut(&proposal).unwrap().status = ProposalStatus::Accepted;
        {
            let prof = self.profile(&p.merchant).expect("a merchant");
            let rec = &mut self.merchants.entry(p.merchant.clone()).or_insert(prof).record;
            match o.side { Side::Buy => rec.units_sold += p.qty, Side::Sell => rec.units_bought += p.qty }
            rec.revenue += if o.side == Side::Buy { p.total } else { -p.total };
        }
        let remaining = self.orders[&order].remaining();
        ev.push(Event::OrderFilled { order, proposal, merchant: p.merchant.clone(), qty: p.qty, total: p.total, remaining });
        if remaining == 0 {
            ev.extend(self.close_order(order, OrderStatus::Filled)?);
        }
        Ok(ev)
    }

    pub(crate) fn cancel_order(&mut self, requester: &str, order: u64) -> Result<Vec<Event>, EconError> {
        let o = self.orders.get(&order).ok_or_else(|| unknown("order", &order.to_string()))?;
        if o.requester != requester {
            return Err(EconError::Unauthorized { caller: requester.into(), action: "cancel_order".into() });
        }
        if !o.is_open() {
            return Err(EconError::OrderRejected { why: "the order is not open".into() });
        }
        self.close_order(order, OrderStatus::Cancelled)
    }

    /// Stop an order: release every pending proposal, refund unused escrow, and let
    /// each merchant that answered learn whether it won.
    fn close_order(&mut self, order: u64, status: OrderStatus) -> Result<Vec<Event>, EconError> {
        let mut ev = Vec::new();
        let pending: Vec<u64> = self.pending_proposals(order).map(|p| p.id).collect();
        for pid in pending {
            ev.extend(self.release_proposal(pid)?);
        }
        let o = self.orders[&order].clone();
        let (asset, amount) = o.escrowed();
        let refunded = if amount > 0 {
            ev.extend(self.apply(&[Transfer { from: o.escrow(), to: o.account.clone(), asset, qty: amount, reason: Reason::OrderRefund { order } }])?);
            amount
        } else {
            0
        };
        self.orders.get_mut(&order).unwrap().status = status.clone();
        self.version += 1;
        ev.push(Event::OrderClosed { order, status, filled: o.filled, settled_total: o.settled_total, refunded });
        ev.extend(self.adapt_merchants(order));
        Ok(ev)
    }

    fn release_proposal(&mut self, pid: u64) -> Result<Vec<Event>, EconError> {
        let p = self.proposals[&pid].clone();
        let o = &self.orders[&p.order];
        let m = self.actor(&p.merchant)?.account.clone();
        let (asset, amount) = match o.side { Side::Buy => (Asset::Res(o.resource), p.qty), Side::Sell => (Asset::Credits, p.total) };
        let mut ev = self.apply(&[Transfer { from: p.escrow(), to: m, asset, qty: amount, reason: Reason::ProposalRelease { proposal: pid } }])?;
        self.proposals.get_mut(&pid).unwrap().status = ProposalStatus::Released;
        ev.push(Event::ProposalReleased { proposal: pid, order: p.order, merchant: p.merchant });
        Ok(ev)
    }

    /// Winners and losers of a closed order update their records; a streak moves a
    /// merchant's margin one step (within the pricing bounds). Vex's margin is the
    /// market's, so its instant prices follow too.
    fn adapt_merchants(&mut self, order: u64) -> Vec<Event> {
        let winners: Vec<String> = self.orders[&order].fills.iter().map(|f| f.merchant.clone()).collect();
        let answered: Vec<String> = {
            let mut v: Vec<String> = self.proposals.values().filter(|p| p.order == order).map(|p| p.merchant.clone()).collect();
            v.sort();
            v.dedup();
            v
        };
        let mut ev = Vec::new();
        for m in answered {
            let Some(mut prof) = self.profile(&m) else { continue };
            let won = winners.contains(&m);
            let r = &mut prof.record;
            if won { r.wins += 1; r.streak = r.streak.max(0) + 1 } else { r.losses += 1; r.streak = r.streak.min(0) - 1 }
            let before = prof.strategy.margin_bp;
            let floor = prof.min_margin_bp;
            let why = if r.streak >= ADAPT_STREAK {
                prof.strategy.margin_bp = (before + ADAPT_STEP_BP).min(pricing::MARGIN_MAX_BP);
                r.streak = 0;
                Some(format!("won {ADAPT_STREAK} in a row: margin up"))
            } else if r.streak <= -ADAPT_STREAK {
                prof.strategy.margin_bp = (before - ADAPT_STEP_BP).max(floor).max(pricing::MARGIN_MIN_BP);
                r.streak = 0;
                Some(format!("lost {ADAPT_STREAK} in a row: margin down"))
            } else {
                None
            };
            let after = prof.strategy.margin_bp;
            if m == self.market.merchant {
                self.market.strategy = prof.strategy;
            }
            self.merchants.insert(m.clone(), prof);
            if let Some(why) = why.filter(|_| after != before) {
                ev.push(Event::MerchantAdapted { merchant: m, margin_bp: after, why });
            }
        }
        ev
    }

    /// Per tick: lapse proposals and orders past their expiry.
    pub(crate) fn expire_orders(&mut self) -> Vec<Event> {
        let mut ev = Vec::new();
        let lapsed: Vec<u64> = self.proposals.values().filter(|p| p.status == ProposalStatus::Pending && p.expires_at <= self.tick).map(|p| p.id).collect();
        for pid in lapsed {
            ev.extend(self.release_proposal(pid).expect("a proposal escrow holds its reservation"));
        }
        let expired: Vec<u64> = self.open_orders().filter(|o| o.expires_at <= self.tick).map(|o| o.id).collect();
        for oid in expired {
            ev.extend(self.close_order(oid, OrderStatus::Expired).expect("an order escrow holds its funding"));
        }
        ev
    }

    /// Credits or goods this account has tied up in open orders and proposals.
    pub fn reserved_by(&self, account: &str, asset: Asset) -> i64 {
        let orders: i64 = self.open_orders().filter(|o| o.account == account && o.escrowed().0 == asset).map(|o| o.escrowed().1).sum();
        let props: i64 = self
            .proposals
            .values()
            .filter(|p| p.status == ProposalStatus::Pending)
            .filter(|p| self.actors.get(&p.merchant).is_some_and(|a| a.account == account))
            .filter_map(|p| {
                let o = &self.orders[&p.order];
                let (a, n) = match o.side { Side::Buy => (Asset::Res(o.resource), p.qty), Side::Sell => (Asset::Credits, p.total) };
                (a == asset).then_some(n)
            })
            .sum();
        orders + props
    }
}

/// Halcyon Logistics: a lean contract supplier. Smaller shelves and a thinner margin
/// than Vex, but it won't commit more than 60% of a shelf to one order and keeps a
/// firmer floor, so it wins routine orders and loses big urgent ones.
pub fn halcyon_profile() -> MerchantProfile {
    MerchantProfile { strategy: Strategy { margin_bp: 1_200, spread_bp: 1_400 }, target: [80, 40, 80], min_margin_bp: 800, max_commit_bp: 6_000, capital: 4_000, record: MerchantRecord::default() }
}

pub fn production_floor(r: Resource, qty: i64, margin_bp: i64) -> i64 {
    (pricing::production_cost(r) * qty * (BP + margin_bp) + BP - 1) / BP
}
