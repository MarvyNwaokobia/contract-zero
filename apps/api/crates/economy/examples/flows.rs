//! Where Vanguard's and Vex's credits go, per day, in the live world with no raids.
use cz_economy::policy::run_fallback_agents;
use cz_economy::*;
use std::collections::BTreeMap;
fn main() {
    let days: u64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(5);
    let mut w = genesis(2026);
    let mut cursor = 0;
    for d in 1..=days {
        for _ in 0..TICKS_PER_DAY { w.tick(); run_fallback_agents(&mut w); }
        let mut m: BTreeMap<String, i64> = BTreeMap::new();
        for e in &w.ledger[cursor..] {
            let t = &e.transfer;
            for (acct, sign) in [(&t.from, -1), (&t.to, 1)] {
                if (acct == "faction:vanguard" || acct == "merchant:vex") && t.asset == Asset::Credits {
                    let r = format!("{:?}", t.reason); let r = r.split([' ', '{']).next().unwrap().to_string();
                    *m.entry(format!("{} {}", &acct[..3], r)).or_default() += sign * t.qty;
                }
            }
        }
        cursor = w.ledger.len();
        println!("day {d} def {} fuel {} convoys_in_transit {} | {:?}", w.actors[VANGUARD].defense, w.balance("faction:vanguard", Asset::Res(Resource::Fuel)), w.convoys.values().filter(|c| c.status == ConvoyStatus::InTransit).count(), m);
    }
}
