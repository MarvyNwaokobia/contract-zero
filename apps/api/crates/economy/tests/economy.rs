use cz_economy::policy::run_fallback_agents;
use cz_economy::*;

const PLAYER: &str = "raider.testnet";

fn ironveil_convoy(w: &World) -> u64 {
    w.convoys.values().find(|c| c.owner == IRONVEIL && c.status == ConvoyStatus::InTransit).expect("an ironveil convoy in transit").id
}

/// Genesis, one tick (Ironveil's first fuel convoy leaves), and a Vex contract on it.
fn world_with_contract() -> (World, u64, u64) {
    let mut w = genesis(7);
    w.tick();
    let convoy = ironveil_convoy(&w);
    let (min, _) = w.bounty_range(&w.convoys[&convoy]);
    w.execute(&Caller::Agent(VEX.into()), &Action::PostContract { convoy, bounty: min }).unwrap();
    let contract = *w.contracts.keys().last().unwrap();
    (w, convoy, contract)
}

fn fund_player(w: &mut World, credits: i64) {
    w.apply(&[Transfer { from: WORLD.into(), to: player_account(PLAYER), asset: Asset::Credits, qty: credits, reason: Reason::Income }]).unwrap();
}

fn assert_conserved(w: &World) {
    for asset in [Asset::Credits, Asset::Res(Resource::Ammo), Asset::Res(Resource::Med), Asset::Res(Resource::Fuel)] {
        assert_eq!(w.total(asset), 0, "{asset:?} not conserved at tick {}", w.tick);
    }
    for (acct, m) in &w.balances {
        if acct != WORLD {
            for (asset, v) in m {
                assert!(*v >= 0, "{acct} holds {v} {asset:?}");
            }
        }
    }
}

// ── conservation ──────────────────────────────────────────────────────────────

#[test]
fn a_week_of_agents_and_raids_conserves_every_asset() {
    let mut w = genesis(42);
    let mut rng = 0xC0FFEEu64;
    for t in 0..(7 * TICKS_PER_DAY) {
        w.tick();
        if t % 6 == 0 {
            run_fallback_agents(&mut w);
        }
        // Simulated raiders take some open contracts.
        for id in w.open_contracts().map(|c| c.id).collect::<Vec<_>>() {
            rng = splitmix(rng);
            if rng % 3 == 0 {
                let p = Caller::Player(PLAYER.into());
                w.execute(&p, &Action::AcceptContract { contract: id }).unwrap();
                w.execute(&Caller::System, &Action::SettleRaid { contract: id, player: PLAYER.into() }).unwrap();
            }
        }
        assert_conserved(&w);
    }
    assert!(w.convoys.values().any(|c| c.status == ConvoyStatus::Raided), "the week should include raids");
    assert!(w.convoys.values().any(|c| c.status == ConvoyStatus::Arrived), "and convoys that got through");
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
        Transfer { from: "merchant:vex".into(), to: "faction:ironveil".into(), asset: Asset::Credits, qty: 10, reason: Reason::Income },
        Transfer { from: "faction:ironveil".into(), to: "merchant:vex".into(), asset: Asset::Res(Resource::Fuel), qty: 1_000_000, reason: Reason::Income },
    ]);
    assert!(matches!(err, Err(EconError::Insufficient { .. })));
    assert_eq!(w, before);
}

#[test]
fn consumption_never_drives_a_balance_negative_it_records_a_shortage() {
    let mut w = genesis(1);
    w.actors.get_mut(IRONVEIL).unwrap().convoy = None; // no resupply
    let mut shortages = 0;
    for _ in 0..(5 * TICKS_PER_DAY) {
        shortages += w.tick().iter().filter(|e| matches!(e, Event::Shortage { resource: Resource::Fuel, .. })).count();
    }
    assert_eq!(w.balance("faction:ironveil", Asset::Res(Resource::Fuel)), 0);
    assert!(shortages > 0);
    assert_conserved(&w);
}

// ── trading ───────────────────────────────────────────────────────────────────

#[test]
fn a_buy_moves_credits_and_units_at_the_quoted_total() {
    let mut w = genesis(1);
    fund_player(&mut w, 10_000);
    let q = w.quote(Resource::Med, Side::Buy, 5).unwrap();
    let stock = w.merchant_stock(Resource::Med);
    w.execute(&Caller::Player(PLAYER.into()), &Action::Trade { resource: Resource::Med, side: Side::Buy, qty: 5, limit_total: q.total }).unwrap();
    assert_eq!(w.balance(&player_account(PLAYER), Asset::Credits), 10_000 - q.total);
    assert_eq!(w.balance(&player_account(PLAYER), Asset::Res(Resource::Med)), 5);
    assert_eq!(w.merchant_stock(Resource::Med), stock - 5);
    assert!(w.price(Resource::Med).mid >= q.unit_now.mid, "buying from the shelf must not lower the price");
}

#[test]
fn buying_more_than_the_merchant_holds_is_rejected() {
    let mut w = genesis(1);
    fund_player(&mut w, 1_000_000);
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
    // Two buyers read the same quote; the first fill moves the curve, so the second's
    // limit no longer covers the new total and it is rejected instead of filling.
    let mut w = genesis(1);
    fund_player(&mut w, 100_000);
    w.apply(&[Transfer { from: WORLD.into(), to: player_account("other.testnet"), asset: Asset::Credits, qty: 100_000, reason: Reason::Income }]).unwrap();
    let q = w.quote(Resource::Fuel, Side::Buy, 25).unwrap();
    let order = Action::Trade { resource: Resource::Fuel, side: Side::Buy, qty: 25, limit_total: q.total };
    w.execute(&Caller::Player(PLAYER.into()), &order).unwrap();
    let before = w.clone();
    let second = w.execute(&Caller::Player("other.testnet".into()), &order);
    assert!(matches!(second, Err(EconError::PriceMoved { total, limit }) if total > limit));
    assert_eq!(w, before);
}

// ── contracts and settlement ──────────────────────────────────────────────────

#[test]
fn posting_a_contract_escrows_the_bounty() {
    let (w, _, contract) = world_with_contract();
    let c = &w.contracts[&contract];
    assert_eq!(w.balance(&c.escrow(), Asset::Credits), c.bounty);
    assert_eq!(c.status, ContractStatus::Open);
}

#[test]
fn a_raid_pays_the_player_and_delivers_the_cargo_to_the_issuer() {
    let (mut w, convoy, contract) = world_with_contract();
    let units = w.convoys[&convoy].units;
    let bounty = w.contracts[&contract].bounty;
    let vex_fuel = w.merchant_stock(Resource::Fuel);
    w.execute(&Caller::Player(PLAYER.into()), &Action::AcceptContract { contract }).unwrap();
    w.execute(&Caller::System, &Action::SettleRaid { contract, player: PLAYER.into() }).unwrap();
    assert_eq!(w.balance(&player_account(PLAYER), Asset::Credits), bounty);
    assert_eq!(w.merchant_stock(Resource::Fuel), vex_fuel + units);
    assert_eq!(w.convoys[&convoy].status, ConvoyStatus::Raided);
    // The raided convoy never arrives: Ironveil does not get that fuel.
    let iv_before = w.balance("faction:ironveil", Asset::Res(Resource::Fuel));
    for _ in 0..10 {
        w.tick();
    }
    assert!(w.balance("faction:ironveil", Asset::Res(Resource::Fuel)) < iv_before + units);
    assert_conserved(&w);
}

#[test]
fn a_replayed_settlement_is_rejected_and_pays_nothing() {
    let (mut w, _, contract) = world_with_contract();
    w.execute(&Caller::Player(PLAYER.into()), &Action::AcceptContract { contract }).unwrap();
    let settle = Action::SettleRaid { contract, player: PLAYER.into() };
    w.execute(&Caller::System, &settle).unwrap();
    let after_first = w.clone();
    assert_eq!(w.execute(&Caller::System, &settle), Err(EconError::AlreadySettled { contract }));
    assert_eq!(w, after_first);
}

#[test]
fn a_contract_can_only_be_held_by_one_player_at_a_time() {
    let (mut w, _, contract) = world_with_contract();
    w.execute(&Caller::Player(PLAYER.into()), &Action::AcceptContract { contract }).unwrap();
    let r = w.execute(&Caller::Player("other.testnet".into()), &Action::AcceptContract { contract });
    assert!(matches!(r, Err(EconError::ContractState { .. })));
    // …and the other player cannot settle it either.
    let r = w.execute(&Caller::System, &Action::SettleRaid { contract, player: "other.testnet".into() });
    assert!(matches!(r, Err(EconError::ContractState { .. })));
}

#[test]
fn a_failed_raid_returns_the_contract_to_the_board() {
    let (mut w, _, contract) = world_with_contract();
    let p = Caller::Player(PLAYER.into());
    w.execute(&p, &Action::AcceptContract { contract }).unwrap();
    w.execute(&p, &Action::AbandonContract { contract }).unwrap();
    assert_eq!(w.contracts[&contract].status, ContractStatus::Open);
    assert_eq!(w.balance(&player_account(PLAYER), Asset::Credits), 0);
}

#[test]
fn an_unraided_convoy_arrives_and_its_bounty_is_refunded() {
    let (mut w, convoy, contract) = world_with_contract();
    let bounty = w.contracts[&contract].bounty;
    let vex_credits = w.balance("merchant:vex", Asset::Credits);
    while w.convoys[&convoy].status == ConvoyStatus::InTransit {
        w.tick();
    }
    assert_eq!(w.convoys[&convoy].status, ConvoyStatus::Arrived);
    assert_eq!(w.contracts[&contract].status, ContractStatus::Expired);
    assert!(w.balance("merchant:vex", Asset::Credits) >= vex_credits + bounty - DEFENSE_COST[DEFENSE_MAX as usize] - 1_000);
    assert_eq!(w.balance(&w.contracts[&contract].escrow(), Asset::Credits), 0);
    // Too late to settle now.
    let r = w.execute(&Caller::Player(PLAYER.into()), &Action::AcceptContract { contract });
    assert!(matches!(r, Err(EconError::ContractState { .. })));
}

#[test]
fn bounties_outside_the_allowed_range_are_rejected() {
    let mut w = genesis(1);
    w.tick();
    let convoy = ironveil_convoy(&w);
    let (min, max) = w.bounty_range(&w.convoys[&convoy]);
    for bounty in [min - 1, max + 1] {
        let r = w.execute(&Caller::Agent(VEX.into()), &Action::PostContract { convoy, bounty });
        assert!(matches!(r, Err(EconError::BountyOutOfRange { .. })), "{bounty}");
    }
}

#[test]
fn a_convoy_carries_at_most_one_live_contract() {
    let (mut w, convoy, _) = world_with_contract();
    let (min, _) = w.bounty_range(&w.convoys[&convoy]);
    let r = w.execute(&Caller::Agent(VEX.into()), &Action::PostContract { convoy, bounty: min });
    assert_eq!(r, Err(EconError::ConvoyAlreadyContracted { convoy }));
}

// ── authorization ─────────────────────────────────────────────────────────────

#[test]
fn every_caller_is_limited_to_its_own_powers() {
    let (mut w, convoy, contract) = world_with_contract();
    let before = w.clone();
    let iron = Caller::Agent(IRONVEIL.into());
    let vex = Caller::Agent(VEX.into());
    let player = Caller::Player(PLAYER.into());
    let denied = [
        (&iron, Action::SetStrategy { strategy: Strategy { margin_bp: 0, spread_bp: 500 } }), // only the merchant sets prices
        (&iron, Action::SettleRaid { contract, player: PLAYER.into() }),                       // only the server settles
        (&iron, Action::AcceptContract { contract }),                                          // agents don't take contracts
        (&vex, Action::Trade { resource: Resource::Fuel, side: Side::Buy, qty: 1, limit_total: 99 }), // the market can't trade with itself
        (&player, Action::PostContract { convoy, bounty: 100 }),                               // players don't post bounties
        (&player, Action::ConfigureDefense { level: 5 }),
        (&player, Action::SettleRaid { contract, player: PLAYER.into() }),                     // nor settle their own raids
        (&Caller::System, Action::Trade { resource: Resource::Ammo, side: Side::Buy, qty: 1, limit_total: 99 }),
    ];
    for (caller, action) in denied {
        assert!(matches!(w.execute(caller, &action), Err(EconError::Unauthorized { .. })), "{caller:?} {action:?}");
    }
    assert_eq!(w, before);
}

#[test]
fn an_agent_cannot_post_against_its_own_convoy() {
    let mut w = genesis(1);
    w.tick();
    let convoy = ironveil_convoy(&w);
    let (min, _) = w.bounty_range(&w.convoys[&convoy]);
    assert_eq!(w.execute(&Caller::Agent(IRONVEIL.into()), &Action::PostContract { convoy, bounty: min }), Err(EconError::OwnConvoy));
}

#[test]
fn defense_is_bounded_and_paid_for_at_dispatch() {
    let mut w = genesis(1);
    let iron = Caller::Agent(IRONVEIL.into());
    assert_eq!(w.execute(&iron, &Action::ConfigureDefense { level: 0 }), Err(EconError::BadDefense));
    assert_eq!(w.execute(&iron, &Action::ConfigureDefense { level: 6 }), Err(EconError::BadDefense));
    w.execute(&iron, &Action::ConfigureDefense { level: 4 }).unwrap();
    let ev = w.tick();
    assert!(ev.iter().any(|e| matches!(e, Event::Transfer(l) if l.transfer.reason == Reason::EscortWages { convoy: ironveil_convoy(&w) } && l.transfer.qty == DEFENSE_COST[4])));
    assert_eq!(w.convoys[&ironveil_convoy(&w)].defense, 4);
}

// ── the loop the game is built on ─────────────────────────────────────────────

#[test]
fn a_raid_makes_the_commander_replan() {
    let (mut w, _, contract) = world_with_contract();
    w.execute(&Caller::Player(PLAYER.into()), &Action::AcceptContract { contract }).unwrap();
    w.execute(&Caller::System, &Action::SettleRaid { contract, player: PLAYER.into() }).unwrap();
    let plan = policy::commander(&w, IRONVEIL);
    assert!(plan.contains(&Action::ConfigureDefense { level: policy::BASE_DEFENSE + 1 }), "raided → tighter escorts: {plan:?}");
    // The next convoy goes out better guarded, so the next mission is harder.
    run_fallback_agents(&mut w);
    while !w.convoys.values().any(|c| c.owner == IRONVEIL && c.status == ConvoyStatus::InTransit && c.defense > policy::BASE_DEFENSE) {
        w.tick();
    }
}
