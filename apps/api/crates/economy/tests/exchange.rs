//! Player trading with the merchant: firm quotes held in escrow, settled when the
//! player accepts (on NEAR, by signing) or released when they lapse; and the OUTSIDE
//! boundary that keeps player balances equal to what the player owns on chain.

use cz_economy::*;

const P: &str = "player.contract-zero.testnet";
const VEX: &str = "merchant:vex";
const VG: &str = "faction:vanguard";
const AMMO: Asset = Asset::Res(Resource::Ammo);

fn assert_conserved(w: &World) {
    for asset in [Asset::Credits, AMMO, Asset::Res(Resource::Med), Asset::Res(Resource::Fuel)] {
        assert_eq!(w.total(asset), 0, "{asset:?} not conserved");
        assert_eq!(w.balance(WORLD, asset), w.destroyed(asset) - w.issued(asset), "{asset:?}: a quote or sync counted as issuance");
        for (acct, m) in &w.balances {
            if acct != WORLD && acct != OUTSIDE {
                assert!(m.get(&asset).copied().unwrap_or(0) >= 0, "{acct} negative in {asset:?}");
            }
        }
    }
}

fn world_with_player(credits: i64, ammo: i64) -> World {
    let mut w = acceptance();
    let acct = player_account(P);
    if credits > 0 {
        w.grant(&acct, Asset::Credits, credits);
    }
    if ammo > 0 {
        w.grant(&acct, AMMO, ammo);
    }
    w
}

#[test]
fn a_purchase_quote_holds_the_goods_then_settles_as_a_trade() {
    let mut w = world_with_player(1_000, 0);
    let q = w.reserve_quote(P, Resource::Ammo, Side::Buy, 10, 1_000).unwrap();
    // The goods are held: the merchant can't sell them to anyone else meanwhile.
    assert_eq!(w.balance(VEX, AMMO), 90);
    assert_eq!(w.balance(&q.escrow(), AMMO), 10);
    assert_eq!(w.held_for_quotes(AMMO), 10);
    let vex_credits = w.balance(VEX, Asset::Credits);
    w.settle_quote(q.id).unwrap();
    assert_eq!(w.balance(&player_account(P), AMMO), 10);
    assert_eq!(w.balance(&player_account(P), Asset::Credits), 1_000 - q.total);
    assert_eq!(w.balance(VEX, Asset::Credits), vex_credits + q.total);
    assert_eq!(w.held_for_quotes(AMMO), 0);
    assert!(matches!(w.quotes[&q.id].status, QuoteStatus::Settled { .. }));
    let t = w.trades.last().unwrap();
    assert_eq!((t.party.as_str(), t.side, t.qty, t.total), (player_account(P).as_str(), Side::Buy, 10, q.total));
    assert_conserved(&w);
}

#[test]
fn a_sale_quote_holds_the_merchants_credits() {
    let mut w = world_with_player(0, 30);
    let credits = w.balance(VEX, Asset::Credits);
    let q = w.reserve_quote(P, Resource::Ammo, Side::Sell, 30, 0).unwrap();
    assert!(q.total > 0);
    assert_eq!(w.balance(VEX, Asset::Credits), credits - q.total);
    w.settle_quote(q.id).unwrap();
    assert_eq!(w.balance(&player_account(P), Asset::Credits), q.total);
    assert_eq!(w.balance(&player_account(P), AMMO), 0);
    assert_eq!(w.balance(VEX, AMMO), 130);
    assert_conserved(&w);
}

#[test]
fn a_lapsed_quote_returns_the_hold() {
    let mut w = world_with_player(1_000, 0);
    let before = w.balances.clone();
    let q = w.reserve_quote(P, Resource::Ammo, Side::Buy, 10, 1_000).unwrap();
    w.release_quote(q.id).unwrap();
    assert_eq!(w.balance(VEX, AMMO), before[VEX][&AMMO]);
    assert_eq!(w.quotes[&q.id].status, QuoteStatus::Released);
    assert_eq!(w.settle_quote(q.id), Err(EconError::QuoteNotOpen { quote: q.id }));
    assert_eq!(w.release_quote(q.id).unwrap_err(), EconError::QuoteNotOpen { quote: q.id });
    assert_conserved(&w);
}

#[test]
fn a_quote_settles_at_most_once() {
    let mut w = world_with_player(1_000, 0);
    let q = w.reserve_quote(P, Resource::Ammo, Side::Buy, 5, 1_000).unwrap();
    w.settle_quote(q.id).unwrap();
    assert_eq!(w.settle_quote(q.id), Err(EconError::QuoteNotOpen { quote: q.id }));
    assert_eq!(w.release_quote(q.id), Err(EconError::QuoteNotOpen { quote: q.id }));
}

#[test]
fn one_open_quote_per_player() {
    let mut w = world_with_player(1_000, 0);
    w.reserve_quote(P, Resource::Ammo, Side::Buy, 5, 1_000).unwrap();
    assert_eq!(w.reserve_quote(P, Resource::Med, Side::Buy, 1, 1_000), Err(EconError::QuoteOpen));
}

#[test]
fn a_quote_needs_the_means_and_the_stock_and_respects_the_limit() {
    let mut w = world_with_player(50, 0);
    assert!(matches!(w.reserve_quote(P, Resource::Ammo, Side::Buy, 10, 10_000), Err(EconError::Insufficient { .. })));
    assert!(matches!(w.reserve_quote(P, Resource::Ammo, Side::Sell, 1, 0), Err(EconError::Insufficient { .. })));
    assert!(matches!(w.reserve_quote(P, Resource::Ammo, Side::Buy, 500, 1_000_000), Err(EconError::MerchantShort { .. })));
    assert!(matches!(w.reserve_quote(P, Resource::Ammo, Side::Buy, 1, 1), Err(EconError::PriceMoved { .. })));
    // Nothing was held by the failed attempts.
    assert_eq!(w.balance(VEX, AMMO), 100);
    assert!(w.quotes.is_empty());
}

#[test]
fn held_goods_are_out_of_reach_of_the_agents() {
    let mut w = world_with_player(10_000, 0);
    w.reserve_quote(P, Resource::Ammo, Side::Buy, 100, 10_000).unwrap();
    let r = w.execute(&Caller::Agent(VANGUARD.into()), &Action::Trade { resource: Resource::Ammo, side: Side::Buy, qty: 1, limit_total: 1_000 });
    assert!(matches!(r, Err(EconError::MerchantShort { stock: 0, .. })), "{r:?}");
}

#[test]
fn player_purchases_move_the_market_like_any_other_demand() {
    let mut w = world_with_player(10_000, 0);
    let unit = w.price(Resource::Ammo).ask;
    let q = w.reserve_quote(P, Resource::Ammo, Side::Buy, 40, 10_000).unwrap();
    w.settle_quote(q.id).unwrap();
    assert!(w.price(Resource::Ammo).ask > unit, "scarcer stock and higher demand must raise the price");
}

#[test]
fn chain_resync_crosses_the_boundary_without_issuing_anything() {
    let mut w = world_with_player(100, 0);
    let issued = w.issued(Asset::Credits);
    // The player received 400 credits from another wallet on NEAR…
    let ev = w.sync_holding(P, Asset::Credits, 500).unwrap();
    assert!(matches!(ev.last(), Some(Event::HoldingSynced { from: 100, to: 500, .. })));
    assert_eq!(w.balance(&player_account(P), Asset::Credits), 500);
    assert_eq!(w.balance(OUTSIDE, Asset::Credits), -400);
    // …then sent 450 away.
    w.sync_holding(P, Asset::Credits, 50).unwrap();
    assert_eq!(w.balance(OUTSIDE, Asset::Credits), 50);
    assert_eq!(w.issued(Asset::Credits), issued);
    assert!(w.sync_holding(P, Asset::Credits, 50).unwrap().is_empty());
    assert_conserved(&w);
}

#[test]
fn quotes_survive_a_snapshot_round_trip() {
    let mut w = world_with_player(1_000, 0);
    w.reserve_quote(P, Resource::Ammo, Side::Buy, 10, 1_000).unwrap();
    let back: World = serde_json::from_str(&serde_json::to_string(&w).unwrap()).unwrap();
    assert_eq!(back, w);
    // Snapshots written before quotes existed still load.
    let mut v = serde_json::to_value(acceptance()).unwrap();
    v.as_object_mut().unwrap().remove("quotes");
    let old: World = serde_json::from_value(v).unwrap();
    assert!(old.quotes.is_empty());
    let _ = VG;
}
