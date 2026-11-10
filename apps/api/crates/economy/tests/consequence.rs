//! The recorded consequence of an operation: real before and after, nothing interpolated.

use cz_economy::consequence::{begin, faction_snapshot, next_plan, settle};
use cz_economy::mission::raid_plan;
use cz_economy::*;

const PLAYER: &str = "raider.testnet";
const VG: &str = "faction:vanguard";

fn ammo(w: &World, acct: &str) -> i64 {
    w.balance(acct, Asset::Res(Resource::Ammo))
}

#[test]
fn a_raid_records_what_the_target_lost_and_what_the_next_raid_faces() {
    let mut w = acceptance();
    let plan = raid_plan(&w, VANGUARD, Resource::Ammo).unwrap();
    let open = begin(&w, &plan).expect("vanguard exists");
    assert_eq!(open.before.holdings.ammo, 100);
    assert_eq!(open.faced.manifest, 60);
    assert!(open.after.is_none() && open.next.is_none() && open.settled_tick.is_none(), "nothing is recorded before it happens");

    w.execute(&Caller::Player(PLAYER.into()), &Action::StartRaid { target: VANGUARD.into(), resource: Resource::Ammo }).unwrap();
    let raid = *w.raids.keys().last().unwrap();
    w.execute(&Caller::System, &Action::SettleRaid { raid, player: PLAYER.into() }).unwrap();
    let done = settle(open, &w);

    let after = done.after.as_ref().unwrap();
    assert_eq!(after.holdings.ammo, 40, "the same 60 the player carried out left the shelf");
    assert_eq!(done.before.holdings.ammo - after.holdings.ammo, ammo(&w, &player_account(PLAYER)));
    assert_eq!(done.settled_tick, Some(w.tick));

    // The next raid is the engine's own plan on the new stock, so it can only be thinner.
    let next = done.next.as_ref().unwrap();
    assert_eq!(*next, next_plan(&w, OpKind::Raid, VANGUARD, Resource::Ammo));
    let (b, n) = (done.faced.guards.as_ref().unwrap(), next.guards.as_ref().unwrap());
    assert!(n.hall.total() + n.yard.total() <= b.hall.total() + b.yard.total());
}

#[test]
fn an_unavailable_next_operation_says_why() {
    let mut w = acceptance();
    // Strip Vanguard's fuel: the engine cannot stage a depot.
    let acct = w.actor(VANGUARD).unwrap().account.clone();
    let fuel = w.balance(&acct, Asset::Res(Resource::Fuel));
    w.apply(&[Transfer { from: acct.clone(), to: "merchant:vex".into(), asset: Asset::Res(Resource::Fuel), qty: fuel, reason: Reason::Income }]).unwrap();
    let n = next_plan(&w, OpKind::Raid, VANGUARD, Resource::Ammo);
    assert!(!n.available && n.guards.is_none());
    assert!(n.reason.unwrap().contains("fuel"));
}

#[test]
fn snapshots_read_the_world_and_nothing_else() {
    let w = acceptance();
    let s = faction_snapshot(&w, VANGUARD).unwrap();
    assert_eq!(s.holdings.credits, w.balance(VG, Asset::Credits));
    assert!(faction_snapshot(&w, "faction:nobody").is_none());
    let json = serde_json::to_value(&s).unwrap();
    assert_eq!(json["holdings"]["ammo"], 100);
    assert_eq!(json["requirement"]["med"], w.actor(VANGUARD).unwrap().requirement(Resource::Med));
    assert_eq!(serde_json::from_value::<cz_economy::consequence::FactionSnapshot>(json).unwrap(), s);
}

#[test]
fn starting_a_raid_does_not_move_the_target_stock() {
    // The server opens the record right after StartRaid; that is only a true "before" if
    // starting a raid leaves the faction's holdings as they were.
    let mut w = acceptance();
    let before = faction_snapshot(&w, VANGUARD).unwrap();
    w.execute(&Caller::Player(PLAYER.into()), &Action::StartRaid { target: VANGUARD.into(), resource: Resource::Ammo }).unwrap();
    assert_eq!(faction_snapshot(&w, VANGUARD).unwrap(), before);
}
