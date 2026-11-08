//! The live world must stay playable for as long as it runs: a contract on the board,
//! factions that neither collapse nor hoard their way out of reach, a merchant that
//! keeps every shelf stocked, and posture that responds to what players do.

use cz_economy::mission::raid_plan;
use cz_economy::policy::run_fallback_agents;
use cz_economy::*;

const P: &str = "raider.testnet";
const VG: &str = "faction:vanguard";
const VEX: &str = "merchant:vex";

fn conserved(w: &World) {
    for a in [Asset::Credits, Asset::Res(Resource::Ammo), Asset::Res(Resource::Med), Asset::Res(Resource::Fuel)] {
        assert_eq!(w.total(a), 0, "{a:?}");
        assert_eq!(w.balance(WORLD, a), w.destroyed(a) - w.issued(a), "{a:?} classification drift");
    }
}

fn board(w: &World) -> Vec<(Resource, i64)> {
    Resource::ALL.iter().filter_map(|&r| raid_plan(w, VANGUARD, r).map(|p| (r, p.manifest))).collect()
}

/// One player raiding the richest depot every `every` ticks (0 = never), selling the
/// cargo back to the merchant. `f` sees the world after each tick.
fn run(w: &mut World, ticks: u64, every: u64, mut f: impl FnMut(&World)) {
    for _ in 0..ticks {
        w.tick();
        run_fallback_agents(w);
        if every > 0 && w.tick % every == 0 {
            if let Some((r, _)) = board(w).into_iter().max_by_key(|(_, m)| *m) {
                if w.execute(&Caller::Player(P.into()), &Action::StartRaid { target: VANGUARD.into(), resource: r }).is_ok() {
                    let id = *w.raids.keys().last().unwrap();
                    w.execute(&Caller::System, &Action::SettleRaid { raid: id, player: P.into() }).unwrap();
                    let have = w.balance(&player_account(P), Asset::Res(r));
                    let _ = w.execute(&Caller::Player(P.into()), &Action::Trade { resource: r, side: Side::Sell, qty: have, limit_total: 0 });
                }
            }
        }
        f(w);
    }
}

#[test]
fn a_quiet_faction_fortifies_but_cannot_hoard() {
    let mut w = genesis(2026);
    let a = w.actors[VANGUARD].clone();
    let cap = a.credit_reserve + WAR_CHEST_DAYS * a.income_per_day + a.income_per_day;
    let mut peak = 0;
    run(&mut w, 60 * TICKS_PER_DAY, 0, |w| peak = peak.max(w.balance(VG, Asset::Credits)));
    assert!(peak <= cap, "treasury peaked at {peak}, cap {cap}");
    assert!(w.actors[VANGUARD].defense >= 3, "a rich quiet faction should fortify");
    conserved(&w);
}

#[test]
fn under_daily_raids_the_board_never_empties_and_posture_responds() {
    let mut w = genesis(2026);
    let mut empty = 0;
    let mut postures = std::collections::BTreeSet::new();
    let mut insolvent_run = 0u64;
    let mut worst_insolvent_run = 0u64;
    run(&mut w, 60 * TICKS_PER_DAY, TICKS_PER_DAY, |w| {
        if board(w).is_empty() {
            empty += 1;
        }
        postures.insert(w.actors[VANGUARD].defense);
        insolvent_run = if w.merchant_insolvent() { insolvent_run + 1 } else { 0 };
        worst_insolvent_run = worst_insolvent_run.max(insolvent_run);
        assert!(w.balance(VG, Asset::Credits) >= 0);
    });
    assert_eq!(empty, 0, "ticks with nothing to raid");
    assert!(postures.len() >= 3, "defense should swing with raids and treasury: {postures:?}");
    assert!(worst_insolvent_run <= 2 * TICKS_PER_DAY, "merchant insolvent for {worst_insolvent_run} ticks in a row");
    conserved(&w);
}

#[test]
fn a_bled_faction_recovers_once_the_raids_stop() {
    let mut w = genesis(2026);
    run(&mut w, 20 * TICKS_PER_DAY, 4, |_| {});
    let low = w.balance(VG, Asset::Credits);
    let mut empty_late = 0;
    let mut tick = 0;
    run(&mut w, 20 * TICKS_PER_DAY, 0, |w| {
        tick += 1;
        if tick > 10 * TICKS_PER_DAY && board(w).is_empty() {
            empty_late += 1;
        }
    });
    assert_eq!(empty_late, 0, "the board should refill once raids stop");
    assert!(w.balance(VG, Asset::Credits) > low, "treasury should rebuild");
    assert!(w.actors[VANGUARD].defense >= 2, "posture should recover");
    conserved(&w);
}

#[test]
fn the_merchant_restocks_a_sold_out_shelf_by_caravan() {
    let mut w = genesis(2026);
    let fuel = w.balance(VEX, Asset::Res(Resource::Fuel));
    w.apply(&[Transfer { from: VEX.into(), to: WORLD.into(), asset: Asset::Res(Resource::Fuel), qty: fuel, reason: Reason::Consumption }]).unwrap();
    for _ in 0..2 * TICKS_PER_DAY {
        w.tick();
    }
    assert!(w.balance(VEX, Asset::Res(Resource::Fuel)) > 0, "fuel shelf should be restocked");
    assert!(w.convoys.values().any(|c| c.owner == MERCHANT && c.resource == Resource::Fuel), "by a caravan on the road");
    conserved(&w);
}

#[test]
fn living_rules_stay_off_in_the_acceptance_world() {
    let mut w = acceptance();
    let before = w.balance(VG, Asset::Credits);
    for _ in 0..TICKS_PER_DAY {
        w.tick();
    }
    assert!(!w.market.living);
    assert!(!w.ledger.iter().any(|e| matches!(e.transfer.reason, Reason::Upkeep | Reason::Dividend | Reason::Remittance | Reason::Export)));
    assert_eq!(w.balance(VG, Asset::Credits), before + w.actors[VANGUARD].income_per_day);
}
