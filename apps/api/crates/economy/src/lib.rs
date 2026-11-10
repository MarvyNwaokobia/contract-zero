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

pub mod consequence;
pub mod mission;
pub mod orders;
pub mod policy;
pub mod pricing;
pub mod scenario;
pub mod site;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub use mission::{GuardPlan, RaidPlan};
pub use orders::{Fill, MerchantProfile, MerchantRecord, OrderStatus, Proposal, ProposalStatus, SupplyOrder};
pub use pricing::{PriceBreakdown, Side, Strategy};

pub const WORLD: &str = "world";
/// The boundary of the modelled economy: NEAR holdings outside this game (other
/// wallets, other apps). Players own their tokens and may move them anywhere, so a
/// player's balance is resynced from chain through this account. Like `WORLD` it may
/// go negative; unlike `WORLD`, what crosses it is a transfer, never issuance.
pub const OUTSIDE: &str = "outside";
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
/// A sabotaged production line stays down this long.
pub const SABOTAGE_TICKS: u64 = 36;
/// Share of the targeted stock a successful sabotage destroys.
pub const SABOTAGE_SHARE_BP: i64 = 4_000;

/// What an operation does when it succeeds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpKind {
    /// Take the depot's cargo for yourself.
    #[default]
    Raid,
    /// Destroy stock and stop the faction producing that resource for a while.
    Sabotage,
    /// Retrieve seized cargo and return it to its owner, for the owner's fee.
    Recovery,
}

impl OpKind {
    pub fn name(self) -> &'static str {
        match self {
            OpKind::Raid => "raid",
            OpKind::Sabotage => "sabotage",
            OpKind::Recovery => "recovery",
        }
    }
}
/// Live-world rules (see [`Market::living`]).
/// The merchant reviews its shelves this often, and its caravans take this long.
pub const MERCHANT_RESTOCK_TICKS: u64 = 12;
pub const MERCHANT_TRANSIT_TICKS: u64 = 6;
/// What the merchant gets for surplus it exports, relative to production cost.
pub const EXPORT_PRICE_BP: i64 = 5_000;
/// What a live-world merchant pays to import, relative to production cost.
pub const MERCHANT_IMPORT_BP: i64 = 9_000;
/// Merchant capital beyond this is paid out to its backers (destroyed), so trading
/// profit cannot pile up forever while the factions it trades with go broke.
pub const MERCHANT_CAPITAL: i64 = 6_000;
/// A live-world faction keeps at most this many days of income in its treasury; the
/// rest is remitted to its command (destroyed), so a quiet faction can't hoard its way
/// to invulnerability.
pub const WAR_CHEST_DAYS: i64 = 10;
/// A faction's daily garrison pay by defense level (index = level).
pub const UPKEEP_PER_DAY: [i64; 6] = [0, 60, 140, 260, 420, 640];

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

/// Equipment a player can own: a token per gun (`gun:<id>`), sold by the merchant's
/// armory at a list price. Standard issue (SMG, assault rifle) is never a token.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Gear {
    Marksman,
    AshfallCarbine,
    SeraphLmg,
}

impl Gear {
    pub const ALL: [Gear; 3] = [Gear::Marksman, Gear::AshfallCarbine, Gear::SeraphLmg];
    /// The client's gun id.
    pub fn id(self) -> &'static str {
        match self {
            Gear::Marksman => "marksman",
            Gear::AshfallCarbine => "ashfall_carbine",
            Gear::SeraphLmg => "seraph_lmg",
        }
    }
    /// The NEP-245 token id on the assets contract.
    pub fn token(self) -> &'static str {
        match self {
            Gear::Marksman => "gun:marksman",
            Gear::AshfallCarbine => "gun:ashfall_carbine",
            Gear::SeraphLmg => "gun:seraph_lmg",
        }
    }
    pub fn title(self) -> &'static str {
        match self {
            Gear::Marksman => "Marksman Rifle",
            Gear::AshfallCarbine => "Dustline Carbine",
            Gear::SeraphLmg => "Seraph",
        }
    }
    /// What the merchant asks, before a player's standing discount.
    pub fn list_price(self) -> i64 {
        match self {
            Gear::Marksman => 800,
            Gear::AshfallCarbine => 1_300,
            Gear::SeraphLmg => 2_400,
        }
    }
    pub fn parse(s: &str) -> Option<Gear> {
        Gear::ALL.into_iter().find(|g| g.id() == s || g.token() == s)
    }
}

/// The merchant keeps this many of each gun in its armory, on consignment: it pays
/// its supplier this share of the list price when one sells.
pub const ARMORY_STOCK: i64 = 2;
pub const ARMORY_COST_BP: i64 = 6_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Asset {
    Credits,
    Res(Resource),
    Gear(Gear),
}

/// Every asset the economy moves, in a fixed order.
pub const ALL_ASSETS: [Asset; 7] = [
    Asset::Credits,
    Asset::Res(Resource::Ammo),
    Asset::Res(Resource::Med),
    Asset::Res(Resource::Fuel),
    Asset::Gear(Gear::Marksman),
    Asset::Gear(Gear::AshfallCarbine),
    Asset::Gear(Gear::SeraphLmg),
];

impl Asset {
    pub fn name(self) -> &'static str {
        match self {
            Asset::Credits => "credits",
            Asset::Res(r) => r.name(),
            Asset::Gear(g) => g.token(),
        }
    }

    pub fn parse(s: &str) -> Option<Asset> {
        Some(match s {
            "credits" => Asset::Credits,
            "ammo" => Asset::Res(Resource::Ammo),
            "med" => Asset::Res(Resource::Med),
            "fuel" => Asset::Res(Resource::Fuel),
            other => Asset::Gear(Gear::parse(other).filter(|g| g.token() == other)?),
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
    /// Stock destroyed by a sabotage operation.
    Sabotage { raid: u64 },
    /// Seized cargo returned to its owner by a recovery operation.
    Recovered { raid: u64 },
    /// A caravan's cargo taken on the road by a faction.
    Seized { convoy: u64 },
    /// A faction's daily garrison pay (destroyed).
    Upkeep,
    /// Merchant surplus sold out of the region (goods destroyed)…
    Export,
    /// …and the credits it brought in (issued).
    ExportRevenue,
    /// Merchant profit paid out of the region (destroyed).
    Dividend,
    /// A supply order's funding, held until it fills, is cancelled or expires…
    OrderEscrow { order: u64 },
    /// …and what it didn't use, returned.
    OrderRefund { order: u64 },
    /// A merchant's side of a proposal, reserved so it can't be promised twice…
    ProposalHold { proposal: u64 },
    /// …and released when the proposal loses or lapses.
    ProposalRelease { proposal: u64 },
    /// An accepted proposal: both escrows change hands.
    OrderFill { order: u64, proposal: u64 },
    /// Faction treasury above its war chest, remitted to command (destroyed).
    Remittance,
    /// The merchant's side of a player quote, held so no one else can buy or spend it.
    QuoteHold { quote: u64 },
    /// A quote that was not accepted in time: the hold goes back to the merchant.
    QuoteRelease { quote: u64 },
    /// Tokens a player moved into or out of the game on NEAR (resynced from chain).
    External,
    /// A gun brought into the merchant's armory (issued)…
    Armory,
    /// …and what the merchant paid its supplier for it (destroyed).
    ArmoryCost,
}

impl Reason {
    /// Is this a source (issuance) or a sink (destruction), as opposed to a transfer?
    pub fn class(&self) -> &'static str {
        match self {
            Reason::Genesis | Reason::Income | Reason::Production | Reason::Shipment { .. } | Reason::ExportRevenue | Reason::Armory => "issuance",
            Reason::Consumption | Reason::Logistics { .. } | Reason::EscortWages { .. } | Reason::ImportCost { .. } | Reason::Upkeep | Reason::Export | Reason::Dividend | Reason::Remittance | Reason::Sabotage { .. } | Reason::ArmoryCost => "destruction",
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
    /// Per resource: production is down (sabotaged) until this tick.
    #[serde(default)]
    pub disrupted_until: [u64; 3],
    /// How this actor's commander behaves (factions).
    #[serde(default)]
    pub doctrine: Doctrine,
}

/// A faction's character: what it does with the same numbers another faction sees.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Doctrine {
    /// Defense level in a quiet period.
    pub base_defense: u8,
    /// Most it will pay, as a multiple of production cost, unless critically short.
    pub max_price_mult: i64,
    /// 0 (holds ground, only retaliates) … 100 (pays to have rivals raided first).
    pub aggression: u8,
}

impl Default for Doctrine {
    fn default() -> Self {
        Doctrine { base_defense: 2, max_price_mult: 2, aggression: 20 }
    }
}

/// What a faction remembers about who hurt it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FactionMemory {
    /// Per player: the operations they ran against this faction.
    pub players: BTreeMap<String, Grievance>,
    /// Per rival actor: the ticks at which it paid a bounty for a raid on this faction.
    pub sponsors: BTreeMap<String, Vec<u64>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grievance {
    pub raids: u32,
    pub sabotage: u32,
    pub recoveries: u32,
    pub units_lost: i64,
    pub last_tick: u64,
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
    /// Live-world rules: the merchant restocks every shelf by caravan and exports
    /// surplus, and factions pay daily garrison upkeep. Off in the fixed acceptance
    /// scenario, where nothing may change unless a test acts.
    #[serde(default)]
    pub living: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvoyStatus {
    InTransit,
    Arrived,
    /// Taken on the road by a faction; its cargo went to that faction.
    Seized { by: String },
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
    /// What the sponsor is paying for (a raid bounty, a sabotage or a recovery contract).
    #[serde(default)]
    pub kind: OpKind,
    /// Recovery: the seized caravan, and how many units to bring back.
    #[serde(default)]
    pub convoy: Option<u64>,
    #[serde(default)]
    pub units: i64,
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
    /// A gun sale: `resource` is then meaningless and the trade is not part of the
    /// resource market (prices, demand).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gear: Option<Gear>,
    /// The merchant on the other side (absent: Vex's instant market).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merchant: Option<String>,
    /// The supply order this trade filled, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<u64>,
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
    /// Settle with only the cargo the player physically secured (`units`, counted by
    /// the server from the session's own manifest). A raid's bounty needs at least
    /// half the manifest; sabotage and recovery are all-or-nothing upstream.
    SettleSecured { raid: u64, player: String, units: i64 },
    FailRaid { raid: u64, player: String },
    /// A sabotage or recovery operation (a raid is `StartRaid`).
    StartOperation { kind: OpKind, target: String, resource: Resource },
    /// A sponsor's escrowed contract for a sabotage or recovery (raid bounties are `PostBounty`).
    PostContract { kind: OpKind, target: String, resource: Resource, amount: i64, convoy: Option<u64> },
    /// A faction takes a merchant caravan on the road.
    SeizeConvoy { convoy: u64 },
    /// Place a supply order (factions and players). `nonce` must exceed the
    /// requester's last; `limit_total` is the most it pays (buy) or least it takes (sell).
    PlaceOrder { side: Side, resource: Resource, qty: i64, limit_total: i64, allow_partial: bool, ttl_ticks: u64, nonce: u64, #[serde(default)] urgency: u8, #[serde(default)] purpose: String, #[serde(default)] chain_id: Option<String> },
    /// A merchant answers an open order.
    Propose { order: u64, qty: i64, total: i64, #[serde(default)] note: String },
    /// The requester takes one proposal.
    AcceptProposal { order: u64, proposal: u64 },
    /// The requester withdraws an open order.
    CancelOrder { order: u64 },
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
            Action::SettleSecured { .. } => "settle_secured",
            Action::FailRaid { .. } => "fail_raid",
            Action::StartOperation { .. } => "start_operation",
            Action::PostContract { .. } => "post_contract",
            Action::SeizeConvoy { .. } => "seize_convoy",
            Action::PlaceOrder { .. } => "place_order",
            Action::Propose { .. } => "propose",
            Action::AcceptProposal { .. } => "accept_proposal",
            Action::CancelOrder { .. } => "cancel_order",
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
    MerchantExported { resource: Resource, units: i64, revenue: i64 },
    BountyPosted { bounty: u64, sponsor: String, target: String, resource: Resource, amount: i64 },
    BountyExpired { bounty: u64 },
    RaidStarted { raid: u64, player: String, target: String, resource: Resource, manifest: i64 },
    RaidExtracted { raid: u64, player: String, units: i64, bounty: i64 },
    RaidFailed { raid: u64, player: String },
    Traded(TradeRecord),
    DefenseChanged { actor: String, level: u8 },
    StrategyChanged { strategy: Strategy },
    ConvoySeized { convoy: u64, by: String, resource: Resource, units: i64 },
    ProductionDisrupted { actor: String, resource: Resource, until: u64 },
    ContractPosted { contract: u64, kind: OpKind, sponsor: String, target: String, resource: Resource, amount: i64 },
    QuoteReserved(PlayerQuote),
    QuoteSettled { quote: u64, trade: u64 },
    QuoteReleased { quote: u64 },
    HoldingSynced { account: AccountId, asset: Asset, from: i64, to: i64 },
    OrderPlaced(SupplyOrder),
    ProposalPosted(Proposal),
    OrderFilled { order: u64, proposal: u64, merchant: String, qty: i64, total: i64, remaining: i64 },
    ProposalReleased { proposal: u64, order: u64, merchant: String },
    OrderClosed { order: u64, status: OrderStatus, filled: i64, settled_total: i64, refunded: i64 },
    MerchantAdapted { merchant: String, margin_bp: i64, why: String },
    ArmoryRestocked { gear: Gear },
}

/// The merchant's view of a player: (minimum score, tier, discount in bp).
pub const VEX_TIERS: [(i64, &str, i64); 3] = [(10, "Known", 300), (50, "Trusted", 600), (150, "Partner", 1_000)];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FactionStanding {
    pub actor: String,
    pub name: String,
    pub jobs_for: u32,
    pub earned_from: i64,
    pub operations_against: u32,
    pub units_taken: i64,
    pub score: i64,
    pub tier: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Standing {
    pub vex_score: i64,
    pub vex_tier: String,
    pub vex_discount_bp: i64,
    pub vex_traded: i64,
    pub factions: Vec<FactionStanding>,
}

/// A firm price the merchant gave one player. The merchant's side (goods for a
/// purchase, credits for a sale) is held in escrow until the player accepts or the
/// quote is released.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlayerQuote {
    pub id: u64,
    pub player: String,
    pub resource: Resource,
    /// From the player's side: `Buy` = the player buys from the merchant.
    pub side: Side,
    pub qty: i64,
    pub total: i64,
    pub posted_at: u64,
    pub status: QuoteStatus,
    /// A gun from the armory instead of a resource (always a player purchase).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gear: Option<Gear>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum QuoteStatus {
    Open,
    Settled { trade: u64 },
    Released,
}

impl PlayerQuote {
    pub fn escrow(&self) -> AccountId {
        format!("quote:{}", self.id)
    }
    /// The goods side of the quote.
    pub fn goods(&self) -> Asset {
        self.gear.map(Asset::Gear).unwrap_or(Asset::Res(self.resource))
    }
    /// What the merchant holds for this quote.
    pub fn held(&self) -> (Asset, i64) {
        match self.side {
            Side::Buy => (self.goods(), self.qty),
            Side::Sell => (Asset::Credits, self.total),
        }
    }
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
    #[error("a contract like this is already open")]
    ContractExists,
    #[error("player already has an open quote")]
    QuoteOpen,
    #[error("quote {quote} is not open")]
    QuoteNotOpen { quote: u64 },
    #[error("player already has an active raid")]
    RaidInProgress,
    #[error("defense level must be {DEFENSE_MIN}…{DEFENSE_MAX}")]
    BadDefense,
    #[error("order refused: {why}")]
    OrderRejected { why: String },
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
    #[serde(default)]
    pub quotes: BTreeMap<u64, PlayerQuote>,
    /// Per faction: what it remembers about players and rivals.
    #[serde(default)]
    pub memory: BTreeMap<String, FactionMemory>,
    /// Supply orders and the merchant proposals answering them.
    #[serde(default)]
    pub orders: BTreeMap<u64, SupplyOrder>,
    #[serde(default)]
    pub proposals: BTreeMap<u64, Proposal>,
    /// Merchant profiles and records (Vex's strategy and targets live in `market`).
    #[serde(default)]
    pub merchants: BTreeMap<String, MerchantProfile>,
    /// Per requester: the highest order nonce used.
    #[serde(default)]
    pub order_nonces: BTreeMap<String, u64>,
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
            quotes: BTreeMap::new(),
            memory: BTreeMap::new(),
            orders: BTreeMap::new(),
            proposals: BTreeMap::new(),
            merchants: BTreeMap::new(),
            order_nonces: BTreeMap::new(),
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
            .filter(|t| t.gear.is_none() && t.resource == r && t.tick >= since)
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
    /// The open raid bounty on (target, resource), if any.
    pub fn bounty_for(&self, target: &str, resource: Resource) -> Option<&Bounty> {
        self.contract_for(OpKind::Raid, target, resource)
    }

    /// The open contract of `kind` on (target, resource), oldest first.
    pub fn contract_for(&self, kind: OpKind, target: &str, resource: Resource) -> Option<&Bounty> {
        self.open_bounties().find(|b| b.kind == kind && b.target == target && b.resource == resource)
    }

    /// Is `actor`'s production of `r` currently down?
    pub fn disrupted(&self, actor: &str, r: Resource) -> bool {
        self.actors.get(actor).is_some_and(|a| a.disrupted_until[r.idx()] > self.tick)
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
            if acct == WORLD || acct == OUTSIDE || delta >= 0 {
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
            Action::SettleRaid { raid, player } => self.settle_raid(*raid, player, None),
            Action::SettleSecured { raid, player, units } => self.settle_raid(*raid, player, Some(*units)),
            Action::FailRaid { raid, player } => self.fail_raid(*raid, player),
            Action::StartOperation { kind, target, resource } => self.start_operation(caller_player(caller), *kind, target, *resource),
            Action::PostContract { kind, target, resource, amount, convoy } => self.post_contract(caller_actor(caller), *kind, target, *resource, *amount, *convoy),
            Action::SeizeConvoy { convoy } => self.seize_convoy(caller_actor(caller), *convoy),
            Action::PlaceOrder { side, resource, qty, limit_total, allow_partial, ttl_ticks, nonce, urgency, purpose, chain_id } => {
                self.place_order(&requester_id(caller), &account, *side, *resource, *qty, *limit_total, *allow_partial, *ttl_ticks, *nonce, *urgency, purpose, chain_id.as_deref())
            }
            Action::Propose { order, qty, total, note } => self.propose(caller_actor(caller), *order, *qty, *total, note),
            Action::AcceptProposal { order, proposal } => self.accept_proposal(&requester_id(caller), *order, *proposal),
            Action::CancelOrder { order } => self.cancel_order(&requester_id(caller), *order),
        }
    }

    /// Returns the account the command spends from. Agents act only for their own
    /// actor; players only for themselves; only the system settles or fails raids.
    fn authorize(&self, caller: &Caller, action: &Action) -> Result<AccountId, EconError> {
        let deny = || EconError::Unauthorized { caller: format!("{caller:?}"), action: action.name().into() };
        match (caller, action) {
            (Caller::Agent(id), Action::SeizeConvoy { .. }) => {
                let a = self.actor(id)?;
                if a.kind != ActorKind::Faction {
                    return Err(deny());
                }
                Ok(a.account.clone())
            }
            (Caller::Agent(id), Action::Trade { .. } | Action::PostBounty { .. } | Action::PostContract { .. } | Action::ConfigureDefense { .. }) => {
                let a = self.actor(id)?;
                if a.kind == ActorKind::Merchant && !matches!(action, Action::PostBounty { .. } | Action::PostContract { .. }) {
                    return Err(deny()); // the merchant is the market: it doesn't trade with itself or run escorts
                }
                Ok(a.account.clone())
            }
            (Caller::Agent(id), Action::SetStrategy { .. }) => {
                if *id == self.market.merchant { Ok(self.actor(id)?.account.clone()) } else { Err(deny()) }
            }
            (Caller::Agent(id), Action::PlaceOrder { .. } | Action::AcceptProposal { .. } | Action::CancelOrder { .. }) => {
                let a = self.actor(id)?;
                if a.kind != ActorKind::Faction {
                    return Err(deny()); // merchants answer orders; they don't place them
                }
                Ok(a.account.clone())
            }
            (Caller::Agent(id), Action::Propose { .. }) => {
                let a = self.actor(id)?;
                if a.kind != ActorKind::Merchant {
                    return Err(deny());
                }
                Ok(a.account.clone())
            }
            (Caller::Player(p), Action::Trade { .. } | Action::StartRaid { .. } | Action::StartOperation { .. } | Action::PlaceOrder { .. } | Action::AcceptProposal { .. } | Action::CancelOrder { .. }) => Ok(player_account(p)),
            (Caller::System, Action::SettleRaid { .. } | Action::SettleSecured { .. } | Action::FailRaid { .. }) => Ok(WORLD.into()),
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
        let rec = TradeRecord { id, tick: self.tick, party: party.to_string(), resource: r, side, qty, total: q.total, gear: None, merchant: None, order: None };
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
        let b = Bounty { id, sponsor: sponsor.into(), target: target.into(), resource: r, amount, kind: OpKind::Raid, convoy: None, units: 0, posted_at: self.tick, expires_at: self.tick + BOUNTY_TICKS, status: BountyStatus::Open };
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
    /// A sponsor escrows the fee for a sabotage or a recovery.
    fn post_contract(&mut self, sponsor: &str, kind: OpKind, target: &str, r: Resource, amount: i64, convoy: Option<u64>) -> Result<Vec<Event>, EconError> {
        if sponsor == target {
            return Err(EconError::SelfTarget);
        }
        let t = self.actor(target)?.clone();
        if t.kind != ActorKind::Faction {
            return Err(EconError::NoRaidTarget { target: target.into(), resource: r });
        }
        if self.contract_for(kind, target, r).is_some() {
            return Err(EconError::ContractExists);
        }
        let (value, units) = match kind {
            OpKind::Raid => return Err(EconError::Unauthorized { caller: sponsor.into(), action: "post_contract (raids use post_bounty)".into() }),
            OpKind::Sabotage => {
                if t.production[r.idx()] <= 0 || self.disrupted(target, r) {
                    return Err(EconError::NoRaidTarget { target: target.into(), resource: r });
                }
                // What the sabotage costs the faction: a day of output plus the stock it burns.
                let stock = self.balance(&t.account, Asset::Res(r));
                ((t.production[r.idx()] + stock * SABOTAGE_SHARE_BP / pricing::BP) * pricing::production_cost(r), 0)
            }
            OpKind::Recovery => {
                let c = convoy.and_then(|id| self.convoys.get(&id)).ok_or_else(|| unknown("convoy", &format!("{convoy:?}")))?;
                let sponsor_id = self.actor(sponsor)?.id.clone();
                if c.owner != sponsor_id || c.resource != r || c.status != (ConvoyStatus::Seized { by: target.into() }) {
                    return Err(unknown("seized convoy", &c.id.to_string()));
                }
                (c.units * pricing::production_cost(r), c.units)
            }
        };
        let (min, max) = (value * BOUNTY_MIN_BP / pricing::BP, value * BOUNTY_MAX_BP / pricing::BP);
        if amount < min.max(1) || amount > max {
            return Err(EconError::BountyOutOfRange { amount, min, max });
        }
        let id = self.peek_id();
        let b = Bounty { id, sponsor: sponsor.into(), target: target.into(), resource: r, amount, kind, convoy, units, posted_at: self.tick, expires_at: self.tick + 2 * BOUNTY_TICKS, status: BountyStatus::Open };
        let account = self.actor(sponsor)?.account.clone();
        let mut ev = self.apply(&[Transfer { from: account, to: b.escrow(), asset: Asset::Credits, qty: amount, reason: Reason::Escrow { bounty: id } }])?;
        self.commit_id(id);
        self.bounties.insert(id, b);
        ev.push(Event::ContractPosted { contract: id, kind, sponsor: sponsor.into(), target: target.into(), resource: r, amount });
        Ok(ev)
    }

    /// A faction takes a merchant caravan on the road; the cargo becomes its stock.
    fn seize_convoy(&mut self, faction: &str, convoy: u64) -> Result<Vec<Event>, EconError> {
        let c = self.convoys.get(&convoy).cloned().ok_or_else(|| unknown("convoy", &convoy.to_string()))?;
        let owner = self.actor(&c.owner)?.clone();
        if c.status != ConvoyStatus::InTransit || owner.kind != ActorKind::Merchant {
            return Err(unknown("caravan on the road", &convoy.to_string()));
        }
        let to = self.actor(faction)?.account.clone();
        let mut ev = self.apply(&[Transfer { from: c.account(), to, asset: Asset::Res(c.resource), qty: c.units, reason: Reason::Seized { convoy } }])?;
        self.convoys.get_mut(&convoy).unwrap().status = ConvoyStatus::Seized { by: faction.into() };
        ev.push(Event::ConvoySeized { convoy, by: faction.into(), resource: c.resource, units: c.units });
        Ok(ev)
    }

    /// Lock in a sabotage or recovery plan; it needs an open contract to exist.
    fn start_operation(&mut self, player: &str, kind: OpKind, target: &str, r: Resource) -> Result<Vec<Event>, EconError> {
        if self.active_raid_of(player).is_some() {
            return Err(EconError::RaidInProgress);
        }
        let plan = mission::operation_plan(self, kind, target, r).ok_or_else(|| EconError::NoRaidTarget { target: target.into(), resource: r })?;
        let id = self.peek_id();
        self.commit_id(id);
        let manifest = plan.manifest;
        self.raids.insert(id, Raid { id, player: player.into(), plan, started_at: self.tick, status: RaidStatus::Active });
        self.version += 1;
        Ok(vec![Event::RaidStarted { raid: id, player: player.into(), target: target.into(), resource: r, manifest }])
    }

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
    fn settle_raid(&mut self, id: u64, player: &str, secured: Option<i64>) -> Result<Vec<Event>, EconError> {
        let raid = self.raids.get(&id).ok_or_else(|| unknown("raid", &id.to_string()))?.clone();
        match &raid.status {
            RaidStatus::Extracted { .. } => return Err(EconError::AlreadySettled { raid: id }),
            RaidStatus::Failed => return Err(EconError::RaidNotActive { raid: id }),
            RaidStatus::Active if raid.player != player => return Err(EconError::RaidNotActive { raid: id }),
            RaidStatus::Active => {}
        }
        let target = self.actor(&raid.plan.target)?.account.clone();
        let asset = Asset::Res(raid.plan.resource);
        let cap = secured.map_or(raid.plan.manifest, |u| u.clamp(0, raid.plan.manifest));
        let units = cap.min(self.balance(&target, asset));
        let to = player_account(player);
        let mut batch = Vec::new();
        let kind = raid.plan.kind;
        let contract = raid.plan.contract.and_then(|c| self.bounties.get(&c)).filter(|b| b.status == BountyStatus::Open).cloned();
        if units > 0 {
            match kind {
                OpKind::Raid => batch.push(Transfer { from: target, to: to.clone(), asset, qty: units, reason: Reason::Raid { raid: id } }),
                OpKind::Sabotage => batch.push(Transfer { from: target, to: WORLD.into(), asset, qty: units, reason: Reason::Sabotage { raid: id } }),
                OpKind::Recovery => {
                    let owner = contract.as_ref().map(|b| self.actor(&b.sponsor).map(|a| a.account.clone())).transpose()?.unwrap_or_else(|| to.clone());
                    batch.push(Transfer { from: target, to: owner, asset, qty: units, reason: Reason::Recovered { raid: id } });
                }
            }
        }
        // A raid bounty pays for hitting the depot properly: half the manifest or more.
        let enough = secured.is_none_or(|u| 2 * u.max(0) >= raid.plan.manifest);
        let bounty = if kind == OpKind::Raid { self.bounty_for(&raid.plan.target, raid.plan.resource).filter(|_| enough).cloned() } else { contract };
        if let Some(b) = &bounty {
            batch.push(Transfer { from: b.escrow(), to, asset: Asset::Credits, qty: b.amount, reason: Reason::BountyPaid { bounty: b.id, raid: id } });
        }
        let mut ev = self.apply(&batch)?;
        let paid = bounty.as_ref().map_or(0, |b| b.amount);
        // The target remembers who did this, and which rival paid for it.
        {
            let tick = self.tick;
            let sponsor = bounty.as_ref().map(|b| b.sponsor.clone()).filter(|s| self.actors.get(s).is_some_and(|a| a.kind == ActorKind::Faction));
            let mem = self.memory.entry(raid.plan.target.clone()).or_default();
            let g = mem.players.entry(player.to_string()).or_default();
            match kind {
                OpKind::Raid => g.raids += 1,
                OpKind::Sabotage => g.sabotage += 1,
                OpKind::Recovery => g.recoveries += 1,
            }
            g.units_lost += units;
            g.last_tick = tick;
            if let Some(s) = sponsor {
                mem.sponsors.entry(s).or_default().push(tick);
            }
        }
        if let Some(b) = bounty {
            self.bounties.get_mut(&b.id).unwrap().status = BountyStatus::Paid { raid: id, player: player.into() };
        }
        self.raids.get_mut(&id).unwrap().status = RaidStatus::Extracted { units, bounty: paid };
        if kind == OpKind::Sabotage {
            let until = self.tick + SABOTAGE_TICKS;
            let r = raid.plan.resource;
            self.actors.get_mut(&raid.plan.target).unwrap().disrupted_until[r.idx()] = until;
            ev.push(Event::ProductionDisrupted { actor: raid.plan.target.clone(), resource: r, until });
        }
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
                let p = if a.disrupted_until[r.idx()] > t { 0 } else { spread(a.production[r.idx()], t) };
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
            // Garrison upkeep: what the faction pays to keep its posture, every day; and
            // once a day, treasury beyond the war chest goes back to command.
            if self.market.living && a.kind == ActorKind::Faction {
                let pay = spread(UPKEEP_PER_DAY[a.defense.min(DEFENSE_MAX) as usize], t).min(self.balance(&a.account, Asset::Credits));
                if pay > 0 {
                    ev.extend(self.apply(&[Transfer { from: a.account.clone(), to: WORLD.into(), asset: Asset::Credits, qty: pay, reason: Reason::Upkeep }]).expect("checked"));
                }
                let excess = self.balance(&a.account, Asset::Credits) - a.credit_reserve - WAR_CHEST_DAYS * a.income_per_day;
                if t % TICKS_PER_DAY == TICKS_PER_DAY - 1 && excess > 0 {
                    ev.extend(self.apply(&[Transfer { from: a.account.clone(), to: WORLD.into(), asset: Asset::Credits, qty: excess, reason: Reason::Remittance }]).expect("checked"));
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

        if self.market.living && t % MERCHANT_RESTOCK_TICKS == 3 {
            for m in self.merchant_ids() {
                ev.extend(self.merchant_logistics(&m));
            }
            ev.extend(self.armory_restock());
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
        // Orders and proposals lapse at their deadline: from this tick on they can't be
        // accepted, so their escrow goes back now.
        ev.extend(self.expire_orders());
        ev
    }

    /// Send a supply shipment. A faction's shipment burns `LOGISTICS_FUEL` (no fuel, no
    /// shipment) and pays escort wages at the best defense level it can afford. A
    /// merchant caravan pays import cost, shrinking to what it can afford above its
    /// reserve; an insolvent merchant does not restock.
    /// Units of `r` in transit to `owner`.
    pub fn inbound(&self, owner: &str, r: Resource) -> i64 {
        self.convoys.values().filter(|c| c.owner == owner && c.resource == r && c.status == ConvoyStatus::InTransit).map(|c| c.units).sum()
    }

    /// The merchant's shelf review (live world): a caravan for each shelf below target
    /// (counting what is already inbound), paid at import cost and sized to what it can
    /// afford above its reserve; surplus beyond twice target is exported at half cost.
    fn merchant_logistics(&mut self, merchant: &str) -> Vec<Event> {
        let m = self.actors[merchant].clone();
        let Some(prof) = self.profile(merchant) else { return vec![] };
        if self.balance(&m.account, Asset::Credits) < m.credit_reserve {
            return vec![Event::MerchantSuspended { reason: format!("{}: insolvent, restocking paused", m.name) }];
        }
        let mut ev = Vec::new();
        for r in Resource::ALL {
            let stock = self.balance(&m.account, Asset::Res(r));
            let target = prof.target[r.idx()];
            let inbound = self.inbound(&m.id, r);
            if stock + inbound < target {
                let unit = pricing::production_cost(r) * MERCHANT_IMPORT_BP / pricing::BP;
                let afford = (self.balance(&m.account, Asset::Credits) - m.credit_reserve).max(0) / unit.max(1);
                let units = (target - stock - inbound).min(afford);
                if units <= 0 {
                    continue;
                }
                let id = self.peek_id();
                let convoy = Convoy { id, owner: m.id.clone(), resource: r, units, defense: 1, dispatched_at: self.tick, arrives_at: self.tick + MERCHANT_TRANSIT_TICKS, status: ConvoyStatus::InTransit };
                let mut out = self
                    .apply(&[
                        Transfer { from: WORLD.into(), to: convoy.account(), asset: Asset::Res(r), qty: units, reason: Reason::Shipment { convoy: id } },
                        Transfer { from: m.account.clone(), to: WORLD.into(), asset: Asset::Credits, qty: units * unit, reason: Reason::ImportCost { convoy: id } },
                    ])
                    .expect("sized to what the merchant can afford");
                self.commit_id(id);
                out.push(Event::ShipmentDispatched { convoy: id, owner: m.id.clone(), resource: r, units, defense: 1 });
                self.convoys.insert(id, convoy);
                ev.extend(out);
            } else if stock > 2 * target {
                let units = stock - target * 3 / 2;
                let revenue = units * pricing::production_cost(r) * EXPORT_PRICE_BP / pricing::BP;
                ev.extend(
                    self.apply(&[
                        Transfer { from: m.account.clone(), to: WORLD.into(), asset: Asset::Res(r), qty: units, reason: Reason::Export },
                        Transfer { from: WORLD.into(), to: m.account.clone(), asset: Asset::Credits, qty: revenue.max(1), reason: Reason::ExportRevenue },
                    ])
                    .expect("the merchant holds the surplus"),
                );
                ev.push(Event::MerchantExported { resource: r, units, revenue });
            }
        }
        let excess = self.balance(&m.account, Asset::Credits) - prof.capital;
        if excess > 0 {
            ev.extend(self.apply(&[Transfer { from: m.account.clone(), to: WORLD.into(), asset: Asset::Credits, qty: excess, reason: Reason::Dividend }]).expect("checked"));
        }
        ev
    }

    fn dispatch(&mut self, actor_id: &str, plan: &ShipmentPlan) -> Vec<Event> {
        let a = self.actors[actor_id].clone();
        let is_faction = a.kind == ActorKind::Faction;
        // Live world: a faction ships only what it needs (stock plus inbound under
        // twice its requirement), so supply follows consumption instead of piling up.
        if self.market.living && is_faction {
            let need = 2 * a.requirement(plan.resource);
            if need > 0 && self.balance(&a.account, Asset::Res(plan.resource)) + self.inbound(actor_id, plan.resource) >= need {
                return vec![];
            }
        }
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

    // ── player quotes ────────────────────────────────────────────────────────

    pub fn open_quote_of(&self, player: &str) -> Option<&PlayerQuote> {
        self.quotes.values().find(|q| q.player == player && q.status == QuoteStatus::Open)
    }

    /// What the merchant has held for open quotes, per asset (still its own on chain).
    pub fn held_for_quotes(&self, asset: Asset) -> i64 {
        self.quotes.values().filter(|q| q.status == QuoteStatus::Open).map(|q| self.balance(&q.escrow(), asset)).sum()
    }

    /// The merchant takes one of each gun it is short of from its supplier, on
    /// consignment (paid for when it sells; see `settle_quote`).
    fn armory_restock(&mut self) -> Vec<Event> {
        let m = self.merchant().clone();
        let mut ev = Vec::new();
        for g in Gear::ALL {
            let have = self.balance(&m.account, Asset::Gear(g)) + self.held_for_quotes(Asset::Gear(g));
            if have >= ARMORY_STOCK {
                continue;
            }
            let r = self.apply(&[Transfer { from: WORLD.into(), to: m.account.clone(), asset: Asset::Gear(g), qty: 1, reason: Reason::Armory }]);
            if let Ok(e) = r {
                ev.extend(e);
                ev.push(Event::ArmoryRestocked { gear: g });
            }
        }
        ev
    }

    /// The merchant's armory price for `player`, after their standing discount.
    pub fn gear_price(&self, player: &str, g: Gear) -> i64 {
        g.list_price() * (10_000 - self.standing(player).vex_discount_bp) / 10_000
    }

    /// A firm price for one gun from the armory, held for `player` like any quote.
    pub fn reserve_gear_quote(&mut self, player: &str, g: Gear, limit_total: i64) -> Result<PlayerQuote, EconError> {
        if self.open_quote_of(player).is_some() {
            return Err(EconError::QuoteOpen);
        }
        let merchant = self.merchant().account.clone();
        let stock = self.balance(&merchant, Asset::Gear(g));
        if stock < 1 {
            return Err(EconError::MerchantShort { qty: 1, stock });
        }
        let total = self.gear_price(player, g);
        if total > limit_total {
            return Err(EconError::PriceMoved { total, limit: limit_total });
        }
        let account = player_account(player);
        let have = self.balance(&account, Asset::Credits);
        if have < total {
            return Err(EconError::Insufficient { account, asset: Asset::Credits, have, need: total });
        }
        let id = self.peek_id();
        let pq = PlayerQuote { id, player: player.into(), resource: Resource::Ammo, side: Side::Buy, qty: 1, total, posted_at: self.tick, status: QuoteStatus::Open, gear: Some(g) };
        self.apply(&[Transfer { from: merchant, to: pq.escrow(), asset: Asset::Gear(g), qty: 1, reason: Reason::QuoteHold { quote: id } }])?;
        self.commit_id(id);
        self.quotes.insert(id, pq.clone());
        Ok(pq)
    }

    /// Does `player` own at least one of `g`?
    pub fn owns(&self, player: &str, g: Gear) -> bool {
        self.balance(&player_account(player), Asset::Gear(g)) > 0
    }

    /// How the world regards `player`, computed from what actually happened: the
    /// merchant from the credits traded with it and the cargo returned to it; each
    /// faction from the contracts it paid this player for, against the operations
    /// this player ran on it.
    pub fn standing(&self, player: &str) -> Standing {
        let account = player_account(player);
        let traded: i64 = self.trades.iter().filter(|t| t.party == account).map(|t| t.total).sum();
        let mut paid_by: BTreeMap<&str, (u32, i64)> = BTreeMap::new();
        for b in self.bounties.values() {
            if let BountyStatus::Paid { raid, .. } = &b.status {
                if self.raids.get(raid).is_some_and(|r| r.player == player) {
                    let e = paid_by.entry(b.sponsor.as_str()).or_default();
                    e.0 += 1;
                    e.1 += b.amount;
                }
            }
        }
        let jobs_for_vex = paid_by.get(self.market.merchant.as_str()).map(|x| x.0).unwrap_or(0);
        let score = traded / 100 + jobs_for_vex as i64 * 10;
        let (tier, bp) = VEX_TIERS.iter().rev().find(|(min, _, _)| score >= *min).map(|(_, t, bp)| (*t, *bp)).unwrap_or(("Unknown", 0));
        let factions = self.actors.values().filter(|a| a.kind == ActorKind::Faction).map(|a| {
            let (jobs, earned) = paid_by.get(a.id.as_str()).copied().unwrap_or((0, 0));
            let g = self.memory.get(&a.id).and_then(|m| m.players.get(player)).cloned().unwrap_or_default();
            let against = g.raids + g.sabotage + g.recoveries;
            let score = jobs as i64 * 10 - against as i64 * 10;
            let tier = match score { s if s >= 20 => "Trusted", s if s > 0 => "Favoured", 0 => "Neutral", s if s > -30 => "Wary", _ => "Hostile" };
            FactionStanding { actor: a.id.clone(), name: a.name.clone(), jobs_for: jobs, earned_from: earned, operations_against: against, units_taken: g.units_lost, score, tier: tier.into() }
        }).collect();
        Standing { vex_score: score, vex_tier: tier.into(), vex_discount_bp: bp, vex_traded: traded, factions }
    }

    /// Give `player` a firm merchant price for `qty` of `r`, within the player's limit.
    /// The player must be able to pay (credits to buy, goods to sell) and may hold one
    /// open quote at a time. The merchant's side moves into escrow.
    pub fn reserve_quote(&mut self, player: &str, r: Resource, side: Side, qty: i64, limit_total: i64) -> Result<PlayerQuote, EconError> {
        if self.open_quote_of(player).is_some() {
            return Err(EconError::QuoteOpen);
        }
        // The player's side is the merchant's opposite: a player purchase is a merchant sale.
        if side == Side::Sell && self.merchant_insolvent() {
            return Err(EconError::MerchantInsolvent);
        }
        let mut q = self.quote(r, side, qty)?;
        // A regular trading partner gets a better price, in either direction.
        let bp = self.standing(player).vex_discount_bp;
        q.total = match side { Side::Buy => q.total * (10_000 - bp) / 10_000, Side::Sell => q.total * (10_000 + bp) / 10_000 };
        let ok = match side { Side::Buy => q.total <= limit_total, Side::Sell => q.total >= limit_total };
        if !ok {
            return Err(EconError::PriceMoved { total: q.total, limit: limit_total });
        }
        let account = player_account(player);
        let (need_asset, need) = match side { Side::Buy => (Asset::Credits, q.total), Side::Sell => (Asset::Res(r), qty) };
        let have = self.balance(&account, need_asset);
        if have < need {
            return Err(EconError::Insufficient { account, asset: need_asset, have, need });
        }
        let id = self.peek_id();
        let pq = PlayerQuote { id, player: player.into(), resource: r, side, qty, total: q.total, posted_at: self.tick, status: QuoteStatus::Open, gear: None };
        let (asset, held) = pq.held();
        let merchant = self.merchant().account.clone();
        self.apply(&[Transfer { from: merchant, to: pq.escrow(), asset, qty: held, reason: Reason::QuoteHold { quote: id } }])?;
        self.commit_id(id);
        self.quotes.insert(id, pq.clone());
        Ok(pq)
    }

    /// The player accepted: the held side goes to the player and the player's side to
    /// the merchant, in one batch, recorded as a trade.
    pub fn settle_quote(&mut self, id: u64) -> Result<Vec<Event>, EconError> {
        let q = self.quotes.get(&id).cloned().ok_or_else(|| unknown("quote", &id.to_string()))?;
        if q.status != QuoteStatus::Open {
            return Err(EconError::QuoteNotOpen { quote: id });
        }
        let merchant = self.merchant().account.clone();
        let player = player_account(&q.player);
        let (held_asset, held) = q.held();
        let (pay_asset, pay) = match q.side { Side::Buy => (Asset::Credits, q.total), Side::Sell => (q.goods(), q.qty) };
        let trade = self.peek_id();
        let mut legs = vec![
            Transfer { from: q.escrow(), to: player.clone(), asset: held_asset, qty: held, reason: Reason::Trade { trade } },
            Transfer { from: player.clone(), to: merchant.clone(), asset: pay_asset, qty: pay, reason: Reason::Trade { trade } },
        ];
        // A consigned gun: the merchant settles with its supplier out of the sale.
        if let Some(g) = q.gear {
            legs.push(Transfer { from: merchant, to: WORLD.into(), asset: Asset::Credits, qty: g.list_price() * ARMORY_COST_BP / 10_000, reason: Reason::ArmoryCost });
        }
        let mut ev = self.apply(&legs)?;
        self.commit_id(trade);
        let rec = TradeRecord { id: trade, tick: self.tick, party: player, resource: q.resource, side: q.side, qty: q.qty, total: q.total, gear: q.gear, merchant: None, order: None };
        self.trades.push(rec.clone());
        self.quotes.get_mut(&id).unwrap().status = QuoteStatus::Settled { trade };
        ev.push(Event::Traded(rec));
        ev.push(Event::QuoteSettled { quote: id, trade });
        Ok(ev)
    }

    /// The quote lapsed: the hold returns to the merchant.
    pub fn release_quote(&mut self, id: u64) -> Result<Vec<Event>, EconError> {
        let q = self.quotes.get(&id).cloned().ok_or_else(|| unknown("quote", &id.to_string()))?;
        if q.status != QuoteStatus::Open {
            return Err(EconError::QuoteNotOpen { quote: id });
        }
        let (asset, held) = q.held();
        let merchant = self.merchant().account.clone();
        let mut ev = self.apply(&[Transfer { from: q.escrow(), to: merchant, asset, qty: held, reason: Reason::QuoteRelease { quote: id } }])?;
        self.quotes.get_mut(&id).unwrap().status = QuoteStatus::Released;
        ev.push(Event::QuoteReleased { quote: id });
        Ok(ev)
    }

    /// Set a player's holding of `asset` to what the chain says it is, moving the
    /// difference across the `OUTSIDE` boundary. Only player accounts: actors are
    /// mirrored the other way (engine → chain). Never reachable from `execute`.
    pub fn sync_holding(&mut self, player: &str, asset: Asset, chain: i64) -> Result<Vec<Event>, EconError> {
        let account = player_account(player);
        let have = self.balance(&account, asset);
        if chain < 0 || chain == have {
            return Ok(vec![]);
        }
        let (from, to, qty) = if chain > have { (OUTSIDE.to_string(), account.clone(), chain - have) } else { (account.clone(), OUTSIDE.to_string(), have - chain) };
        let mut ev = self.apply(&[Transfer { from, to, asset, qty, reason: Reason::External }])?;
        ev.push(Event::HoldingSynced { account, asset, from: have, to: chain });
        Ok(ev)
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

/// Who an order belongs to: the actor id for an agent, the account for a player.
fn requester_id(c: &Caller) -> String {
    match c {
        Caller::Agent(id) => id.clone(),
        Caller::Player(p) => player_account(p),
        Caller::System => WORLD.into(),
    }
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

pub use scenario::{acceptance, add_halcyon, add_rival, genesis, ASHEN, HALCYON, MERCHANT, VANGUARD};
