//! Seeded starting worlds.
//!
//! - [`genesis`]: the live game world: Vanguard (faction) and Vex (merchant), with
//!   production, consumption and recurring supply shipments.
//! - [`acceptance`]: the fixed state of the end-to-end acceptance scenario (Vanguard
//!   holds 100 ammunition and 1,000 credits; the merchant 100 ammunition and 500
//!   credits), with shipments off so nothing changes unless a test acts.

use crate::pricing::Strategy;
use crate::{Actor, ActorKind, Asset, Market, Resource, ShipmentPlan, World};

pub const VANGUARD: &str = "vanguard";
pub const MERCHANT: &str = "vex";

fn vanguard(credit_reserve: i64, shipment: Option<ShipmentPlan>) -> Actor {
    Actor {
        id: VANGUARD.into(),
        name: "Vanguard".into(),
        kind: ActorKind::Faction,
        account: "faction:vanguard".into(),
        income_per_day: 960,
        production: [48, 0, 0],
        consumption: [24, 12, 48],
        reserve_days: 2,
        credit_reserve,
        defense: 2,
        shipment,
    }
}

fn vex(credit_reserve: i64, shipment: Option<ShipmentPlan>) -> Actor {
    Actor {
        id: MERCHANT.into(),
        name: "Vex Exchange".into(),
        kind: ActorKind::Merchant,
        account: "merchant:vex".into(),
        income_per_day: 0,
        production: [0, 0, 0],
        consumption: [0, 0, 0],
        reserve_days: 0,
        credit_reserve,
        defense: 1,
        shipment,
    }
}

fn market() -> Market {
    Market { merchant: MERCHANT.into(), target: [120, 60, 120], strategy: Strategy { margin_bp: 2_000, spread_bp: 1_000 }, living: false }
}

fn build(seed: u64, actors: [Actor; 2], balances: &[(&str, Asset, i64)]) -> World {
    let mut w = World::empty(seed, market());
    for a in actors {
        w.actors.insert(a.id.clone(), a);
    }
    for &(acct, asset, qty) in balances {
        w.grant(acct, asset, qty);
    }
    w
}

pub fn genesis(seed: u64) -> World {
    let mut w = build(
        seed,
        [
            Actor { income_per_day: 1_200, ..vanguard(600, Some(ShipmentPlan { resource: Resource::Fuel, units: 60, every_ticks: 12, transit_ticks: 6, next_dispatch: 0 })) },
            // Vex restocks every shelf through merchant logistics (Market::living).
            vex(300, None),
        ],
        &[
            ("faction:vanguard", Asset::Credits, 4_000),
            ("faction:vanguard", Asset::Res(Resource::Ammo), 100),
            ("faction:vanguard", Asset::Res(Resource::Med), 30),
            ("faction:vanguard", Asset::Res(Resource::Fuel), 120),
            ("merchant:vex", Asset::Credits, 3_000),
            ("merchant:vex", Asset::Res(Resource::Ammo), 100),
            ("merchant:vex", Asset::Res(Resource::Med), 50),
            ("merchant:vex", Asset::Res(Resource::Fuel), 60),
        ],
    );
    w.market.living = true;
    w
}

/// The acceptance scenario's exact starting state.
pub fn acceptance() -> World {
    build(
        7,
        [vanguard(300, None), vex(200, None)],
        &[
            ("faction:vanguard", Asset::Credits, 1_000),
            ("faction:vanguard", Asset::Res(Resource::Ammo), 100),
            ("faction:vanguard", Asset::Res(Resource::Med), 30),
            ("faction:vanguard", Asset::Res(Resource::Fuel), 100),
            ("merchant:vex", Asset::Credits, 500),
            ("merchant:vex", Asset::Res(Resource::Ammo), 100),
            ("merchant:vex", Asset::Res(Resource::Med), 50),
            ("merchant:vex", Asset::Res(Resource::Fuel), 60),
        ],
    )
}
