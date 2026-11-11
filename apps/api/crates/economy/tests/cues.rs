//! What a site's economy looks like to the fight: lines that are down, deliveries landing.

use cz_economy::site::{self, ARRIVED_WINDOW_TICKS, DELIVERY_WINDOW_TICKS};
use cz_economy::*;

const P: &str = "saboteur.testnet";
const VEX: &str = "merchant:vex";

#[test]
fn a_quiet_site_has_no_cues() {
    let w = genesis(5);
    for s in site::SITES.iter() {
        let c = site::world_cues(&w, s);
        assert!(c.lines_down.is_empty() && c.deliveries.is_empty(), "{}", s.id);
        assert_eq!(c.tick, w.tick);
    }
}

#[test]
fn a_sabotaged_line_is_down_at_its_site_for_exactly_the_real_duration_then_back() {
    let mut w = genesis(5);
    let a = &w.actors[VANGUARD];
    let fee = (a.production[0] + w.balance("faction:vanguard", Asset::Res(Resource::Ammo)) * SABOTAGE_SHARE_BP / 10_000) * pricing::production_cost(Resource::Ammo) * 3_000 / 10_000;
    w.execute(&Caller::Agent(MERCHANT.into()), &Action::PostContract { kind: OpKind::Sabotage, target: VANGUARD.into(), resource: Resource::Ammo, amount: fee, convoy: None }).unwrap();
    w.execute(&Caller::Player(P.into()), &Action::StartOperation { kind: OpKind::Sabotage, target: VANGUARD.into(), resource: Resource::Ammo }).unwrap();
    let id = *w.raids.keys().last().unwrap();
    w.execute(&Caller::System, &Action::SettleRaid { raid: id, player: P.into() }).unwrap();

    // Vanguard's munitions line is down at Dustline Depot (where the ammunition line is), and at the Blacksite only for
    // the lines that site names. The cinder yard is Ashen's and is untouched.
    let dep = site::world_cues(&w, &site::DUSTLINE_DEPOT);
    assert_eq!(dep.lines_down.len(), 1);
    assert_eq!(dep.lines_down[0].resource, Resource::Ammo);
    assert_eq!(dep.lines_down[0].line, "munitions line");
    assert_eq!(dep.lines_down[0].until, w.tick + SABOTAGE_TICKS);
    assert!(site::world_cues(&w, &site::CINDER_YARD).lines_down.is_empty());

    for _ in 0..SABOTAGE_TICKS {
        w.tick();
    }
    assert!(site::world_cues(&w, &site::DUSTLINE_DEPOT).lines_down.is_empty(), "it comes back when the clock says");
}

#[test]
fn only_a_line_the_site_actually_has_is_reported() {
    // The Cinder Yard has no ammunition line: sabotaging ammunition production never shows there.
    let mut w = genesis(5);
    w.actors.get_mut(ASHEN).unwrap().disrupted_until[Resource::Ammo.idx()] = w.tick + 10;
    assert!(site::world_cues(&w, &site::CINDER_YARD).lines_down.is_empty());
    w.actors.get_mut(ASHEN).unwrap().disrupted_until[Resource::Fuel.idx()] = w.tick + 10;
    let c = site::world_cues(&w, &site::CINDER_YARD);
    assert_eq!(c.lines_down.len(), 1);
    assert_eq!(c.lines_down[0].line, "fractionation unit");
}

#[test]
fn a_delivery_shows_only_as_it_lands_and_just_after() {
    let mut w = genesis(5);
    let _ = VEX;
    // find a shipment of Vanguard's on the road and watch its window
    let mut seen_arriving = false;
    let mut seen_arrived = false;
    for _ in 0..3 * TICKS_PER_DAY {
        w.tick();
        let cues = site::world_cues(&w, &site::DUSTLINE_DEPOT);
        for d in &cues.deliveries {
            let c = w.convoys.values().find(|c| c.owner == VANGUARD && c.arrives_at == d.arrives_at && c.resource == d.resource).expect("a real convoy");
            match d.state.as_str() {
                "arriving" => { seen_arriving = true; assert_eq!(c.status, ConvoyStatus::InTransit); assert!(c.arrives_at - w.tick <= DELIVERY_WINDOW_TICKS); }
                "arrived" => { seen_arrived = true; assert_eq!(c.status, ConvoyStatus::Arrived); assert!(w.tick - c.arrives_at < ARRIVED_WINDOW_TICKS); }
                other => panic!("{other}"),
            }
            assert_eq!(d.units, c.units);
        }
        // a delivery far from landing or long landed is never reported
        for c in w.convoys.values().filter(|c| c.owner == VANGUARD) {
            let reported = cues.deliveries.iter().any(|d| d.arrives_at == c.arrives_at && d.resource == c.resource);
            if c.status == ConvoyStatus::InTransit && c.arrives_at - w.tick > DELIVERY_WINDOW_TICKS { assert!(!reported); }
            if c.status == ConvoyStatus::Arrived && w.tick - c.arrives_at >= ARRIVED_WINDOW_TICKS { assert!(!reported); }
        }
    }
    assert!(seen_arriving && seen_arrived, "Vanguard receives shipments in three days");
}

#[test]
fn cues_round_trip_through_json() {
    let mut w = genesis(5);
    w.actors.get_mut(VANGUARD).unwrap().disrupted_until[Resource::Fuel.idx()] = w.tick + 12;
    let c = site::world_cues(&w, &site::DUSTLINE_DEPOT);
    let v = serde_json::to_value(&c).unwrap();
    assert_eq!(v["lines_down"][0]["resource"], "fuel");
    assert_eq!(v["lines_down"][0]["line"], "fuel depot");
    assert_eq!(serde_json::from_value::<site::WorldCues>(v).unwrap(), c);
}
