//! Seeded starting worlds.
//!
//! - [`genesis`]: the live game world: Vanguard (faction) and Vex (merchant), with
//!   production, consumption and recurring supply shipments.
//! - [`acceptance`]: the fixed state of the end-to-end acceptance scenario (Vanguard
//!   holds 100 ammunition and 1,000 credits; the merchant 100 ammunition and 500
//!   credits), with shipments off so nothing changes unless a test acts.

use crate::pricing::Strategy;
use crate::{Actor, ActorKind, Asset, Doctrine, Market, Resource, ShipmentPlan, World};

pub const VANGUARD: &str = "vanguard";
pub const ASHEN: &str = "ashen";
pub const MERCHANT: &str = "vex";
pub const HALCYON: &str = "halcyon";

/// Halcyon Logistics: the second merchant, competing with Vex for every supply order.
fn halcyon() -> Actor {
    Actor {
        id: HALCYON.into(),
        name: "Halcyon Logistics".into(),
        kind: ActorKind::Merchant,
        account: "merchant:halcyon".into(),
        income_per_day: 0,
        production: [0, 0, 0],
        consumption: [0, 0, 0],
        reserve_days: 0,
        credit_reserve: 400,
        defense: 1,
        shipment: None,
        disrupted_until: [0; 3],
        doctrine: Doctrine::default(),
    }
}

/// Bring Halcyon into a world that predates it (genesis grants, mirrored on chain by the
/// next flow sync). No-op if it's already there.
pub fn add_halcyon(w: &mut World) -> bool {
    if w.actors.contains_key(HALCYON) {
        return false;
    }
    let a = halcyon();
    let acct = a.account.clone();
    w.actors.insert(HALCYON.into(), a);
    w.merchants.insert(HALCYON.into(), crate::orders::halcyon_profile());
    for (asset, qty) in [(Asset::Credits, 2_500), (Asset::Res(Resource::Ammo), 80), (Asset::Res(Resource::Med), 30), (Asset::Res(Resource::Fuel), 50)] {
        w.grant(&acct, asset, qty);
    }
    true
}

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
        disrupted_until: [0; 3],
        doctrine: Doctrine::default(),
    }
}

/// The Ashen Compact: a fuel-refining militia. It needs ammunition it doesn't make,
/// sells the fuel it doesn't need, keeps a light garrison, and pays to have its rival
/// raided before it gets the chance to be raided itself.
fn ashen() -> Actor {
    Actor {
        id: ASHEN.into(),
        name: "Ashen Compact".into(),
        kind: ActorKind::Faction,
        account: "faction:ashen".into(),
        income_per_day: 900,
        production: [0, 0, 72],
        consumption: [30, 8, 24],
        reserve_days: 2,
        credit_reserve: 500,
        defense: 1,
        shipment: None,
        disrupted_until: [0; 3],
        doctrine: Doctrine { base_defense: 1, max_price_mult: 3, aggression: 70 },
    }
}

/// Bring the Ashen Compact into a live world that predates it (genesis grants, like a
/// new region coming online). No-op if it's already there.
pub fn add_rival(w: &mut World) -> bool {
    if w.actors.contains_key(ASHEN) {
        return false;
    }
    let a = ashen();
    let acct = a.account.clone();
    w.actors.insert(ASHEN.into(), a);
    for (asset, qty) in [(Asset::Credits, 3_500), (Asset::Res(Resource::Ammo), 70), (Asset::Res(Resource::Med), 20), (Asset::Res(Resource::Fuel), 160)] {
        w.grant(&acct, asset, qty);
    }
    true
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
        disrupted_until: [0; 3],
        doctrine: Doctrine::default(),
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
    add_rival(&mut w);
    add_halcyon(&mut w);
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
