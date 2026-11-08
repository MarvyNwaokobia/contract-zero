//! Sabotage and recovery: contracts the merchant funds for its own reasons, operations
//! that change the world differently from a raid, and the agent decisions that cause
//! them (a broke faction seizing a caravan; a merchant with a glut paying to knock out
//! a rival's production line).

use cz_economy::mission::operation_plan;
use cz_economy::policy::{commander, merchant};
use cz_economy::*;

const P: &str = "saboteur.testnet";
const VG: &str = "faction:vanguard";
const VEX: &str = "merchant:vex";
const AMMO: Asset = Asset::Res(Resource::Ammo);
const FUEL: Asset = Asset::Res(Resource::Fuel);

fn conserved(w: &World) {
    for a in [Asset::Credits, AMMO, Asset::Res(Resource::Med), FUEL] {
        assert_eq!(w.total(a), 0, "{a:?}");
        assert_eq!(w.balance(WORLD, a), w.destroyed(a) - w.issued(a), "{a:?}");
    }
}

fn vex() -> Caller {
    Caller::Agent(MERCHANT.into())
}

/// A sabotage fee that sits inside the allowed band for the current state.
fn sabotage_fee(w: &World) -> i64 {
    let a = &w.actors[VANGUARD];
    let value = (a.production[0] + w.balance(VG, AMMO) * SABOTAGE_SHARE_BP / 10_000) * pricing::production_cost(Resource::Ammo);
    value * 3_000 / 10_000
}

/// Run ticks until the merchant has a caravan of `r` on the road.
fn caravan_on_road(w: &mut World, r: Resource) -> u64 {
    let stock = w.balance(VEX, Asset::Res(r));
    w.apply(&[Transfer { from: VEX.into(), to: WORLD.into(), asset: Asset::Res(r), qty: stock, reason: Reason::Consumption }]).unwrap();
    for _ in 0..2 * TICKS_PER_DAY {
        w.tick();
        if let Some(c) = w.convoys.values().find(|c| c.owner == MERCHANT && c.resource == r && c.status == ConvoyStatus::InTransit) {
            return c.id;
        }
    }
    panic!("no caravan dispatched");
}

#[test]
fn sabotage_destroys_stock_halts_production_and_pays_the_saboteur() {
    let mut w = genesis(5);
    let fee = sabotage_fee(&w);
    w.execute(&vex(), &Action::PostContract { kind: OpKind::Sabotage, target: VANGUARD.into(), resource: Resource::Ammo, amount: fee, convoy: None }).unwrap();
    let ammo_before = w.balance(VG, AMMO);
    let destroyed_before = w.destroyed(AMMO);
    w.execute(&Caller::Player(P.into()), &Action::StartOperation { kind: OpKind::Sabotage, target: VANGUARD.into(), resource: Resource::Ammo }).unwrap();
    let id = *w.raids.keys().last().unwrap();
    let manifest = w.raids[&id].plan.manifest;
    assert!(manifest > 0);
    w.execute(&Caller::System, &Action::SettleRaid { raid: id, player: P.into() }).unwrap();

    assert_eq!(w.balance(VG, AMMO), ammo_before - manifest, "the stock is destroyed");
    assert_eq!(w.balance(&player_account(P), AMMO), 0, "the saboteur takes nothing");
    assert_eq!(w.balance(&player_account(P), Asset::Credits), fee, "the fee is paid");
    assert_eq!(w.destroyed(AMMO), destroyed_before + manifest, "classified as destruction");
    assert!(w.disrupted(VANGUARD, Resource::Ammo));

    // No ammunition is produced while the line is down, then it comes back.
    let mut produced_during = 0;
    for _ in 0..SABOTAGE_TICKS {
        let n = w.ledger.len();
        w.tick();
        produced_during += w.ledger[n..].iter().filter(|e| e.transfer.reason == Reason::Production && e.transfer.asset == AMMO).map(|e| e.transfer.qty).sum::<i64>();
    }
    assert_eq!(produced_during, 0);
    assert!(!w.disrupted(VANGUARD, Resource::Ammo));
    let n = w.ledger.len();
    for _ in 0..TICKS_PER_DAY {
        w.tick();
    }
    assert!(w.ledger[n..].iter().any(|e| e.transfer.reason == Reason::Production && e.transfer.asset == AMMO), "the line comes back");
    conserved(&w);
}

#[test]
fn a_seized_caravan_can_be_recovered_for_its_owner() {
    let mut w = genesis(5);
    let convoy = caravan_on_road(&mut w, Resource::Fuel);
    let units = w.convoys[&convoy].units;
    let vg_fuel = w.balance(VG, FUEL);
    w.execute(&Caller::Agent(VANGUARD.into()), &Action::SeizeConvoy { convoy }).unwrap();
    assert_eq!(w.balance(VG, FUEL), vg_fuel + units, "the cargo becomes Vanguard stock");
    assert_eq!(w.convoys[&convoy].status, ConvoyStatus::Seized { by: VANGUARD.into() });

    w.grant(VEX, Asset::Credits, 2_000); // the import just spent most of Vex's float
    let fee = units * pricing::production_cost(Resource::Fuel) * 3_000 / 10_000;
    w.execute(&vex(), &Action::PostContract { kind: OpKind::Recovery, target: VANGUARD.into(), resource: Resource::Fuel, amount: fee, convoy: Some(convoy) }).unwrap();
    let plan = operation_plan(&w, OpKind::Recovery, VANGUARD, Resource::Fuel).unwrap();
    assert_eq!(plan.manifest, units.min(w.balance(VG, FUEL)));

    let vex_fuel = w.balance(VEX, FUEL);
    w.execute(&Caller::Player(P.into()), &Action::StartOperation { kind: OpKind::Recovery, target: VANGUARD.into(), resource: Resource::Fuel }).unwrap();
    let id = *w.raids.keys().last().unwrap();
    w.execute(&Caller::System, &Action::SettleRaid { raid: id, player: P.into() }).unwrap();
    assert_eq!(w.balance(VEX, FUEL), vex_fuel + plan.manifest, "the cargo goes home to Vex");
    assert_eq!(w.balance(&player_account(P), FUEL), 0, "not to the player");
    assert_eq!(w.balance(&player_account(P), Asset::Credits), fee);
    conserved(&w);
}

#[test]
fn contracts_are_validated() {
    let mut w = genesis(5);
    // A recovery needs a caravan this faction actually seized from this merchant.
    let r = w.execute(&vex(), &Action::PostContract { kind: OpKind::Recovery, target: VANGUARD.into(), resource: Resource::Fuel, amount: 100, convoy: Some(999) });
    assert!(matches!(r, Err(EconError::Unknown { .. })));
    // Raids go through post_bounty.
    assert!(matches!(w.execute(&vex(), &Action::PostContract { kind: OpKind::Raid, target: VANGUARD.into(), resource: Resource::Ammo, amount: 100, convoy: None }), Err(EconError::Unauthorized { .. })));
    // Sabotage only of something the faction produces (Vanguard makes no medicine).
    assert!(matches!(w.execute(&vex(), &Action::PostContract { kind: OpKind::Sabotage, target: VANGUARD.into(), resource: Resource::Med, amount: 100, convoy: None }), Err(EconError::NoRaidTarget { .. })));
    // One open contract per (kind, target, resource), and the fee must be in band.
    let fee = sabotage_fee(&w);
    assert!(matches!(w.execute(&vex(), &Action::PostContract { kind: OpKind::Sabotage, target: VANGUARD.into(), resource: Resource::Ammo, amount: 1, convoy: None }), Err(EconError::BountyOutOfRange { .. })));
    w.execute(&vex(), &Action::PostContract { kind: OpKind::Sabotage, target: VANGUARD.into(), resource: Resource::Ammo, amount: fee, convoy: None }).unwrap();
    assert_eq!(w.execute(&vex(), &Action::PostContract { kind: OpKind::Sabotage, target: VANGUARD.into(), resource: Resource::Ammo, amount: fee, convoy: None }), Err(EconError::ContractExists));
    // No contract, no operation; and only a faction agent may seize.
    assert!(matches!(w.execute(&Caller::Player(P.into()), &Action::StartOperation { kind: OpKind::Recovery, target: VANGUARD.into(), resource: Resource::Fuel }), Err(EconError::NoRaidTarget { .. })));
    assert!(matches!(w.execute(&vex(), &Action::SeizeConvoy { convoy: 1 }), Err(EconError::Unauthorized { .. })));
    assert!(matches!(w.execute(&Caller::Player(P.into()), &Action::SeizeConvoy { convoy: 1 }), Err(EconError::Unauthorized { .. })));
    conserved(&w);
}

#[test]
fn a_broke_starving_commander_seizes_a_caravan_and_the_merchant_wants_it_back() {
    let mut w = genesis(5);
    let convoy = caravan_on_road(&mut w, Resource::Fuel);
    // Vanguard: almost out of fuel and out of money.
    let fuel = w.balance(VG, FUEL);
    w.apply(&[Transfer { from: VG.into(), to: WORLD.into(), asset: FUEL, qty: fuel - 5, reason: Reason::Consumption }]).unwrap();
    let cr = w.balance(VG, Asset::Credits);
    w.apply(&[Transfer { from: VG.into(), to: WORLD.into(), asset: Asset::Credits, qty: cr - w.actors[VANGUARD].credit_reserve, reason: Reason::Upkeep }]).unwrap();
    let d = commander(&w, VANGUARD);
    let seize = d.iter().find(|d| matches!(d.action, Some(Action::SeizeConvoy { .. }))).expect("the commander seizes");
    assert_eq!(seize.action, Some(Action::SeizeConvoy { convoy }));
    w.execute(&Caller::Agent(VANGUARD.into()), seize.action.as_ref().unwrap()).unwrap();
    w.grant(VEX, Asset::Credits, 2_000); // the import just spent most of Vex's float
    let m = merchant(&w);
    assert!(m.iter().any(|d| matches!(d.action, Some(Action::PostContract { kind: OpKind::Recovery, convoy: Some(c), .. }) if c == convoy)), "Vex posts a recovery");
}

#[test]
fn a_merchant_with_a_glut_pays_to_knock_out_the_rival_line() {
    let mut w = genesis(5);
    w.grant(VEX, AMMO, 200); // way over target
    let m = merchant(&w);
    assert!(m.iter().any(|d| matches!(d.action, Some(Action::PostContract { kind: OpKind::Sabotage, resource: Resource::Ammo, .. }))), "{m:#?}");
}
