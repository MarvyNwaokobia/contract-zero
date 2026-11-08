use cz_economy::mission::{self, raid_plan, STAGING_FUEL};
use cz_economy::policy::run_fallback_agents;
use cz_economy::*;

const PLAYER: &str = "raider.testnet";
const VG: &str = "faction:vanguard";

fn assert_conserved(w: &World) {
    for asset in [Asset::Credits, Asset::Res(Resource::Ammo), Asset::Res(Resource::Med), Asset::Res(Resource::Fuel)] {
        assert_eq!(w.total(asset), 0, "{asset:?} not conserved at tick {}", w.tick);
        // WORLD's balance is exactly destroyed − issued.
        assert_eq!(w.balance(WORLD, asset), w.destroyed(asset) - w.issued(asset), "{asset:?} issuance/destruction drift");
    }
    for (acct, m) in &w.balances {
        if acct != WORLD {
            for (asset, v) in m {
                assert!(*v >= 0, "{acct} holds {v} {asset:?}");
            }
        }
    }
}

fn raid(w: &mut World, player: &str, r: Resource) -> u64 {
    w.execute(&Caller::Player(player.into()), &Action::StartRaid { target: VANGUARD.into(), resource: r }).unwrap();
    *w.raids.keys().last().unwrap()
}

fn fund(w: &mut World, player: &str, credits: i64) {
    w.grant(&player_account(player), Asset::Credits, credits);
}

// ── conservation ──────────────────────────────────────────────────────────────

#[test]
fn a_week_of_agents_and_raids_conserves_every_asset() {
    let mut w = genesis(42);
    let mut rng = 0xC0FFEEu64;
    let mut raided = 0;
    for t in 0..(7 * TICKS_PER_DAY) {
        w.tick();
        if t % 6 == 0 {
            run_fallback_agents(&mut w);
        }
        rng = splitmix(rng);
        if rng % 9 == 0 {
            let r = Resource::ALL[(rng >> 8) as usize % 3];
            if raid_plan(&w, VANGUARD, r).is_some() {
                let id = raid(&mut w, PLAYER, r);
                let ok = (rng >> 16) % 3 != 0;
                let act = if ok { Action::SettleRaid { raid: id, player: PLAYER.into() } } else { Action::FailRaid { raid: id, player: PLAYER.into() } };
                w.execute(&Caller::System, &act).unwrap();
                raided += ok as usize;
                // The raider sells some loot back to the market.
                let have = w.balance(&player_account(PLAYER), Asset::Res(r));
                if have > 0 && !w.merchant_insolvent() {
                    if let Ok(q) = w.quote(r, Side::Sell, have) {
                        // The merchant may not have the cash to buy it all: a legitimate refusal.
                        match w.execute(&Caller::Player(PLAYER.into()), &Action::Trade { resource: r, side: Side::Sell, qty: have, limit_total: q.total }) {
                            Ok(_) | Err(EconError::Insufficient { asset: Asset::Credits, .. }) | Err(EconError::MerchantInsolvent) => {}
                            Err(e) => panic!("unexpected trade error: {e}"),
                        }
                    }
                }
            }
        }
        assert_conserved(&w);
    }
    assert!(raided > 3, "the week should include raids ({raided})");
    assert!(w.convoys.values().any(|c| c.status == ConvoyStatus::Arrived), "and shipments that arrived");
}

#[test]
fn the_ledger_replays_to_the_same_balances() {
    let mut w = genesis(3);
    for _ in 0..48 {
        w.tick();
        run_fallback_agents(&mut w);
    }
    let mut replay: std::collections::BTreeMap<(String, Asset), i64> = Default::default();
    for e in &w.ledger {
        *replay.entry((e.transfer.from.clone(), e.transfer.asset)).or_default() -= e.transfer.qty;
        *replay.entry((e.transfer.to.clone(), e.transfer.asset)).or_default() += e.transfer.qty;
    }
    for ((acct, asset), v) in replay {
        assert_eq!(w.balance(&acct, asset), v, "{acct} {asset:?}");
    }
}

#[test]
fn the_same_seed_and_commands_give_the_same_world() {
    let run = || {
        let mut w = genesis(99);
        for _ in 0..72 {
            w.tick();
            run_fallback_agents(&mut w);
        }
        w
    };
    assert_eq!(run(), run());
}

#[test]
fn a_batch_with_one_bad_transfer_changes_nothing() {
    let mut w = genesis(1);
    let before = w.clone();
    let err = w.apply(&[
        Transfer { from: "merchant:vex".into(), to: VG.into(), asset: Asset::Credits, qty: 10, reason: Reason::Income },
        Transfer { from: VG.into(), to: "merchant:vex".into(), asset: Asset::Res(Resource::Fuel), qty: 1_000_000, reason: Reason::Income },
    ]);
    assert!(matches!(err, Err(EconError::Insufficient { .. })));
    assert_eq!(w, before);
}

#[test]
fn consumption_never_drives_a_balance_negative_it_records_a_shortage() {
    let mut w = genesis(1);
    w.actors.get_mut(VANGUARD).unwrap().shipment = None;
    let mut shortages = 0;
    for _ in 0..(5 * TICKS_PER_DAY) {
        shortages += w.tick().iter().filter(|e| matches!(e, Event::Shortage { resource: Resource::Fuel, .. })).count();
    }
    assert_eq!(w.balance(VG, Asset::Res(Resource::Fuel)), 0);
    assert!(shortages > 0);
    assert_conserved(&w);
}

// ── fuel: logistics and mission availability ─────────────────────────────────

#[test]
fn without_fuel_there_is_no_depot_to_raid_and_no_shipment() {
    let mut w = genesis(1);
    let fuel = w.balance(VG, Asset::Res(Resource::Fuel));
    w.apply(&[Transfer { from: VG.into(), to: WORLD.into(), asset: Asset::Res(Resource::Fuel), qty: fuel - (STAGING_FUEL - 1), reason: Reason::Consumption }]).unwrap();
    assert!(mission::available_raids(&w).is_empty(), "no fuel to stage a depot");
    let r = w.execute(&Caller::Player(PLAYER.into()), &Action::StartRaid { target: VANGUARD.into(), resource: Resource::Ammo });
    assert!(matches!(r, Err(EconError::NoRaidTarget { .. })));
    // Burn the rest: the next shipment is grounded.
    w.apply(&[Transfer { from: VG.into(), to: WORLD.into(), asset: Asset::Res(Resource::Fuel), qty: STAGING_FUEL - 1, reason: Reason::Consumption }]).unwrap();
    let ev = w.tick();
    assert!(ev.iter().any(|e| matches!(e, Event::LogisticsGrounded { .. })));
}

// ── trading ───────────────────────────────────────────────────────────────────

#[test]
fn a_buy_moves_credits_and_units_at_the_quoted_total() {
    let mut w = genesis(1);
    fund(&mut w, PLAYER, 10_000);
    let q = w.quote(Resource::Med, Side::Buy, 5).unwrap();
    let stock = w.merchant_stock(Resource::Med);
    w.execute(&Caller::Player(PLAYER.into()), &Action::Trade { resource: Resource::Med, side: Side::Buy, qty: 5, limit_total: q.total }).unwrap();
    assert_eq!(w.balance(&player_account(PLAYER), Asset::Credits), 10_000 - q.total);
    assert_eq!(w.balance(&player_account(PLAYER), Asset::Res(Resource::Med)), 5);
    assert_eq!(w.merchant_stock(Resource::Med), stock - 5);
}

#[test]
fn buying_more_than_the_merchant_holds_is_rejected() {
    let mut w = genesis(1);
    fund(&mut w, PLAYER, 1_000_000);
    let before = w.clone();
    let qty = w.merchant_stock(Resource::Fuel) + 1;
    let r = w.execute(&Caller::Player(PLAYER.into()), &Action::Trade { resource: Resource::Fuel, side: Side::Buy, qty, limit_total: i64::MAX });
    assert!(matches!(r, Err(EconError::MerchantShort { .. })));
    assert_eq!(w, before);
}

#[test]
fn buying_without_the_credits_is_rejected() {
    let mut w = genesis(1);
    let before = w.clone();
    let r = w.execute(&Caller::Player(PLAYER.into()), &Action::Trade { resource: Resource::Ammo, side: Side::Buy, qty: 3, limit_total: i64::MAX });
    assert!(matches!(r, Err(EconError::Insufficient { asset: Asset::Credits, .. })));
    assert_eq!(w, before);
}

#[test]
fn selling_units_you_do_not_hold_is_rejected() {
    let mut w = genesis(1);
    let r = w.execute(&Caller::Player(PLAYER.into()), &Action::Trade { resource: Resource::Fuel, side: Side::Sell, qty: 5, limit_total: 0 });
    assert!(matches!(r, Err(EconError::Insufficient { asset: Asset::Res(Resource::Fuel), .. })));
}

#[test]
fn two_orders_on_the_same_quote_cannot_both_fill_at_the_old_price() {
    let mut w = genesis(1);
    fund(&mut w, PLAYER, 100_000);
    fund(&mut w, "other.testnet", 100_000);
    let q = w.quote(Resource::Fuel, Side::Buy, 25).unwrap();
    let order = Action::Trade { resource: Resource::Fuel, side: Side::Buy, qty: 25, limit_total: q.total };
    w.execute(&Caller::Player(PLAYER.into()), &order).unwrap();
    let before = w.clone();
    let second = w.execute(&Caller::Player("other.testnet".into()), &order);
    assert!(matches!(second, Err(EconError::PriceMoved { total, limit }) if total > limit));
    assert_eq!(w, before);
}

#[test]
fn an_insolvent_merchant_refuses_to_buy_and_stops_restocking() {
    let mut w = genesis(1);
    let credits = w.balance("merchant:vex", Asset::Credits);
    w.apply(&[Transfer { from: "merchant:vex".into(), to: WORLD.into(), asset: Asset::Credits, qty: credits - 100, reason: Reason::ImportCost { convoy: 0 } }]).unwrap();
    assert!(w.merchant_insolvent());
    w.grant(&player_account(PLAYER), Asset::Res(Resource::Ammo), 10);
    let r = w.execute(&Caller::Player(PLAYER.into()), &Action::Trade { resource: Resource::Ammo, side: Side::Sell, qty: 10, limit_total: 0 });
    assert_eq!(r, Err(EconError::MerchantInsolvent));
    // It still sells (that is how it recovers).
    fund(&mut w, PLAYER, 1_000);
    let q = w.quote(Resource::Med, Side::Buy, 1).unwrap();
    w.execute(&Caller::Player(PLAYER.into()), &Action::Trade { resource: Resource::Med, side: Side::Buy, qty: 1, limit_total: q.total }).unwrap();
    // And its caravan stays home.
    let mut suspended = false;
    for _ in 0..TICKS_PER_DAY {
        suspended |= w.tick().iter().any(|e| matches!(e, Event::MerchantSuspended { .. }));
    }
    assert!(suspended);
    let d = policy::merchant(&w);
    assert!(d.iter().all(|d| d.action.is_none()) && d[0].trigger == "insolvency");
}

// ── raids ─────────────────────────────────────────────────────────────────────

#[test]
fn a_raid_moves_the_depot_to_the_player_and_settles_once() {
    let mut w = genesis(1);
    let ammo = w.balance(VG, Asset::Res(Resource::Ammo));
    let id = raid(&mut w, PLAYER, Resource::Ammo);
    let manifest = w.raids[&id].plan.manifest;
    let settle = Action::SettleRaid { raid: id, player: PLAYER.into() };
    w.execute(&Caller::System, &settle).unwrap();
    assert_eq!(w.balance(VG, Asset::Res(Resource::Ammo)), ammo - manifest);
    assert_eq!(w.balance(&player_account(PLAYER), Asset::Res(Resource::Ammo)), manifest);
    let after = w.clone();
    assert_eq!(w.execute(&Caller::System, &settle), Err(EconError::AlreadySettled { raid: id }));
    assert_eq!(w, after, "a replayed settlement pays nothing");
    assert_conserved(&w);
}

#[test]
fn a_raid_pays_only_what_the_depot_still_holds() {
    let mut w = genesis(1);
    let id = raid(&mut w, PLAYER, Resource::Ammo);
    // While the raid is in progress the faction spends most of its ammunition.
    let left = 5;
    let ammo = w.balance(VG, Asset::Res(Resource::Ammo));
    w.apply(&[Transfer { from: VG.into(), to: WORLD.into(), asset: Asset::Res(Resource::Ammo), qty: ammo - left, reason: Reason::Consumption }]).unwrap();
    w.execute(&Caller::System, &Action::SettleRaid { raid: id, player: PLAYER.into() }).unwrap();
    assert_eq!(w.balance(&player_account(PLAYER), Asset::Res(Resource::Ammo)), left, "nothing is minted to cover the gap");
}

#[test]
fn only_the_raider_can_be_paid_and_a_failed_raid_pays_nothing() {
    let mut w = genesis(1);
    let id = raid(&mut w, PLAYER, Resource::Fuel);
    assert_eq!(w.execute(&Caller::System, &Action::SettleRaid { raid: id, player: "other.testnet".into() }), Err(EconError::RaidNotActive { raid: id }));
    w.execute(&Caller::System, &Action::FailRaid { raid: id, player: PLAYER.into() }).unwrap();
    assert_eq!(w.execute(&Caller::System, &Action::SettleRaid { raid: id, player: PLAYER.into() }), Err(EconError::RaidNotActive { raid: id }));
    assert_eq!(w.balance(&player_account(PLAYER), Asset::Res(Resource::Fuel)), 0);
}

#[test]
fn one_raid_at_a_time_per_player() {
    let mut w = genesis(1);
    raid(&mut w, PLAYER, Resource::Ammo);
    let r = w.execute(&Caller::Player(PLAYER.into()), &Action::StartRaid { target: VANGUARD.into(), resource: Resource::Fuel });
    assert_eq!(r, Err(EconError::RaidInProgress));
}

#[test]
fn a_sponsored_raid_pays_the_bounty_and_an_unclaimed_one_is_refunded() {
    let mut w = genesis(1);
    let plan = raid_plan(&w, VANGUARD, Resource::Fuel).unwrap();
    let amount = plan.manifest * pricing::production_cost(Resource::Fuel) / 2;
    w.execute(&Caller::Agent(MERCHANT.into()), &Action::PostBounty { target: VANGUARD.into(), resource: Resource::Fuel, amount }).unwrap();
    let id = raid(&mut w, PLAYER, Resource::Fuel);
    w.execute(&Caller::System, &Action::SettleRaid { raid: id, player: PLAYER.into() }).unwrap();
    assert_eq!(w.balance(&player_account(PLAYER), Asset::Credits), amount);
    assert!(matches!(w.raids[&id].status, RaidStatus::Extracted { bounty, .. } if bounty == amount));

    // A second bounty no one claims goes back to its sponsor.
    let plan = raid_plan(&w, VANGUARD, Resource::Ammo).unwrap();
    let amount = plan.manifest * pricing::production_cost(Resource::Ammo) / 2;
    let before = w.balance("merchant:vex", Asset::Credits);
    w.execute(&Caller::Agent(MERCHANT.into()), &Action::PostBounty { target: VANGUARD.into(), resource: Resource::Ammo, amount }).unwrap();
    for _ in 0..=BOUNTY_TICKS {
        w.tick();
    }
    assert!(w.balance("merchant:vex", Asset::Credits) >= before - 1_000, "refunded (allowing for restock costs)");
    assert!(w.bounties.values().any(|b| b.status == BountyStatus::Expired));
    assert_conserved(&w);
}

#[test]
fn bounties_outside_the_allowed_range_are_rejected() {
    let mut w = genesis(1);
    let plan = raid_plan(&w, VANGUARD, Resource::Ammo).unwrap();
    let value = plan.manifest * pricing::production_cost(Resource::Ammo);
    for amount in [value / 4 - 1, value * 3 / 2 + 1] {
        let r = w.execute(&Caller::Agent(MERCHANT.into()), &Action::PostBounty { target: VANGUARD.into(), resource: Resource::Ammo, amount });
        assert!(matches!(r, Err(EconError::BountyOutOfRange { .. })), "{amount}");
    }
}

// ── authorization ─────────────────────────────────────────────────────────────

#[test]
fn every_caller_is_limited_to_its_own_powers() {
    let mut w = genesis(1);
    let id = raid(&mut w, PLAYER, Resource::Ammo);
    let before = w.clone();
    let vg = Caller::Agent(VANGUARD.into());
    let vex = Caller::Agent(MERCHANT.into());
    let player = Caller::Player(PLAYER.into());
    let denied = [
        (&vg, Action::SetStrategy { strategy: Strategy { margin_bp: 0, spread_bp: 500 } }), // only the merchant sets prices
        (&vg, Action::SettleRaid { raid: id, player: PLAYER.into() }),                       // only the server settles
        (&vg, Action::StartRaid { target: VANGUARD.into(), resource: Resource::Fuel }),      // agents don't raid
        (&vex, Action::Trade { resource: Resource::Fuel, side: Side::Buy, qty: 1, limit_total: 99 }), // the market can't trade with itself
        (&vex, Action::ConfigureDefense { level: 3 }),
        (&player, Action::PostBounty { target: VANGUARD.into(), resource: Resource::Ammo, amount: 100 }),
        (&player, Action::ConfigureDefense { level: 5 }),
        (&player, Action::SettleRaid { raid: id, player: PLAYER.into() }),                   // nor settle their own raid
        (&Caller::System, Action::Trade { resource: Resource::Ammo, side: Side::Buy, qty: 1, limit_total: 99 }),
    ];
    for (caller, action) in denied {
        assert!(matches!(w.execute(caller, &action), Err(EconError::Unauthorized { .. })), "{caller:?} {action:?}");
    }
    assert_eq!(w, before);
}

#[test]
fn a_faction_cannot_sponsor_a_raid_on_itself() {
    let mut w = genesis(1);
    let r = w.execute(&Caller::Agent(VANGUARD.into()), &Action::PostBounty { target: VANGUARD.into(), resource: Resource::Ammo, amount: 300 });
    assert_eq!(r, Err(EconError::SelfTarget));
}

#[test]
fn defense_is_bounded_and_paid_for_at_dispatch() {
    let mut w = genesis(1);
    let vg = Caller::Agent(VANGUARD.into());
    assert_eq!(w.execute(&vg, &Action::ConfigureDefense { level: 0 }), Err(EconError::BadDefense));
    assert_eq!(w.execute(&vg, &Action::ConfigureDefense { level: 6 }), Err(EconError::BadDefense));
    w.execute(&vg, &Action::ConfigureDefense { level: 4 }).unwrap();
    let ev = w.tick();
    assert!(ev.iter().any(|e| matches!(e, Event::Transfer(l) if matches!(l.transfer.reason, Reason::EscortWages { .. }) && l.transfer.qty == DEFENSE_COST[4])));
    assert!(ev.iter().any(|e| matches!(e, Event::Transfer(l) if matches!(l.transfer.reason, Reason::Logistics { .. }) && l.transfer.qty == LOGISTICS_FUEL)));
}

#[test]
fn the_world_round_trips_through_json() {
    // The API snapshots the whole world as JSON; it must come back identical.
    let mut w = genesis(5);
    for _ in 0..30 {
        w.tick();
        run_fallback_agents(&mut w);
    }
    raid(&mut w, PLAYER, Resource::Ammo);
    let json = serde_json::to_string(&w).expect("serializes");
    let back: World = serde_json::from_str(&json).expect("deserializes");
    assert_eq!(back, w);
}
