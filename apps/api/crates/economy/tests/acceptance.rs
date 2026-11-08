//! The end-to-end acceptance scenario (economy half; NEAR settlement and the War Room
//! are covered by the API's tests).
//!
//! Vanguard holds 100 ammunition and 1,000 credits; the merchant 100 ammunition and
//! 500 credits. The player raids Vanguard's ammunition depot and extracts 60.

use cz_economy::mission::raid_plan;
use cz_economy::policy::{self, ammo_target};
use cz_economy::*;

const PLAYER: &str = "raider.testnet";
const VG: &str = "faction:vanguard";
const VEX_ACC: &str = "merchant:vex";

fn ammo(w: &World, acct: &str) -> i64 {
    w.balance(acct, Asset::Res(Resource::Ammo))
}

/// Steps 1–2: the raid and its settlement.
fn after_raid() -> World {
    let mut w = acceptance();
    assert_eq!((ammo(&w, VG), w.balance(VG, Asset::Credits)), (100, 1_000));
    assert_eq!((ammo(&w, VEX_ACC), w.balance(VEX_ACC, Asset::Credits)), (100, 500));
    w.execute(&Caller::Player(PLAYER.into()), &Action::StartRaid { target: VANGUARD.into(), resource: Resource::Ammo }).unwrap();
    let raid = *w.raids.keys().last().unwrap();
    assert_eq!(w.raids[&raid].plan.manifest, 60);
    w.execute(&Caller::System, &Action::SettleRaid { raid, player: PLAYER.into() }).unwrap();
    w
}

#[test]
fn the_full_raid_to_replan_loop() {
    let before = raid_plan(&acceptance(), VANGUARD, Resource::Fuel).unwrap().guards;
    let mut w = after_raid();

    // 1. Vanguard's ammunition decreases to 40.
    assert_eq!(ammo(&w, VG), 40);
    // 2. The player receives the extracted inventory.
    assert_eq!(ammo(&w, &player_account(PLAYER)), 60);

    // 3–6. The commander sees the shortage, quotes the merchant, and buys within policy.
    let decisions = policy::commander(&w, VANGUARD);
    let buy = decisions.iter().find(|d| d.trigger == "ammo below target").expect("commander notices the shortage");
    let Some(Action::Trade { resource: Resource::Ammo, side: Side::Buy, qty, limit_total }) = buy.action.clone() else {
        panic!("commander should buy ammo: {buy:?}")
    };
    let quote = w.quote(Resource::Ammo, Side::Buy, qty).unwrap();
    assert_eq!(quote.total, limit_total, "the price it acted on is the merchant's valid quote");
    let vg_reserve = w.actor(VANGUARD).unwrap().credit_reserve;
    assert!(limit_total <= 1_000 - vg_reserve, "within the spending policy");
    assert!(qty <= ammo_target(w.actor(VANGUARD).unwrap()) - 40);

    // 7. The purchase executes.
    w.execute(&Caller::Agent(VANGUARD.into()), buy.action.as_ref().unwrap()).unwrap();

    // 8. Both sides reconcile exactly.
    assert_eq!(ammo(&w, VG), 40 + qty);
    assert_eq!(w.balance(VG, Asset::Credits), 1_000 - limit_total);
    assert_eq!(ammo(&w, VEX_ACC), 100 - qty);
    assert_eq!(w.balance(VEX_ACC, Asset::Credits), 500 + limit_total);
    for asset in [Asset::Credits, Asset::Res(Resource::Ammo)] {
        assert_eq!(w.total(asset), 0);
    }

    // 10. The next mission reflects it. Right after the raid Vanguard could arm 5 rifle
    // guards (40 ammo); having bought ammunition it arms more.
    let after_raid_guards = raid_plan(&after_raid(), VANGUARD, Resource::Fuel).unwrap().guards;
    let after_buy_guards = raid_plan(&w, VANGUARD, Resource::Fuel).unwrap().guards;
    assert_eq!(after_raid_guards.hall.rifles + after_raid_guards.yard.rifles, 5);
    assert!(after_buy_guards.deployed() > after_raid_guards.deployed() || after_buy_guards.yard.rifles + after_buy_guards.hall.rifles > 5);
    assert!(before.deployed() >= after_raid_guards.deployed(), "the raid itself weakened the next defense");
}

#[test]
fn the_commander_cannot_buy_what_the_merchant_does_not_have() {
    let mut w = after_raid();
    // The merchant's ammunition is gone.
    w.apply(&[Transfer { from: VEX_ACC.into(), to: WORLD.into(), asset: Asset::Res(Resource::Ammo), qty: 100, reason: Reason::Consumption }]).unwrap();
    let d = policy::commander(&w, VANGUARD);
    let ammo_d = d.iter().find(|d| d.trigger == "ammo below target").unwrap();
    assert_eq!(ammo_d.action, None);
    assert!(ammo_d.rationale.contains("has none"), "{}", ammo_d.rationale);
}

#[test]
fn the_commander_buys_only_what_the_merchant_has() {
    let mut w = after_raid();
    w.apply(&[Transfer { from: VEX_ACC.into(), to: WORLD.into(), asset: Asset::Res(Resource::Ammo), qty: 97, reason: Reason::Consumption }]).unwrap();
    let d = policy::commander(&w, VANGUARD);
    let a = d.iter().find(|d| d.trigger == "ammo below target").and_then(|d| d.action.clone());
    assert!(matches!(a, Some(Action::Trade { qty: 3, .. })), "{a:?}");
}

#[test]
fn the_commander_does_not_spend_what_it_cannot_afford() {
    let mut w = after_raid();
    let reserve = w.actor(VANGUARD).unwrap().credit_reserve;
    let credits = w.balance(VG, Asset::Credits);
    // Leave it exactly at its reserve: nothing is spendable.
    w.apply(&[Transfer { from: VG.into(), to: WORLD.into(), asset: Asset::Credits, qty: credits - reserve, reason: Reason::Consumption }]).unwrap();
    let before = w.clone();
    let log = policy::run_fallback_agents(&mut w);
    let ammo_d = log.iter().find(|(d, _)| d.actor == VANGUARD && d.trigger == "ammo below target").unwrap();
    assert_eq!(ammo_d.0.action, None);
    assert!(ammo_d.0.rationale.contains("over the spending policy"), "{}", ammo_d.0.rationale);
    assert_eq!(ammo(&w, VG), ammo(&before, VG), "no purchase happened");
}

#[test]
fn a_rejected_proposal_changes_nothing() {
    // Even if a planner proposes a purchase the faction can't pay for, the engine refuses it.
    let mut w = after_raid();
    let before = w.clone();
    let q = w.quote(Resource::Ammo, Side::Buy, 90).unwrap();
    let r = w.execute(&Caller::Agent(VANGUARD.into()), &Action::Trade { resource: Resource::Ammo, side: Side::Buy, qty: 90, limit_total: q.total });
    assert!(matches!(r, Err(EconError::Insufficient { asset: Asset::Credits, .. })));
    assert_eq!(w, before);
}
