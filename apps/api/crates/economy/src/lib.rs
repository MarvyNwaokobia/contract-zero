//! CONTRACT ZERO economy: a deterministic, conservation-checked world.
//!
//! Everything of value is a balance of an [`Asset`] held by an account. Value only
//! moves through [`World::apply`], which validates a whole batch of transfers before
//! committing any of them: either every transfer in a command happens, or none does,
//! and no account other than [`WORLD`] can ever go negative.
//!
//! [`WORLD`] is the single source and sink. Issuance (faction production, income,
//! convoy cargo arriving from off-map) is a transfer *out of* it; sinks (consumption,
//! escort wages, import costs) are transfers *into* it. So for every asset the sum of
//! all balances, `WORLD` included, is always exactly zero, and `WORLD`'s balance is
//! minus the net amount ever issued. See `docs/contract-zero/ECONOMY.md`.
//!
//! The engine is pure and integer-only: the same seed and the same commands produce the
//! same world on any machine. Time advances in ticks of one in-game hour.

pub mod policy;
pub mod pricing;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub use pricing::{PriceBreakdown, Side, Strategy};

pub const WORLD: &str = "world";
pub const TICKS_PER_DAY: u64 = 24;
/// Escort wages per convoy, by defense level (index = level). Paid to `WORLD` at dispatch.
pub const DEFENSE_COST: [i64; 6] = [0, 0, 80, 200, 360, 560];
pub const DEFENSE_MIN: u8 = 1;
pub const DEFENSE_MAX: u8 = 5;
/// Merchant caravans buy cargo off-map at this share of production cost.
pub const IMPORT_COST_BP: i64 = 6_000;
/// A contract's bounty must sit inside [cargo value / 4, cargo value × 1.5].
pub const BOUNTY_MIN_BP: i64 = 2_500;
pub const BOUNTY_MAX_BP: i64 = 15_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Resource {
    Ammo,
    Med,
    Fuel,
}

impl Resource {
    pub const ALL: [Resource; 3] = [Resource::Ammo, Resource::Med, Resource::Fuel];
    pub fn idx(self) -> usize {
        self as usize
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Asset {
    Credits,
    Res(Resource),
}

pub type AccountId = String;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum Reason {
    Income,
    Production,
    Consumption,
    EscortWages { convoy: u64 },
    ImportCost { convoy: u64 },
    ConvoyCargo { convoy: u64 },
    ConvoyArrived { convoy: u64 },
    Trade { trade: u64 },
    Escrow { contract: u64 },
    Refund { contract: u64 },
    Bounty { contract: u64 },
    Raid { contract: u64 },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Transfer {
    pub from: AccountId,
    pub to: AccountId,
    pub asset: Asset,
    pub qty: i64,
    pub reason: Reason,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LedgerEntry {
    pub seq: u64,
    pub tick: u64,
    #[serde(flatten)]
    pub transfer: Transfer,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActorKind {
    Faction,
    Merchant,
}

/// A per-day amount for each resource, spread evenly over the day's ticks.
pub type PerDay = [i64; 3];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConvoyPlan {
    pub resource: Resource,
    pub units: i64,
    pub every_ticks: u64,
    pub transit_ticks: u64,
    pub next_dispatch: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Actor {
    pub id: String,
    pub name: String,
    pub kind: ActorKind,
    pub account: AccountId,
    pub income_per_day: i64,
    pub production: PerDay,
    pub consumption: PerDay,
    /// Operational requirement: hold at least this many days of consumption.
    pub reserve_days: i64,
    /// Credits the actor tries never to spend below.
    pub credit_reserve: i64,
    pub defense: u8,
    pub convoy: Option<ConvoyPlan>,
}

impl Actor {
    pub fn requirement(&self, r: Resource) -> i64 {
        self.consumption[r.idx()] * self.reserve_days
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Market {
    pub merchant: String,
    pub target: [i64; 3],
    pub strategy: Strategy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvoyStatus {
    InTransit,
    Arrived,
    Raided,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Convoy {
    pub id: u64,
    pub owner: String,
    pub resource: Resource,
    pub units: i64,
    pub defense: u8,
    pub dispatched_at: u64,
    pub arrives_at: u64,
    pub status: ConvoyStatus,
    pub seed: u32,
}

impl Convoy {
    pub fn account(&self) -> AccountId {
        format!("convoy:{}", self.id)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum ContractStatus {
    Open,
    Accepted { player: String },
    Completed { player: String },
    Expired,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Contract {
    pub id: u64,
    pub issuer: String,
    pub convoy: u64,
    pub bounty: i64,
    pub posted_at: u64,
    pub expires_at: u64,
    pub status: ContractStatus,
}

impl Contract {
    pub fn escrow(&self) -> AccountId {
        format!("escrow:{}", self.id)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TradeRecord {
    pub id: u64,
    pub tick: u64,
    pub party: AccountId,
    pub resource: Resource,
    pub side: Side,
    pub qty: i64,
    pub total: i64,
}

/// Who is issuing a command. Authorization is decided from this alone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "id")]
pub enum Caller {
    /// An NPC agent acting for the actor with this id.
    Agent(String),
    /// A player, by account id (NEAR account).
    Player(String),
    /// The game server: ticks and mission settlement.
    System,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "action")]
pub enum Action {
    Trade { resource: Resource, side: Side, qty: i64, limit_total: i64 },
    PostContract { convoy: u64, bounty: i64 },
    ConfigureDefense { level: u8 },
    SetStrategy { strategy: Strategy },
    AcceptContract { contract: u64 },
    AbandonContract { contract: u64 },
    SettleRaid { contract: u64, player: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "event")]
pub enum Event {
    Transfer(LedgerEntry),
    Shortage { actor: String, resource: Resource, missing: i64 },
    ConvoyDispatched { convoy: u64, owner: String, resource: Resource, units: i64, defense: u8 },
    ConvoyArrived { convoy: u64 },
    ConvoyRaided { convoy: u64, contract: u64, player: String },
    ContractPosted { contract: u64, issuer: String, convoy: u64, bounty: i64 },
    ContractExpired { contract: u64 },
    ContractAccepted { contract: u64, player: String },
    ContractAbandoned { contract: u64, player: String },
    Traded(TradeRecord),
    DefenseChanged { actor: String, level: u8 },
    StrategyChanged { strategy: Strategy },
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "error")]
pub enum EconError {
    #[error("{caller} is not allowed to {action}")]
    Unauthorized { caller: String, action: String },
    #[error("insufficient {asset:?} in {account}: has {have}, needs {need}")]
    Insufficient { account: AccountId, asset: Asset, have: i64, need: i64 },
    #[error("quantity must be positive")]
    BadQuantity,
    #[error("transfer from an account to itself")]
    SelfTransfer,
    #[error("price moved: total {total} is outside the limit {limit}")]
    PriceMoved { total: i64, limit: i64 },
    #[error("the merchant cannot fill {qty}: holds {stock}")]
    MerchantShort { qty: i64, stock: i64 },
    #[error("bounty {bounty} outside [{min}, {max}]")]
    BountyOutOfRange { bounty: i64, min: i64, max: i64 },
    #[error("unknown {what} {id}")]
    Unknown { what: String, id: String },
    #[error("convoy {convoy} is not in transit")]
    ConvoyNotInTransit { convoy: u64 },
    #[error("convoy {convoy} already has an open contract")]
    ConvoyAlreadyContracted { convoy: u64 },
    #[error("cannot post a contract against your own convoy")]
    OwnConvoy,
    #[error("contract {contract} is {state}, not {expected}")]
    ContractState { contract: u64, state: String, expected: String },
    #[error("contract {contract} was already settled")]
    AlreadySettled { contract: u64 },
    #[error("defense level must be {DEFENSE_MIN}…{DEFENSE_MAX}")]
    BadDefense,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct World {
    pub tick: u64,
    /// Bumped on every committed change; quotes are tied to it.
    pub version: u64,
    pub seed: u64,
    pub balances: BTreeMap<AccountId, BTreeMap<Asset, i64>>,
    pub actors: BTreeMap<String, Actor>,
    pub market: Market,
    pub convoys: BTreeMap<u64, Convoy>,
    pub contracts: BTreeMap<u64, Contract>,
    pub trades: Vec<TradeRecord>,
    pub ledger: Vec<LedgerEntry>,
    next_id: u64,
}

/// A read-only quote. `version` is the world version it was computed at.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Quote {
    pub resource: Resource,
    pub side: Side,
    pub qty: i64,
    pub total: i64,
    pub unit_now: PriceBreakdown,
    pub version: u64,
}

impl World {
    // ── reads ────────────────────────────────────────────────────────────────

    pub fn balance(&self, account: &str, asset: Asset) -> i64 {
        self.balances.get(account).and_then(|m| m.get(&asset)).copied().unwrap_or(0)
    }

    pub fn actor(&self, id: &str) -> Result<&Actor, EconError> {
        self.actors.get(id).ok_or_else(|| unknown("actor", id))
    }

    fn merchant(&self) -> &Actor {
        &self.actors[&self.market.merchant]
    }

    pub fn merchant_stock(&self, r: Resource) -> i64 {
        self.balance(&self.merchant().account, Asset::Res(r))
    }

    /// Units the merchant sold minus units it bought over the last day.
    pub fn net_demand_24h(&self, r: Resource) -> i64 {
        let since = self.tick.saturating_sub(TICKS_PER_DAY);
        self.trades
            .iter()
            .filter(|t| t.resource == r && t.tick >= since)
            .map(|t| match t.side { Side::Buy => t.qty, Side::Sell => -t.qty })
            .sum()
    }

    pub fn price(&self, r: Resource) -> PriceBreakdown {
        pricing::price(r, self.merchant_stock(r), self.market.target[r.idx()], self.net_demand_24h(r), self.market.strategy)
    }

    pub fn quote(&self, r: Resource, side: Side, qty: i64) -> Result<Quote, EconError> {
        if qty <= 0 {
            return Err(EconError::BadQuantity);
        }
        let stock = self.merchant_stock(r);
        let total = pricing::walk_total(r, side, qty, stock, self.market.target[r.idx()], self.net_demand_24h(r), self.market.strategy)
            .ok_or(EconError::MerchantShort { qty, stock })?;
        Ok(Quote { resource: r, side, qty, total, unit_now: self.price(r), version: self.version })
    }

    /// Fair value of a convoy's cargo at production cost.
    pub fn cargo_value(&self, convoy: &Convoy) -> i64 {
        convoy.units * pricing::production_cost(convoy.resource)
    }

    pub fn bounty_range(&self, convoy: &Convoy) -> (i64, i64) {
        let v = self.cargo_value(convoy);
        (v * BOUNTY_MIN_BP / pricing::BP, v * BOUNTY_MAX_BP / pricing::BP)
    }

    pub fn open_contracts(&self) -> impl Iterator<Item = &Contract> {
        self.contracts.values().filter(|c| c.status == ContractStatus::Open)
    }

    /// Sum of every balance of `asset`, `WORLD` included. Always zero.
    pub fn total(&self, asset: Asset) -> i64 {
        self.balances.values().filter_map(|m| m.get(&asset)).sum()
    }

    // ── the only way value moves ─────────────────────────────────────────────

    /// Validate and commit a batch atomically. Checks the batch's NET effect on every
    /// account, so the order of transfers inside a batch never matters.
    pub fn apply(&mut self, batch: &[Transfer]) -> Result<Vec<Event>, EconError> {
        let mut net: BTreeMap<(&str, Asset), i64> = BTreeMap::new();
        for t in batch {
            if t.qty <= 0 {
                return Err(EconError::BadQuantity);
            }
            if t.from == t.to {
                return Err(EconError::SelfTransfer);
            }
            *net.entry((t.from.as_str(), t.asset)).or_default() -= t.qty;
            *net.entry((t.to.as_str(), t.asset)).or_default() += t.qty;
        }
        for (&(acct, asset), &delta) in &net {
            if acct == WORLD || delta >= 0 {
                continue;
            }
            let have = self.balance(acct, asset);
            if have + delta < 0 {
                return Err(EconError::Insufficient { account: acct.to_string(), asset, have, need: -delta });
            }
        }
        let mut events = Vec::with_capacity(batch.len());
        for t in batch {
            *self.balances.entry(t.from.clone()).or_default().entry(t.asset).or_default() -= t.qty;
            *self.balances.entry(t.to.clone()).or_default().entry(t.asset).or_default() += t.qty;
            let e = LedgerEntry { seq: self.ledger.len() as u64, tick: self.tick, transfer: t.clone() };
            self.ledger.push(e.clone());
            events.push(Event::Transfer(e));
        }
        if !batch.is_empty() {
            self.version += 1;
        }
        Ok(events)
    }

    /// The id the next committed object will get. Only `commit_id` consumes it, so a
    /// command that fails leaves the counter (and the whole world) unchanged.
    fn peek_id(&self) -> u64 {
        self.next_id + 1
    }

    fn commit_id(&mut self, id: u64) {
        debug_assert_eq!(id, self.next_id + 1);
        self.next_id = id;
    }

    // ── commands ─────────────────────────────────────────────────────────────

    /// Authorize, validate and execute one command. On error nothing has changed.
    pub fn execute(&mut self, caller: &Caller, action: &Action) -> Result<Vec<Event>, EconError> {
        let account = self.authorize(caller, action)?;
        match action {
            Action::Trade { resource, side, qty, limit_total } => self.trade(&account, *resource, *side, *qty, *limit_total),
            Action::PostContract { convoy, bounty } => self.post_contract(caller_actor(caller), *convoy, *bounty),
            Action::ConfigureDefense { level } => self.configure_defense(caller_actor(caller), *level),
            Action::SetStrategy { strategy } => {
                self.market.strategy = strategy.clamped();
                self.version += 1;
                Ok(vec![Event::StrategyChanged { strategy: self.market.strategy }])
            }
            Action::AcceptContract { contract } => self.accept(*contract, caller_player(caller)),
            Action::AbandonContract { contract } => self.abandon(*contract, caller_player(caller)),
            Action::SettleRaid { contract, player } => self.settle_raid(*contract, player),
        }
    }

    /// Returns the account the command spends from. Agents act only for their own
    /// actor; players only for themselves; only the system settles raids.
    fn authorize(&self, caller: &Caller, action: &Action) -> Result<AccountId, EconError> {
        let deny = || EconError::Unauthorized { caller: format!("{caller:?}"), action: action_name(action).into() };
        match (caller, action) {
            (Caller::Agent(id), Action::Trade { .. } | Action::PostContract { .. } | Action::ConfigureDefense { .. }) => {
                let a = self.actor(id)?;
                if matches!(action, Action::Trade { .. }) && a.kind == ActorKind::Merchant {
                    return Err(deny()); // the merchant is the market; it doesn't trade with itself
                }
                Ok(a.account.clone())
            }
            (Caller::Agent(id), Action::SetStrategy { .. }) => {
                if *id == self.market.merchant { Ok(self.actor(id)?.account.clone()) } else { Err(deny()) }
            }
            (Caller::Player(p), Action::Trade { .. } | Action::AcceptContract { .. } | Action::AbandonContract { .. }) => {
                Ok(player_account(p))
            }
            (Caller::System, Action::SettleRaid { .. }) => Ok(WORLD.into()),
            _ => Err(deny()),
        }
    }

    fn trade(&mut self, party: &str, r: Resource, side: Side, qty: i64, limit_total: i64) -> Result<Vec<Event>, EconError> {
        let q = self.quote(r, side, qty)?;
        let ok = match side { Side::Buy => q.total <= limit_total, Side::Sell => q.total >= limit_total };
        if !ok {
            return Err(EconError::PriceMoved { total: q.total, limit: limit_total });
        }
        let merchant = self.merchant().account.clone();
        let id = self.peek_id();
        let (payer, payee, giver, taker) = match side {
            Side::Buy => (party.to_string(), merchant.clone(), merchant, party.to_string()),
            Side::Sell => (merchant.clone(), party.to_string(), party.to_string(), merchant),
        };
        let mut ev = self.apply(&[
            Transfer { from: payer, to: payee, asset: Asset::Credits, qty: q.total, reason: Reason::Trade { trade: id } },
            Transfer { from: giver, to: taker, asset: Asset::Res(r), qty, reason: Reason::Trade { trade: id } },
        ])?;
        self.commit_id(id);
        let rec = TradeRecord { id, tick: self.tick, party: party.to_string(), resource: r, side, qty, total: q.total };
        self.trades.push(rec.clone());
        ev.push(Event::Traded(rec));
        Ok(ev)
    }

    fn post_contract(&mut self, issuer: &str, convoy_id: u64, bounty: i64) -> Result<Vec<Event>, EconError> {
        let convoy = self.convoys.get(&convoy_id).ok_or_else(|| unknown("convoy", &convoy_id.to_string()))?.clone();
        if convoy.status != ConvoyStatus::InTransit {
            return Err(EconError::ConvoyNotInTransit { convoy: convoy_id });
        }
        if convoy.owner == issuer {
            return Err(EconError::OwnConvoy);
        }
        if self.contracts.values().any(|c| c.convoy == convoy_id && matches!(c.status, ContractStatus::Open | ContractStatus::Accepted { .. })) {
            return Err(EconError::ConvoyAlreadyContracted { convoy: convoy_id });
        }
        let (min, max) = self.bounty_range(&convoy);
        if bounty < min || bounty > max {
            return Err(EconError::BountyOutOfRange { bounty, min, max });
        }
        let id = self.peek_id();
        let c = Contract { id, issuer: issuer.into(), convoy: convoy_id, bounty, posted_at: self.tick, expires_at: convoy.arrives_at, status: ContractStatus::Open };
        let account = self.actor(issuer)?.account.clone();
        let mut ev = self.apply(&[Transfer { from: account, to: c.escrow(), asset: Asset::Credits, qty: bounty, reason: Reason::Escrow { contract: id } }])?;
        self.commit_id(id);
        self.contracts.insert(id, c);
        ev.push(Event::ContractPosted { contract: id, issuer: issuer.into(), convoy: convoy_id, bounty });
        Ok(ev)
    }

    fn configure_defense(&mut self, actor: &str, level: u8) -> Result<Vec<Event>, EconError> {
        if !(DEFENSE_MIN..=DEFENSE_MAX).contains(&level) {
            return Err(EconError::BadDefense);
        }
        self.actors.get_mut(actor).ok_or_else(|| unknown("actor", actor))?.defense = level;
        self.version += 1;
        Ok(vec![Event::DefenseChanged { actor: actor.into(), level }])
    }

    fn contract_mut(&mut self, id: u64) -> Result<&mut Contract, EconError> {
        self.contracts.get_mut(&id).ok_or_else(|| unknown("contract", &id.to_string()))
    }

    fn accept(&mut self, id: u64, player: &str) -> Result<Vec<Event>, EconError> {
        let tick = self.tick;
        let c = self.contract_mut(id)?;
        if c.status != ContractStatus::Open || tick >= c.expires_at {
            return Err(state_err(c, "open"));
        }
        c.status = ContractStatus::Accepted { player: player.into() };
        self.version += 1;
        Ok(vec![Event::ContractAccepted { contract: id, player: player.into() }])
    }

    fn abandon(&mut self, id: u64, player: &str) -> Result<Vec<Event>, EconError> {
        let c = self.contract_mut(id)?;
        if c.status != (ContractStatus::Accepted { player: player.into() }) {
            return Err(state_err(c, "accepted by you"));
        }
        c.status = ContractStatus::Open;
        self.version += 1;
        Ok(vec![Event::ContractAbandoned { contract: id, player: player.into() }])
    }

    /// The raid succeeded: the bounty goes to the player and the convoy's cargo to the
    /// issuer, in one atomic batch. Settling the same contract twice is an error.
    fn settle_raid(&mut self, id: u64, player: &str) -> Result<Vec<Event>, EconError> {
        let c = self.contracts.get(&id).ok_or_else(|| unknown("contract", &id.to_string()))?.clone();
        match &c.status {
            ContractStatus::Completed { .. } => return Err(EconError::AlreadySettled { contract: id }),
            ContractStatus::Accepted { player: p } if p == player => {}
            _ => return Err(state_err(&c, "accepted by this player")),
        }
        let convoy = self.convoys[&c.convoy].clone();
        if convoy.status != ConvoyStatus::InTransit {
            return Err(EconError::ConvoyNotInTransit { convoy: convoy.id });
        }
        let issuer = self.actor(&c.issuer)?.account.clone();
        let mut ev = self.apply(&[
            Transfer { from: c.escrow(), to: player_account(player), asset: Asset::Credits, qty: c.bounty, reason: Reason::Bounty { contract: id } },
            Transfer { from: convoy.account(), to: issuer, asset: Asset::Res(convoy.resource), qty: convoy.units, reason: Reason::Raid { contract: id } },
        ])?;
        self.contracts.get_mut(&id).unwrap().status = ContractStatus::Completed { player: player.into() };
        self.convoys.get_mut(&convoy.id).unwrap().status = ConvoyStatus::Raided;
        ev.push(Event::ConvoyRaided { convoy: convoy.id, contract: id, player: player.into() });
        Ok(ev)
    }

    // ── time ─────────────────────────────────────────────────────────────────

    /// Advance one tick: income, production and consumption, convoy arrivals (and
    /// expiry of their contracts), then dispatches.
    pub fn tick(&mut self) -> Vec<Event> {
        let t = self.tick;
        let mut ev = Vec::new();
        let ids: Vec<String> = self.actors.keys().cloned().collect();

        for id in &ids {
            let a = self.actors[id].clone();
            let mut batch = Vec::new();
            let inc = spread(a.income_per_day, t);
            if inc > 0 {
                batch.push(Transfer { from: WORLD.into(), to: a.account.clone(), asset: Asset::Credits, qty: inc, reason: Reason::Income });
            }
            for r in Resource::ALL {
                let p = spread(a.production[r.idx()], t);
                if p > 0 {
                    batch.push(Transfer { from: WORLD.into(), to: a.account.clone(), asset: Asset::Res(r), qty: p, reason: Reason::Production });
                }
            }
            ev.extend(self.apply(&batch).expect("issuance cannot fail"));
            // Consumption burns what exists; any gap is a shortage, never a negative balance.
            for r in Resource::ALL {
                let want = spread(a.consumption[r.idx()], t);
                let have = self.balance(&a.account, Asset::Res(r));
                let used = want.min(have);
                if used > 0 {
                    ev.extend(self.apply(&[Transfer { from: a.account.clone(), to: WORLD.into(), asset: Asset::Res(r), qty: used, reason: Reason::Consumption }]).expect("checked"));
                }
                if want > used {
                    ev.push(Event::Shortage { actor: id.clone(), resource: r, missing: want - used });
                }
            }
        }

        let arriving: Vec<Convoy> = self.convoys.values().filter(|c| c.status == ConvoyStatus::InTransit && c.arrives_at <= t).cloned().collect();
        for c in arriving {
            let owner = self.actors[&c.owner].account.clone();
            ev.extend(self.apply(&[Transfer { from: c.account(), to: owner, asset: Asset::Res(c.resource), qty: c.units, reason: Reason::ConvoyArrived { convoy: c.id } }]).expect("convoy holds its cargo"));
            self.convoys.get_mut(&c.id).unwrap().status = ConvoyStatus::Arrived;
            ev.push(Event::ConvoyArrived { convoy: c.id });
            let expiring: Vec<Contract> = self.contracts.values().filter(|k| k.convoy == c.id && matches!(k.status, ContractStatus::Open | ContractStatus::Accepted { .. })).cloned().collect();
            for k in expiring {
                let issuer = self.actors[&k.issuer].account.clone();
                ev.extend(self.apply(&[Transfer { from: k.escrow(), to: issuer, asset: Asset::Credits, qty: k.bounty, reason: Reason::Refund { contract: k.id } }]).expect("escrow holds the bounty"));
                self.contracts.get_mut(&k.id).unwrap().status = ContractStatus::Expired;
                ev.push(Event::ContractExpired { contract: k.id });
            }
        }

        for id in &ids {
            let Some(plan) = self.actors[id].convoy.clone() else { continue };
            if plan.next_dispatch != t {
                continue;
            }
            ev.extend(self.dispatch(id, &plan));
            self.actors.get_mut(id).unwrap().convoy.as_mut().unwrap().next_dispatch = t + plan.every_ticks;
        }

        self.tick += 1;
        self.version += 1;
        ev
    }

    /// Send a convoy. Escort wages are paid up front at the actor's chosen defense level,
    /// dropping to the best level it can afford; a merchant caravan also pays import cost,
    /// shrinking the load to what it can afford.
    fn dispatch(&mut self, actor_id: &str, plan: &ConvoyPlan) -> Vec<Event> {
        let a = self.actors[actor_id].clone();
        let credits = self.balance(&a.account, Asset::Credits);
        let mut level = a.defense.clamp(DEFENSE_MIN, DEFENSE_MAX);
        while level > DEFENSE_MIN && DEFENSE_COST[level as usize] > credits {
            level -= 1;
        }
        let wages = DEFENSE_COST[level as usize];
        let unit_import = pricing::production_cost(plan.resource) * IMPORT_COST_BP / pricing::BP;
        let units = if a.kind == ActorKind::Merchant { plan.units.min((credits - wages).max(0) / unit_import.max(1)) } else { plan.units };
        if units <= 0 {
            return vec![];
        }
        let id = self.peek_id();
        let seed = (splitmix(self.seed ^ id) & 0xffff_ffff) as u32;
        let convoy = Convoy { id, owner: actor_id.into(), resource: plan.resource, units, defense: level, dispatched_at: self.tick, arrives_at: self.tick + plan.transit_ticks, status: ConvoyStatus::InTransit, seed };
        let mut batch = vec![Transfer { from: WORLD.into(), to: convoy.account(), asset: Asset::Res(plan.resource), qty: units, reason: Reason::ConvoyCargo { convoy: id } }];
        if wages > 0 {
            batch.push(Transfer { from: a.account.clone(), to: WORLD.into(), asset: Asset::Credits, qty: wages, reason: Reason::EscortWages { convoy: id } });
        }
        if a.kind == ActorKind::Merchant {
            batch.push(Transfer { from: a.account.clone(), to: WORLD.into(), asset: Asset::Credits, qty: units * unit_import, reason: Reason::ImportCost { convoy: id } });
        }
        let mut ev = self.apply(&batch).expect("dispatch is sized to what the actor can afford");
        self.commit_id(id);
        ev.push(Event::ConvoyDispatched { convoy: id, owner: actor_id.into(), resource: plan.resource, units, defense: level });
        self.convoys.insert(id, convoy);
        ev
    }
}

// ── helpers ──────────────────────────────────────────────────────────────────

pub fn player_account(player: &str) -> AccountId {
    format!("player:{player}")
}

fn caller_actor(c: &Caller) -> &str {
    match c { Caller::Agent(id) => id, _ => "" }
}

fn caller_player(c: &Caller) -> &str {
    match c { Caller::Player(p) => p, _ => "" }
}

fn action_name(a: &Action) -> &'static str {
    match a {
        Action::Trade { .. } => "trade",
        Action::PostContract { .. } => "post_contract",
        Action::ConfigureDefense { .. } => "configure_defense",
        Action::SetStrategy { .. } => "set_strategy",
        Action::AcceptContract { .. } => "accept_contract",
        Action::AbandonContract { .. } => "abandon_contract",
        Action::SettleRaid { .. } => "settle_raid",
    }
}

fn unknown(what: &str, id: &str) -> EconError {
    EconError::Unknown { what: what.into(), id: id.into() }
}

fn state_err(c: &Contract, expected: &str) -> EconError {
    let state = match &c.status {
        ContractStatus::Open => "open",
        ContractStatus::Accepted { .. } => "accepted",
        ContractStatus::Completed { .. } => "completed",
        ContractStatus::Expired => "expired",
    };
    EconError::ContractState { contract: c.id, state: state.into(), expected: expected.into() }
}

/// The share of a per-day amount that falls in tick `t`: spreads `d` over the day's
/// ticks with no rounding drift (the 24 shares always sum to exactly `d`).
pub fn spread(per_day: i64, t: u64) -> i64 {
    let h = (t % TICKS_PER_DAY) as i64;
    let n = TICKS_PER_DAY as i64;
    (h + 1) * per_day / n - h * per_day / n
}

pub fn splitmix(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9e37_79b9_7f4a_7c15);
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    x ^ (x >> 31)
}

// ── the starting world ───────────────────────────────────────────────────────

pub const IRONVEIL: &str = "ironveil";
pub const VEX: &str = "vex";

/// The seeded starting state: one faction (Ironveil) and one independent merchant (Vex).
pub fn genesis(seed: u64) -> World {
    let ironveil = Actor {
        id: IRONVEIL.into(),
        name: "Ironveil Directorate".into(),
        kind: ActorKind::Faction,
        account: "faction:ironveil".into(),
        income_per_day: 960,
        production: [72, 0, 0],
        consumption: [24, 12, 96],
        reserve_days: 2,
        credit_reserve: 1_000,
        defense: 2,
        convoy: Some(ConvoyPlan { resource: Resource::Fuel, units: 60, every_ticks: 12, transit_ticks: 6, next_dispatch: 0 }),
    };
    let vex = Actor {
        id: VEX.into(),
        name: "Vex Exchange".into(),
        kind: ActorKind::Merchant,
        account: "merchant:vex".into(),
        income_per_day: 0,
        production: [0, 0, 0],
        consumption: [0, 0, 0],
        reserve_days: 0,
        credit_reserve: 800,
        defense: 1,
        convoy: Some(ConvoyPlan { resource: Resource::Med, units: 40, every_ticks: 24, transit_ticks: 8, next_dispatch: 3 }),
    };
    let mut w = World {
        tick: 0,
        version: 0,
        seed,
        balances: BTreeMap::new(),
        actors: BTreeMap::new(),
        market: Market { merchant: VEX.into(), target: [120, 60, 120], strategy: Strategy { margin_bp: 2_000, spread_bp: 1_000 } },
        convoys: BTreeMap::new(),
        contracts: BTreeMap::new(),
        trades: Vec::new(),
        ledger: Vec::new(),
        next_id: 0,
    };
    let seed_balances = [
        (&ironveil.account, Asset::Credits, 4_000),
        (&ironveil.account, Asset::Res(Resource::Ammo), 100),
        (&ironveil.account, Asset::Res(Resource::Med), 30),
        (&ironveil.account, Asset::Res(Resource::Fuel), 200),
        (&vex.account, Asset::Credits, 3_000),
        (&vex.account, Asset::Res(Resource::Ammo), 80),
        (&vex.account, Asset::Res(Resource::Med), 50),
        (&vex.account, Asset::Res(Resource::Fuel), 60),
    ];
    let batch: Vec<Transfer> = seed_balances
        .iter()
        .map(|(acct, asset, qty)| Transfer { from: WORLD.into(), to: (*acct).clone(), asset: *asset, qty: *qty, reason: Reason::Production })
        .collect();
    w.apply(&batch).expect("genesis issuance");
    w.actors.insert(ironveil.id.clone(), ironveil);
    w.actors.insert(vex.id.clone(), vex);
    w
}
