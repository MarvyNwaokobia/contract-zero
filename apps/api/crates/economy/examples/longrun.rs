//! Long-run health check of the live world: agents every tick, a player raiding the
//! richest depot every `RAID_EVERY` ticks and selling the cargo back to the merchant.
//! Prints one line per day.  cargo run -p cz-economy --example longrun -- [days] [raid_every]
use cz_economy::mission::{self, raid_plan};
use cz_economy::policy::run_fallback_agents;
use cz_economy::*;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let days: u64 = a.get(1).and_then(|s| s.parse().ok()).unwrap_or(30);
    let raid_every: u64 = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(8);
    let mut w = genesis(2026);
    let p = "raider.testnet";
    let vg = "faction:vanguard";
    let vex = "merchant:vex";
    let mut empty_board_ticks = 0;
    let mut raids = 0;
    for t in 0..days * TICKS_PER_DAY {
        w.tick();
        run_fallback_agents(&mut w);
        let board: Vec<_> = Resource::ALL.iter().filter_map(|&r| raid_plan(&w, VANGUARD, r).map(|pl| (r, pl))).collect();
        if board.is_empty() { empty_board_ticks += 1; }
        if raid_every > 0 && t % raid_every == 0 {
            if let Some((r, _)) = board.iter().max_by_key(|(_, pl)| pl.manifest) {
                if w.execute(&Caller::Player(p.into()), &Action::StartRaid { target: VANGUARD.into(), resource: *r }).is_ok() {
                    let id = *w.raids.keys().last().unwrap();
                    w.execute(&Caller::System, &Action::SettleRaid { raid: id, player: p.into() }).unwrap();
                    raids += 1;
                    let have = w.balance(&player_account(p), Asset::Res(*r));
                    if have > 0 { let _ = w.execute(&Caller::Player(p.into()), &Action::Trade { resource: *r, side: Side::Sell, qty: have, limit_total: 0 }); }
                }
            }
        }
        if (t + 1) % TICKS_PER_DAY == 0 {
            let b = |acct: &str, x: Asset| w.balance(acct, x);
            println!(
                "day {:>3} VG cr {:>6} ammo {:>4} med {:>4} fuel {:>4} def {} | VEX cr {:>6} ammo {:>4} med {:>4} fuel {:>4}{} | board {} | ask a/m/f {}/{}/{}",
                (t + 1) / TICKS_PER_DAY, b(vg, Asset::Credits), b(vg, Asset::Res(Resource::Ammo)), b(vg, Asset::Res(Resource::Med)), b(vg, Asset::Res(Resource::Fuel)), w.actors[VANGUARD].defense,
                b(vex, Asset::Credits), b(vex, Asset::Res(Resource::Ammo)), b(vex, Asset::Res(Resource::Med)), b(vex, Asset::Res(Resource::Fuel)), if w.merchant_insolvent() { " INSOLVENT" } else { "" },
                board.len(), w.price(Resource::Ammo).ask, w.price(Resource::Med).ask, w.price(Resource::Fuel).ask,
            );
            let ash = "faction:ashen";
            if w.actors.contains_key(ASHEN) {
                let ab = mission::available_raids(&w).iter().filter(|p| p.target == ASHEN).count();
                println!("        ASH cr {:>6} ammo {:>4} med {:>4} fuel {:>4} def {} | ashen depots {} | bounties open {}", b(ash, Asset::Credits), b(ash, Asset::Res(Resource::Ammo)), b(ash, Asset::Res(Resource::Med)), b(ash, Asset::Res(Resource::Fuel)), w.actors[ASHEN].defense, ab, w.open_bounties().count());
            }
        }
    }
    println!("raids {raids}, ticks with an empty board {empty_board_ticks} of {}", days * TICKS_PER_DAY);
    let kinds = |k: OpKind| w.bounties.values().filter(|b| b.kind == k).count();
    let seized = w.convoys.values().filter(|c| matches!(c.status, ConvoyStatus::Seized { .. })).count();
    println!("contracts: raid {} sabotage {} recovery {}; caravans seized {seized}", kinds(OpKind::Raid), kinds(OpKind::Sabotage), kinds(OpKind::Recovery));
    let by = |s: &str| w.bounties.values().filter(|b| b.sponsor == s && b.kind == OpKind::Raid).count();
    println!("raid bounties by sponsor: vanguard {} ashen {} vex {}", by(VANGUARD), by(ASHEN), by(MERCHANT));
}
