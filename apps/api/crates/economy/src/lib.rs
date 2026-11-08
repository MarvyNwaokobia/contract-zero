//! CONTRACT ZERO economy: a deterministic, conservation-checked world.
//!
//! Everything of value is a balance of an [`Asset`] held by an account. Value only
//! moves through [`World::apply`], which validates a whole batch of transfers before
//! committing any of them: either every transfer in a command happens, or none does,
//! and no account other than [`WORLD`] can ever go negative.
//!
//! [`WORLD`] is the single source and sink. Issuance (production, income, supply
//! shipments) is a transfer *out of* it; destruction (consumption, logistics fuel,
//! escort wages, import costs) is a transfer *into* it. So for every asset the sum of
//! all balances, `WORLD` included, is always zero. Issuance and destruction are also
//! totalled separately from ordinary transfers ([`World::issued`] / [`World::destroyed`]).
//!
//! The engine is pure and integer-only: the same seed and commands produce the same
//! world on any machine. Time advances in ticks of one in-game hour.

pub mod mission;
pub mod policy;
pub mod pricing;
pub mod scenario;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub use mission::{GuardPlan, RaidPlan};
pub use pricing::{PriceBreakdown, Side, Strategy};

pub const WORLD: &str = "world";
pub const TICKS_PER_DAY: u64 = 24;
/// Escort wages per supply shipment, by defense level (index = level). Destroyed.
pub const DEFENSE_COST: [i64; 6] = [0, 0, 80, 200, 360, 560];
pub const DEFENSE_MIN: u8 = 1;
pub const DEFENSE_MAX: u8 = 5;
/// Fuel burned to run one supply shipment.
pub const LOGISTICS_FUEL: i64 = 10;
/// Merchant caravans buy cargo off-map at this share of production cost.
pub const IMPORT_COST_BP: i64 = 6_000;
/// A bounty must sit inside [depot value / 4, depot value × 1.5].
pub const BOUNTY_MIN_BP: i64 = 2_500;
pub const BOUNTY_MAX_BP: i64 = 15_000;
/// How long a posted bounty stays open.
pub const BOUNTY_TICKS: u64 = 24;

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
    pub fn name(self) -> &'static str {
        match self {
            Resource::Ammo => "ammo",
            Resource::Med => "med",
            Resource::Fuel => "fuel",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Asset {
    Credits,
    Res(Resource),
}

impl Asset {
    pub fn name(self) -> &'static str {
        match self {
            Asset::Credits => "credits",
            Asset::Res(r) => r.name(),
        }
    }

    pub fn parse(s: &str) -> Option<Asset> {
        Some(match s {
            "credits" => Asset::Credits,
            "ammo" => Asset::Res(Resource::Ammo),
            "med" => Asset::Res(Resource::Med),
            "fuel" => Asset::Res(Resource::Fuel),
            _ => return None,
        })
    }
}

// Serialized as a plain string so it can key a JSON object (balances are maps of
// asset → amount) and reads naturally in API responses.
impl Serialize for Asset {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.name())
    }
}

impl<'de> Deserialize<'de> for Asset {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Asset::parse(&s).ok_or_else(|| serde::de::Error::custom(format!("unknown asset {s}")))
    }
}

pub type AccountId = String;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum Reason {
    Genesis,
    Income,
    Production,
    Consumption,
    Logistics { convoy: u64 },
    EscortWages { convoy: u64 },
    ImportCost { convoy: u64 },
    Shipment { convoy: u64 },
    ShipmentArrived { convoy: u64 },
    Trade { trade: u64 },
    /// Undoes a trade whose on-chain settlement failed.
    TradeReversal { trade: u64 },
    Escrow { bounty: u64 },
    Refund { bounty: u64 },
    BountyPaid { bounty: u64, raid: u64 },
    Raid { raid: u64 },
}

impl Reason {
    /// Is this a source (issuance) or a sink (destruction), as opposed to a transfer?
    pub fn class(&self) -> &'static str {
        match self {
            Reason::Genesis | Reason::Income | Reason::Production | Reason::Shipment { .. } => "issuance",
            Reason::Consumption | Reason::Logistics { .. } | Reason::EscortWages { .. } | Reason::ImportCost { .. } => "destruction",
            _ => "transfer",
        }
    }
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

/// A recurring supply run from off-map: costs fuel and escort wages, brings cargo.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShipmentPlan {
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
    /// Credits the actor never spends below. For the merchant, the insolvency line.
    pub credit_reserve: i64,
    pub defense: u8,
    pub shipment: Option<ShipmentPlan>,
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
}

impl Convoy {
    pub fn account(&self) -> AccountId {
        format!("convoy:{}", self.id)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum RaidStatus {
    Active,
    Extracted { units: i64, bounty: i64 },
    Failed,
}

/// A deployment against a faction's depot. Its plan is fixed when it starts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Raid {
    pub id: u64,
    pub player: String,
    pub plan: RaidPlan,
    pub started_at: u64,
    pub status: RaidStatus,
}

/// A sponsor's escrowed bounty on raiding a faction's depot of one resource.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum BountyStatus {
    Open,
    Paid { raid: u64, player: String },
    Expired,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bounty {
    pub id: u64,
    pub sponsor: String,
    pub target: String,
    pub resource: Resource,
    pub amount: i64,
    pub posted_at: u64,
    pub expires_at: u64,
    pub status: BountyStatus,
}

impl Bounty {
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
    PostBounty { target: String, resource: Resource, amount: i64 },
    ConfigureDefense { level: u8 },
    SetStrategy { strategy: Strategy },
    StartRaid { target: String, resource: Resource },
    SettleRaid { raid: u64, player: String },
    FailRaid { raid: u64, player: String },
}

impl Action {
    pub fn name(&self) -> &'static str {
        match self {
            Action::Trade { .. } => "trade",
            Action::PostBounty { .. } => "post_bounty",
            Action::ConfigureDefense { .. } => "configure_defense",
            Action::SetStrategy { .. } => "set_strategy",
            Action::StartRaid { .. } => "start_raid",
            Action::SettleRaid { .. } => "settle_raid",
            Action::FailRaid { .. } => "fail_raid",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "event")]
pub enum Event {
    Transfer(LedgerEntry),
    Shortage { actor: String, resource: Resource, missing: i64 },
    LogisticsGrounded { actor: String, fuel: i64 },
    ShipmentDispatched { convoy: u64, owner: String, resource: Resource, units: i64, defense: u8 },
    ShipmentArrived { convoy: u64 },
    MerchantSuspended { reason: String },
    BountyPosted { bounty: u64, sponsor: String, target: String, resource: Resource, amount: i64 },
    BountyExpired { bounty: u64 },
    RaidStarted { raid: u64, player: String, target: String, resource: Resource, manifest: i64 },
    RaidExtracted { raid: u64, player: String, units: i64, bounty: i64 },
    RaidFailed { raid: u64, player: String },
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
    #[error("the merchant is insolvent and not buying")]
    MerchantInsolvent,
    #[error("bounty {amount} outside [{min}, {max}]")]
    BountyOutOfRange { amount: i64, min: i64, max: i64 },
    #[error("no raidable {resource:?} depot at {target}")]
    NoRaidTarget { target: String, resource: Resource },
    #[error("cannot target yourself")]
    SelfTarget,
    #[error("unknown {what} {id}")]
    Unknown { what: String, id: String },
    #[error("raid {raid} is not active")]
    RaidNotActive { raid: u64 },
    #[error("raid {raid} was already settled")]
    AlreadySettled { raid: u64 },
    #[error("player already has an active raid")]
    RaidInProgress,
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
    pub raids: BTreeMap<u64, Raid>,
    pub bounties: BTreeMap<u64, Bounty>,
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
    pub fn empty(seed: u64, market: Market) -> Self {
        World {
            tick: 0,
            version: 0,
            seed,
            balances: BTreeMap::new(),
            actors: BTreeMap::new(),
            market,
            convoys: BTreeMap::new(),
            raids: BTreeMap::new(),
            bounties: BTreeMap::new(),
            trades: Vec::new(),
            ledger: Vec::new(),
            next_id: 0,
        }
    }

    // ── reads ────────────────────────────────────────────────────────────────

    pub fn balance(&self, account: &str, asset: Asset) -> i64 {
        self.balances.get(account).and_then(|m| m.get(&asset)).copied().unwrap_or(0)
    }

    pub fn actor(&self, id: &str) -> Result<&Actor, EconError> {
        self.actors.get(id).ok_or_else(|| unknown("actor", id))
    }

    pub fn merchant(&self) -> &Actor {
        &self.actors[&self.market.merchant]
    }

    pub fn merchant_stock(&self, r: Resource) -> i64 {
        self.balance(&self.merchant().account, Asset::Res(r))
    }

    /// Below its credit reserve the merchant stops buying and stops restocking.
    pub fn merchant_insolvent(&self) -> bool {
        let m = self.merchant();
        self.balance(&m.account, Asset::Credits) < m.credit_reserve
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

    pub fn open_bounties(&self) -> impl Iterator<Item = &Bounty> {
        self.bounties.values().filter(|b| b.status == BountyStatus::Open)
    }

    /// The open bounty a raid on (target, resource) would collect, if any (oldest first).
    pub fn bounty_for(&self, target: &str, resource: Resource) -> Option<&Bounty> {
        self.open_bounties().find(|b| b.target == target && b.resource == resource)
    }

    pub fn active_raid_of(&self, player: &str) -> Option<&Raid> {
        self.raids.values().find(|r| r.player == player && r.status == RaidStatus::Active)
    }

    /// Raids extracted against `target` within the last `ticks`.
    pub fn recent_raids_on(&self, target: &str, ticks: u64) -> usize {
        let since = self.tick.saturating_sub(ticks);
        self.raids
            .values()
            .filter(|r| r.plan.target == target && r.started_at >= since && matches!(r.status, RaidStatus::Extracted { .. }))
            .count()
    }

    /// Sum of every balance of `asset`, `WORLD` included. Always zero.
    pub fn total(&self, asset: Asset) -> i64 {
        self.balances.values().filter_map(|m| m.get(&asset)).sum()
    }

    /// Total ever issued (created) / destroyed for an asset, from the ledger.
    pub fn issued(&self, asset: Asset) -> i64 {
        self.ledger.iter().filter(|e| e.transfer.asset == asset && e.transfer.reason.class() == "issuance").map(|e| e.transfer.qty).sum()
    }

    pub fn destroyed(&self, asset: Asset) -> i64 {
        self.ledger.iter().filter(|e| e.transfer.asset == asset && e.transfer.reason.class() == "destruction").map(|e| e.transfer.qty).sum()
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
            Action::PostBounty { target, resource, amount } => self.post_bounty(caller_actor(caller), target, *resource, *amount),
            Action::ConfigureDefense { level } => self.configure_defense(caller_actor(caller), *level),
            Action::SetStrategy { strategy } => {
                self.market.strategy = strategy.clamped();
                self.version += 1;
                Ok(vec![Event::StrategyChanged { strategy: self.market.strategy }])
            }
            Action::StartRaid { target, resource } => self.start_raid(caller_player(caller), target, *resource),
            Action::SettleRaid { raid, player } => self.settle_raid(*raid, player),
            Action::FailRaid { raid, player } => self.fail_raid(*raid, player),
        }
    }

    /// Returns the account the command spends from. Agents act only for their own
    /// actor; players only for themselves; only the system settles or fails raids.
    fn authorize(&self, caller: &Caller, action: &Action) -> Result<AccountId, EconError> {
        let deny = || EconError::Unauthorized { caller: format!("{caller:?}"), action: action.name().into() };
        match (caller, action) {
            (Caller::Agent(id), Action::Trade { .. } | Action::PostBounty { .. } | Action::ConfigureDefense { .. }) => {
                let a = self.actor(id)?;
                if a.kind == ActorKind::Merchant && !matches!(action, Action::PostBounty { .. }) {
                    return Err(deny()); // the merchant is the market: it doesn't trade with itself or run escorts
                }
                Ok(a.account.clone())
            }
            (Caller::Agent(id), Action::SetStrategy { .. }) => {
                if *id == self.market.merchant { Ok(self.actor(id)?.account.clone()) } else { Err(deny()) }
            }
            (Caller::Player(p), Action::Trade { .. } | Action::StartRaid { .. }) => Ok(player_account(p)),
            (Caller::System, Action::SettleRaid { .. } | Action::FailRaid { .. }) => Ok(WORLD.into()),
            _ => Err(deny()),
        }
    }

    fn trade(&mut self, party: &str, r: Resource, side: Side, qty: i64, limit_total: i64) -> Result<Vec<Event>, EconError> {
        if side == Side::Sell && self.merchant_insolvent() {
            return Err(EconError::MerchantInsolvent);
        }
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

    fn post_bounty(&mut self, sponsor: &str, target: &str, r: Resource, amount: i64) -> Result<Vec<Event>, EconError> {
        if sponsor == target {
            return Err(EconError::SelfTarget);
        }
        let plan = mission::raid_plan(self, target, r).ok_or_else(|| EconError::NoRaidTarget { target: target.into(), resource: r })?;
        let value = plan.manifest * pricing::production_cost(r);
        let (min, max) = (value * BOUNTY_MIN_BP / pricing::BP, value * BOUNTY_MAX_BP / pricing::BP);
        if amount < min || amount > max {
            return Err(EconError::BountyOutOfRange { amount, min, max });
        }
        let id = self.peek_id();
        let b = Bounty { id, sponsor: sponsor.into(), target: target.into(), resource: r, amount, posted_at: self.tick, expires_at: self.tick + BOUNTY_TICKS, status: BountyStatus::Open };
        let account = self.actor(sponsor)?.account.clone();
        let mut ev = self.apply(&[Transfer { from: account, to: b.escrow(), asset: Asset::Credits, qty: amount, reason: Reason::Escrow { bounty: id } }])?;
        self.commit_id(id);
        self.bounties.insert(id, b);
        ev.push(Event::BountyPosted { bounty: id, sponsor: sponsor.into(), target: target.into(), resource: r, amount });
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

    /// Lock in the raid plan from current state. Nothing moves yet.
    fn start_raid(&mut self, player: &str, target: &str, r: Resource) -> Result<Vec<Event>, EconError> {
        if self.active_raid_of(player).is_some() {
            return Err(EconError::RaidInProgress);
        }
        let plan = mission::raid_plan(self, target, r).ok_or_else(|| EconError::NoRaidTarget { target: target.into(), resource: r })?;
        let id = self.peek_id();
        self.commit_id(id);
        let manifest = plan.manifest;
        self.raids.insert(id, Raid { id, player: player.into(), plan, started_at: self.tick, status: RaidStatus::Active });
        self.version += 1;
        Ok(vec![Event::RaidStarted { raid: id, player: player.into(), target: target.into(), resource: r, manifest }])
    }

    /// The raid succeeded: the depot's cargo goes to the player, plus any open bounty on
    /// that depot. The player receives what the depot actually holds now, up to the
    /// planned manifest, so nothing is ever created. Settling twice is rejected.
    fn settle_raid(&mut self, id: u64, player: &str) -> Result<Vec<Event>, EconError> {
        let raid = self.raids.get(&id).ok_or_else(|| unknown("raid", &id.to_string()))?.clone();
        match &raid.status {
            RaidStatus::Extracted { .. } => return Err(EconError::AlreadySettled { raid: id }),
            RaidStatus::Failed => return Err(EconError::RaidNotActive { raid: id }),
            RaidStatus::Active if raid.player != player => return Err(EconError::RaidNotActive { raid: id }),
            RaidStatus::Active => {}
        }
        let target = self.actor(&raid.plan.target)?.account.clone();
        let asset = Asset::Res(raid.plan.resource);
        let units = raid.plan.manifest.min(self.balance(&target, asset));
        let to = player_account(player);
        let mut batch = Vec::new();
        if units > 0 {
            batch.push(Transfer { from: target, to: to.clone(), asset, qty: units, reason: Reason::Raid { raid: id } });
        }
        let bounty = self.bounty_for(&raid.plan.target, raid.plan.resource).cloned();
        if let Some(b) = &bounty {
            batch.push(Transfer { from: b.escrow(), to, asset: Asset::Credits, qty: b.amount, reason: Reason::BountyPaid { bounty: b.id, raid: id } });
        }
        let mut ev = self.apply(&batch)?;
        let paid = bounty.as_ref().map_or(0, |b| b.amount);
        if let Some(b) = bounty {
            self.bounties.get_mut(&b.id).unwrap().status = BountyStatus::Paid { raid: id, player: player.into() };
        }
        self.raids.get_mut(&id).unwrap().status = RaidStatus::Extracted { units, bounty: paid };
        self.version += 1;
        ev.push(Event::RaidExtracted { raid: id, player: player.into(), units, bounty: paid });
        Ok(ev)
    }

    fn fail_raid(&mut self, id: u64, player: &str) -> Result<Vec<Event>, EconError> {
        let raid = self.raids.get_mut(&id).ok_or_else(|| unknown("raid", &id.to_string()))?;
        if raid.status != RaidStatus::Active || raid.player != player {
            return Err(EconError::RaidNotActive { raid: id });
        }
        raid.status = RaidStatus::Failed;
        self.version += 1;
        Ok(vec![Event::RaidFailed { raid: id, player: player.into() }])
    }

    // ── time ─────────────────────────────────────────────────────────────────

    /// Advance one tick: income, production and consumption, shipment arrivals,
    /// bounty expiry, then dispatches.
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
                let used = want.min(self.balance(&a.account, Asset::Res(r)));
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
            ev.extend(self.apply(&[Transfer { from: c.account(), to: owner, asset: Asset::Res(c.resource), qty: c.units, reason: Reason::ShipmentArrived { convoy: c.id } }]).expect("convoy holds its cargo"));
            self.convoys.get_mut(&c.id).unwrap().status = ConvoyStatus::Arrived;
            ev.push(Event::ShipmentArrived { convoy: c.id });
        }

        let expired: Vec<Bounty> = self.open_bounties().filter(|b| b.expires_at <= t).cloned().collect();
        for b in expired {
            let sponsor = self.actors[&b.sponsor].account.clone();
            ev.extend(self.apply(&[Transfer { from: b.escrow(), to: sponsor, asset: Asset::Credits, qty: b.amount, reason: Reason::Refund { bounty: b.id } }]).expect("escrow holds the bounty"));
            self.bounties.get_mut(&b.id).unwrap().status = BountyStatus::Expired;
            ev.push(Event::BountyExpired { bounty: b.id });
        }

        for id in &ids {
            let Some(plan) = self.actors[id].shipment.clone() else { continue };
            if plan.next_dispatch != t {
                continue;
            }
            ev.extend(self.dispatch(id, &plan));
            self.actors.get_mut(id).unwrap().shipment.as_mut().unwrap().next_dispatch = t + plan.every_ticks;
        }

        self.tick += 1;
        self.version += 1;
        ev
    }

    /// Send a supply shipment. A faction's shipment burns `LOGISTICS_FUEL` (no fuel, no
    /// shipment) and pays escort wages at the best defense level it can afford. A
    /// merchant caravan pays import cost, shrinking to what it can afford above its
    /// reserve; an insolvent merchant does not restock.
    fn dispatch(&mut self, actor_id: &str, plan: &ShipmentPlan) -> Vec<Event> {
        let a = self.actors[actor_id].clone();
        let is_faction = a.kind == ActorKind::Faction;
        if !is_faction && self.merchant_insolvent() {
            return vec![Event::MerchantSuspended { reason: "insolvent: restocking paused".into() }];
        }
        let fuel = self.balance(&a.account, Asset::Res(Resource::Fuel));
        if is_faction && fuel < LOGISTICS_FUEL {
            return vec![Event::LogisticsGrounded { actor: actor_id.into(), fuel }];
        }
        let credits = self.balance(&a.account, Asset::Credits);
        let mut level = a.defense.clamp(DEFENSE_MIN, DEFENSE_MAX);
        while level > DEFENSE_MIN && DEFENSE_COST[level as usize] > credits {
            level -= 1;
        }
        let wages = if is_faction { DEFENSE_COST[level as usize] } else { 0 };
        let unit_import = pricing::production_cost(plan.resource) * IMPORT_COST_BP / pricing::BP;
        let units = if is_faction { plan.units } else { plan.units.min((credits - a.credit_reserve).max(0) / unit_import.max(1)) };
        if units <= 0 {
            return vec![];
        }
        let id = self.peek_id();
        let convoy = Convoy { id, owner: actor_id.into(), resource: plan.resource, units, defense: level, dispatched_at: self.tick, arrives_at: self.tick + plan.transit_ticks, status: ConvoyStatus::InTransit };
        let mut batch = vec![Transfer { from: WORLD.into(), to: convoy.account(), asset: Asset::Res(plan.resource), qty: units, reason: Reason::Shipment { convoy: id } }];
        if is_faction {
            batch.push(Transfer { from: a.account.clone(), to: WORLD.into(), asset: Asset::Res(Resource::Fuel), qty: LOGISTICS_FUEL, reason: Reason::Logistics { convoy: id } });
        }
        if wages > 0 {
            batch.push(Transfer { from: a.account.clone(), to: WORLD.into(), asset: Asset::Credits, qty: wages, reason: Reason::EscortWages { convoy: id } });
        }
        if !is_faction {
            batch.push(Transfer { from: a.account.clone(), to: WORLD.into(), asset: Asset::Credits, qty: units * unit_import, reason: Reason::ImportCost { convoy: id } });
        }
        let mut ev = self.apply(&batch).expect("dispatch is sized to what the actor can afford");
        self.commit_id(id);
        ev.push(Event::ShipmentDispatched { convoy: id, owner: actor_id.into(), resource: plan.resource, units, defense: level });
        self.convoys.insert(id, convoy);
        ev
    }

    /// Undo a committed trade (used when its on-chain settlement fails). Both legs go
    /// back in one atomic batch; it fails cleanly if either side no longer holds what it
    /// received. A trade is reversed at most once. Never reachable from `execute`.
    pub fn reverse_trade(&mut self, trade_id: u64) -> Result<Vec<Event>, EconError> {
        if self.ledger.iter().any(|e| e.transfer.reason == (Reason::TradeReversal { trade: trade_id })) {
            return Err(EconError::AlreadySettled { raid: trade_id });
        }
        let legs: Vec<Transfer> = self
            .ledger
            .iter()
            .filter(|e| e.transfer.reason == (Reason::Trade { trade: trade_id }))
            .map(|e| Transfer { from: e.transfer.to.clone(), to: e.transfer.from.clone(), asset: e.transfer.asset, qty: e.transfer.qty, reason: Reason::TradeReversal { trade: trade_id } })
            .collect();
        if legs.len() != 2 {
            return Err(unknown("trade", &trade_id.to_string()));
        }
        self.apply(&legs)
    }

    /// Credit an account from `WORLD` when building a starting state. Never reachable
    /// from a command.
    pub fn grant(&mut self, account: &str, asset: Asset, qty: i64) {
        self.apply(&[Transfer { from: WORLD.into(), to: account.into(), asset, qty, reason: Reason::Genesis }]).expect("grant");
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

fn unknown(what: &str, id: &str) -> EconError {
    EconError::Unknown { what: what.into(), id: id.into() }
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

pub use scenario::{acceptance, genesis, MERCHANT, VANGUARD};
