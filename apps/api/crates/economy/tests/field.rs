//! Physical cargo: the player is paid for the cases they carried out, nothing more.

use cz_economy::mission::{assess, field_manifest, FieldRecord};
use cz_economy::*;

const PLAYER: &str = "raider.testnet";
const VG: &str = "faction:vanguard";

fn start(w: &mut World) -> u64 {
    w.execute(&Caller::Player(PLAYER.into()), &Action::StartRaid { target: VANGUARD.into(), resource: Resource::Ammo }).unwrap();
    *w.raids.keys().last().unwrap()
}

#[test]
fn partial_extraction_pays_only_the_secured_cases() {
    let mut w = scenario::acceptance();
    let raid = start(&mut w);
    let plan = w.raids[&raid].plan.clone();
    assert_eq!(plan.site, "dustline-depot");
    let m = field_manifest(&w, &plan);
    assert_eq!(m.cases.len(), 3); // 60 units → 3 cases of 20
    let units = assess(OpKind::Raid, &m, &FieldRecord { secured: vec!["case-2".into()], ..Default::default() }).unwrap();
    assert_eq!(units, 20);
    w.execute(&Caller::System, &Action::SettleSecured { raid, player: PLAYER.into(), units }).unwrap();
    assert_eq!(w.balance(&player_account(PLAYER), Asset::Res(Resource::Ammo)), 20);
    assert_eq!(w.balance(VG, Asset::Res(Resource::Ammo)), 80);
    // Settling again is refused: the raid is closed.
    assert!(w.execute(&Caller::System, &Action::SettleSecured { raid, player: PLAYER.into(), units: 60 }).is_err());
}

#[test]
fn a_secured_amount_can_never_exceed_the_manifest() {
    let mut w = scenario::acceptance();
    let raid = start(&mut w);
    w.execute(&Caller::System, &Action::SettleSecured { raid, player: PLAYER.into(), units: 10_000 }).unwrap();
    assert_eq!(w.balance(&player_account(PLAYER), Asset::Res(Resource::Ammo)), 60);
}

#[test]
fn only_the_system_settles_secured_cargo() {
    let mut w = scenario::acceptance();
    let raid = start(&mut w);
    let r = w.execute(&Caller::Player(PLAYER.into()), &Action::SettleSecured { raid, player: PLAYER.into(), units: 60 });
    assert!(matches!(r, Err(EconError::Unauthorized { .. })));
}
