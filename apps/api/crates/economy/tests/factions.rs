//! Two factions with different doctrines, memory of who hurt them, and rivalry acted
//! out through bounties the player decides whether to take.

use cz_economy::policy::commander;
use cz_economy::*;

const P: &str = "mercenary.testnet";
const VG: &str = "faction:vanguard";
const ASH: &str = "faction:ashen";

fn conserved(w: &World) {
    for a in [Asset::Credits, Asset::Res(Resource::Ammo), Asset::Res(Resource::Med), Asset::Res(Resource::Fuel)] {
        assert_eq!(w.total(a), 0, "{a:?}");
        assert_eq!(w.balance(WORLD, a), w.destroyed(a) - w.issued(a), "{a:?}");
    }
}

#[test]
fn the_live_world_has_two_factions_with_different_economies_and_doctrines() {
    let w = genesis(1);
    let (v, a) = (&w.actors[VANGUARD], &w.actors[ASHEN]);
    assert_eq!(a.kind, ActorKind::Faction);
    // Mirror economies: Vanguard makes ammunition, Ashen refines fuel.
    assert!(v.production[0] > 0 && a.production[0] == 0);
    assert!(a.production[2] > 0 && v.production[2] == 0);
    // Different characters.
    assert!(a.doctrine.aggression > v.doctrine.aggression);
    assert!(a.doctrine.max_price_mult > v.doctrine.max_price_mult);
    assert!(a.doctrine.base_defense < v.doctrine.base_defense);
    conserved(&w);
}

#[test]
fn an_aggressive_faction_pays_to_have_a_richer_rival_raided_and_a_cautious_one_does_not() {
    let mut w = genesis(1);
    w.grant(VG, Asset::Credits, 20_000); // Vanguard far richer than Ashen
    let ash = commander(&w, ASHEN);
    assert!(ash.iter().any(|d| d.trigger == "pre-emptive strike" && matches!(&d.action, Some(Action::PostBounty { target, .. }) if target == VANGUARD)), "{ash:#?}");
    // Make Ashen the rich one: cautious Vanguard does not strike first.
    w.grant(ASH, Asset::Credits, 60_000);
    let vg = commander(&w, VANGUARD);
    assert!(!vg.iter().any(|d| matches!(&d.action, Some(Action::PostBounty { .. }))), "{vg:#?}");
}

#[test]
fn a_faction_remembers_the_player_and_the_rival_who_paid_and_retaliates() {
    let mut w = genesis(1);
    w.grant(VG, Asset::Credits, 20_000);
    // Ashen posts a bounty on a Vanguard depot; a player takes it.
    let d = commander(&w, ASHEN).into_iter().find(|d| d.trigger == "pre-emptive strike").expect("ashen strikes");
    let Some(Action::PostBounty { resource, .. }) = d.action.clone() else { unreachable!() };
    w.execute(&Caller::Agent(ASHEN.into()), d.action.as_ref().unwrap()).unwrap();
    w.execute(&Caller::Player(P.into()), &Action::StartRaid { target: VANGUARD.into(), resource }).unwrap();
    let raid = *w.raids.keys().last().unwrap();
    w.execute(&Caller::System, &Action::SettleRaid { raid, player: P.into() }).unwrap();

    let mem = &w.memory[VANGUARD];
    assert_eq!(mem.players[P].raids, 1);
    assert!(mem.players[P].units_lost > 0);
    assert_eq!(mem.sponsors[ASHEN].len(), 1, "Vanguard knows Ashen paid for it");

    // Vanguard, normally cautious, now retaliates against Ashen.
    let vg = commander(&w, VANGUARD);
    let r = vg.iter().find(|d| d.trigger == "retaliation").expect("retaliation");
    assert!(matches!(&r.action, Some(Action::PostBounty { target, .. }) if target == ASHEN), "{r:#?}");
    w.execute(&Caller::Agent(VANGUARD.into()), r.action.as_ref().unwrap()).unwrap();
    // …once: it does not stack bounties on the same rival.
    assert!(!commander(&w, VANGUARD).iter().any(|d| d.trigger == "retaliation" && d.action.is_some()));

    // The grudge fades.
    for _ in 0..=policy::GRUDGE_TICKS + BOUNTY_TICKS {
        w.tick();
    }
    assert!(!commander(&w, VANGUARD).iter().any(|d| d.trigger == "retaliation"));
    conserved(&w);
}

#[test]
fn surplus_of_any_resource_is_sold() {
    let mut w = genesis(1);
    w.grant(ASH, Asset::Res(Resource::Fuel), 300);
    let ash = commander(&w, ASHEN);
    assert!(ash.iter().any(|d| matches!(d.action, Some(Action::Trade { resource: Resource::Fuel, side: Side::Sell, .. }))), "{ash:#?}");
}

#[test]
fn a_world_from_before_the_rival_gains_it_once() {
    let mut w = genesis(1);
    w.actors.remove(ASHEN);
    let before = w.total(Asset::Credits);
    assert!(add_rival(&mut w));
    assert!(!add_rival(&mut w));
    assert_eq!(w.total(Asset::Credits), before);
    conserved(&w);
}
