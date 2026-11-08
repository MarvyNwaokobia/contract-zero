//! Owned gear and standing: guns are assets the merchant's armory stocks and sells
//! through the same firm quotes as resources; how the region regards a player is
//! computed from what that player actually did, and the merchant's regard is money.

use cz_economy::*;

const P: &str = "gunner.testnet";
const VEX: &str = "merchant:vex";
const MARKSMAN: Asset = Asset::Gear(Gear::Marksman);

fn conserved(w: &World) {
    for a in ALL_ASSETS {
        assert_eq!(w.total(a), 0, "{a:?}");
        assert_eq!(w.balance(WORLD, a), w.destroyed(a) - w.issued(a), "{a:?} classification drift");
    }
}

fn stocked() -> World {
    let mut w = genesis(11);
    for _ in 0..TICKS_PER_DAY {
        w.tick();
    }
    w
}

#[test]
fn gear_is_an_asset_with_a_token_id() {
    for g in Gear::ALL {
        let a = Asset::Gear(g);
        assert_eq!(Asset::parse(a.name()), Some(a));
        assert!(a.name().starts_with("gun:"));
        assert_eq!(serde_json::to_string(&a).unwrap(), format!("\"{}\"", g.token()));
        assert_eq!(Gear::parse(g.id()), Some(g));
    }
    assert_eq!(Asset::parse("gun:nonsense"), None);
    assert_eq!(Asset::parse("marksman"), None, "only the token id names the asset");
}

#[test]
fn the_armory_stocks_on_consignment_and_pays_its_supplier_on_sale() {
    let w0 = genesis(11);
    assert_eq!(w0.balance(VEX, MARKSMAN), 0);
    let mut w = stocked();
    for g in Gear::ALL {
        assert_eq!(w.balance(VEX, Asset::Gear(g)), ARMORY_STOCK, "{g:?}");
    }
    assert!(!w.ledger.iter().any(|e| e.transfer.reason == Reason::ArmoryCost), "nothing paid until something sells");
    w.grant(&player_account(P), Asset::Credits, 3_000);
    let vex_before = w.balance(VEX, Asset::Credits);
    let q = w.reserve_gear_quote(P, Gear::SeraphLmg, 10_000).unwrap();
    w.settle_quote(q.id).unwrap();
    let cost = Gear::SeraphLmg.list_price() * ARMORY_COST_BP / 10_000;
    assert_eq!(w.balance(VEX, Asset::Credits), vex_before + q.total - cost, "Vex keeps its margin");
    // And the sold gun is replaced at the next review.
    for _ in 0..MERCHANT_RESTOCK_TICKS {
        w.tick();
    }
    assert_eq!(w.balance(VEX, Asset::Gear(Gear::SeraphLmg)), ARMORY_STOCK);
    conserved(&w);
}

#[test]
fn a_gun_is_bought_through_a_firm_quote_and_never_moves_resource_prices() {
    let mut w = stocked();
    w.grant(&player_account(P), Asset::Credits, 2_000);
    let price_before = w.price(Resource::Ammo);
    let q = w.reserve_gear_quote(P, Gear::Marksman, 10_000).unwrap();
    assert_eq!(q.total, 800);
    assert_eq!(q.goods(), MARKSMAN);
    assert_eq!(w.balance(VEX, MARKSMAN), ARMORY_STOCK - 1, "held in escrow");
    assert_eq!(w.reserve_gear_quote(P, Gear::SeraphLmg, 10_000), Err(EconError::QuoteOpen));
    w.settle_quote(q.id).unwrap();
    assert!(w.owns(P, Gear::Marksman));
    assert_eq!(w.balance(&player_account(P), Asset::Credits), 1_200);
    assert_eq!(w.trades.last().unwrap().gear, Some(Gear::Marksman));
    assert_eq!(w.price(Resource::Ammo), price_before, "a gun sale is not ammunition demand");
    conserved(&w);
}

#[test]
fn guns_are_refused_without_stock_money_or_within_the_limit() {
    let mut w = genesis(11);
    w.grant(&player_account(P), Asset::Credits, 5_000);
    assert!(matches!(w.reserve_gear_quote(P, Gear::Marksman, 10_000), Err(EconError::MerchantShort { .. })), "nothing in the armory yet");
    let mut w = stocked();
    assert!(matches!(w.reserve_gear_quote(P, Gear::Marksman, 10_000), Err(EconError::Insufficient { .. })));
    w.grant(&player_account(P), Asset::Credits, 5_000);
    assert!(matches!(w.reserve_gear_quote(P, Gear::SeraphLmg, 2_000), Err(EconError::PriceMoved { .. })));
}

#[test]
fn trading_with_vex_earns_a_better_price() {
    let mut w = stocked();
    w.grant(&player_account(P), Asset::Credits, 20_000);
    assert_eq!(w.standing(P).vex_tier, "Unknown");
    let first = w.reserve_quote(P, Resource::Med, Side::Buy, 5, i64::MAX).unwrap();
    w.settle_quote(first.id).unwrap();
    // Enough business to become known.
    while w.standing(P).vex_score < VEX_TIERS[0].0 {
        let q = w.reserve_quote(P, Resource::Med, Side::Buy, 5, i64::MAX).unwrap();
        w.settle_quote(q.id).unwrap();
    }
    let s = w.standing(P);
    assert_eq!(s.vex_tier, "Known");
    assert_eq!(s.vex_discount_bp, 300);
    let list = w.quote(Resource::Ammo, Side::Buy, 10).unwrap().total;
    let q = w.reserve_quote(P, Resource::Ammo, Side::Buy, 10, i64::MAX).unwrap();
    assert_eq!(q.total, list * 9_700 / 10_000, "3% off");
    assert_eq!(w.gear_price(P, Gear::Marksman), 776);
    conserved(&w);
}

#[test]
fn factions_judge_a_player_by_jobs_done_for_them_and_operations_against_them() {
    let mut w = genesis(11);
    add_rival(&mut w);
    let s = w.standing(P);
    assert!(s.factions.iter().all(|f| f.tier == "Neutral"));
    // Ashen pays for a raid on Vanguard; the player takes it.
    let ashen = w.actors[ASHEN].clone();
    let plan = mission::raid_plan(&w, VANGUARD, Resource::Fuel).unwrap();
    let amount = plan.manifest * pricing::production_cost(Resource::Fuel) * 3_000 / 10_000;
    let _ = w.execute(&Caller::Agent(ashen.id.clone()), &Action::PostBounty { target: VANGUARD.into(), resource: Resource::Fuel, amount });
    w.execute(&Caller::Player(P.into()), &Action::StartRaid { target: VANGUARD.into(), resource: Resource::Fuel }).unwrap();
    let id = *w.raids.keys().last().unwrap();
    w.execute(&Caller::System, &Action::SettleRaid { raid: id, player: P.into() }).unwrap();
    let s = w.standing(P);
    let by = |id: &str| s.factions.iter().find(|f| f.actor == id).unwrap().clone();
    assert_eq!(by(VANGUARD).operations_against, 1);
    assert_eq!(by(VANGUARD).tier, "Wary");
    if by(ASHEN).jobs_for == 1 {
        assert_eq!(by(ASHEN).tier, "Favoured");
        assert!(by(ASHEN).earned_from > 0);
    }
    conserved(&w);
}
