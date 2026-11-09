//! Supply orders and competing merchants: the engine half of the intent market.

use cz_economy::policy::{self, commander_choices, merchant_proposals};
use cz_economy::*;

const VG: &str = "faction:vanguard";
const VEX_ACC: &str = "merchant:vex";
const HAL_ACC: &str = "merchant:halcyon";
const PLAYER: &str = "trader.testnet";

fn world() -> World {
    let mut w = genesis(3);
    w.market.living = false; // nothing moves unless the test acts
    // Vanguard has just lost most of its ammunition (a raid): it is genuinely short.
    let have = w.balance(VG, Asset::Res(Resource::Ammo));
    w.apply(&[Transfer { from: VG.into(), to: WORLD.into(), asset: Asset::Res(Resource::Ammo), qty: have - 20, reason: Reason::Consumption }]).unwrap();
    w
}

fn conserved(w: &World) {
    for a in [Asset::Credits, Asset::Res(Resource::Ammo), Asset::Res(Resource::Med), Asset::Res(Resource::Fuel)] {
        assert_eq!(w.total(a), 0, "{a:?} not conserved");
    }
}

fn as_vg(w: &mut World, a: Action) -> Result<Vec<Event>, EconError> {
    w.execute(&Caller::Agent(VANGUARD.into()), &a)
}

fn buy(qty: i64, limit: i64, partial: bool, nonce: u64, urgency: u8) -> Action {
    Action::PlaceOrder { side: Side::Buy, resource: Resource::Ammo, qty, limit_total: limit, allow_partial: partial, ttl_ticks: 6, nonce, urgency, purpose: "test".into(), chain_id: None }
}

fn last_order(w: &World) -> u64 {
    *w.orders.keys().last().unwrap()
}

fn propose(w: &mut World, merchant: &str, order: u64, qty: i64, total: i64) -> Result<Vec<Event>, EconError> {
    w.execute(&Caller::Agent(merchant.into()), &Action::Propose { order, qty, total, note: String::new() })
}

fn last_proposal(w: &World) -> u64 {
    *w.proposals.keys().last().unwrap()
}

#[test]
fn both_merchants_answer_and_the_routine_order_goes_to_the_cheaper_one() {
    let mut w = world();
    as_vg(&mut w, buy(30, 30 * 24, true, 1, 1)).unwrap();
    let o = last_order(&w);
    for m in w.merchant_ids() {
        for d in merchant_proposals(&w, &m) {
            if let Some(a) = &d.action {
                w.execute(&Caller::Agent(m.clone()), a).unwrap();
            }
        }
    }
    let props: Vec<Proposal> = w.pending_proposals(o).cloned().collect();
    assert_eq!(props.len(), 2, "both merchants answered: {props:?}");
    let cheapest = props.iter().min_by(|a, b| (a.total as i128 * b.qty as i128).cmp(&(b.total as i128 * a.qty as i128))).unwrap().clone();
    let choice = commander_choices(&w, VANGUARD);
    let Some(Action::AcceptProposal { proposal, .. }) = choice[0].action.clone() else { panic!("{choice:?}") };
    assert_eq!(proposal, cheapest.id, "routine: the cheapest per unit wins, whoever it is");
    assert!(choice[0].rationale.contains("On the table"), "the choice records the field: {}", choice[0].rationale);
    conserved(&w);
}

#[test]
fn an_urgent_order_prefers_coverage_over_price() {
    let mut w = world();
    as_vg(&mut w, buy(70, 70 * 48, true, 1, 3)).unwrap();
    let o = last_order(&w);
    // A small cheap lot and a big dearer one.
    propose(&mut w, HALCYON, o, 20, 20 * 15).unwrap();
    propose(&mut w, MERCHANT, o, 70, 70 * 20).unwrap();
    let c = commander_choices(&w, VANGUARD);
    let Some(Action::AcceptProposal { proposal, .. }) = c[0].action.clone() else { panic!() };
    assert_eq!(w.proposals[&proposal].merchant, MERCHANT, "{}", c[0].rationale);
}

#[test]
fn partial_fills_from_two_merchants_add_up_and_the_rest_is_refunded() {
    let mut w = world();
    let credits = w.balance(VG, Asset::Credits);
    as_vg(&mut w, buy(40, 1_000, true, 1, 1)).unwrap();
    let o = last_order(&w);
    propose(&mut w, HALCYON, o, 15, 300).unwrap();
    let p1 = last_proposal(&w);
    propose(&mut w, MERCHANT, o, 25, 600).unwrap();
    let p2 = last_proposal(&w);
    as_vg(&mut w, Action::AcceptProposal { order: o, proposal: p1 }).unwrap();
    assert_eq!(w.orders[&o].remaining(), 25);
    as_vg(&mut w, Action::AcceptProposal { order: o, proposal: p2 }).unwrap();
    let ord = &w.orders[&o];
    assert_eq!((ord.status.clone(), ord.filled, ord.settled_total), (OrderStatus::Filled, 40, 900));
    assert_eq!(w.balance(VG, Asset::Credits), credits - 900, "100 of unused budget refunded");
    assert_eq!(w.balance(&ord.escrow(), Asset::Credits), 0);
    conserved(&w);
}

#[test]
fn no_offers_means_the_order_expires_and_the_escrow_returns_exactly() {
    let mut w = world();
    let credits = w.balance(VG, Asset::Credits);
    as_vg(&mut w, buy(10, 100, false, 1, 1)).unwrap(); // 10/unit: under every merchant's floor
    let o = last_order(&w);
    for m in w.merchant_ids() {
        let d = merchant_proposals(&w, &m);
        assert!(d.iter().all(|d| d.action.is_none()), "{m} should decline: {d:?}");
        assert!(d.iter().any(|d| d.rationale.contains("floor")), "{d:?}");
    }
    for _ in 0..6 {
        w.tick();
    }
    assert_eq!(w.orders[&o].status, OrderStatus::Expired);
    assert!(w.balance(VG, Asset::Credits) >= credits, "every escrowed credit came back");
    conserved(&w);
}

#[test]
fn a_buyer_cannot_escrow_credits_it_does_not_have() {
    let mut w = world();
    let c = w.balance(VG, Asset::Credits);
    let r = as_vg(&mut w, buy(10, c + 1, false, 1, 1));
    assert!(matches!(r, Err(EconError::Insufficient { asset: Asset::Credits, .. })), "{r:?}");
    assert!(w.orders.is_empty());
}

#[test]
fn a_merchant_cannot_promise_stock_it_does_not_hold_or_promise_it_twice() {
    let mut w = world();
    let stock = w.balance(HAL_ACC, Asset::Res(Resource::Ammo));
    as_vg(&mut w, buy(stock + 10, (stock + 10) * 40, true, 1, 1)).unwrap();
    let o = last_order(&w);
    assert!(matches!(propose(&mut w, HALCYON, o, stock + 1, (stock + 1) * 30), Err(EconError::Insufficient { .. })));
    propose(&mut w, HALCYON, o, stock, stock * 30).unwrap();
    // A second order can't be offered the same crates.
    w.execute(&Caller::Agent(ASHEN.into()), &Action::PlaceOrder { side: Side::Buy, resource: Resource::Ammo, qty: 5, limit_total: 200, allow_partial: false, ttl_ticks: 6, nonce: 1, urgency: 1, purpose: String::new(), chain_id: None }).unwrap();
    let o2 = last_order(&w);
    assert!(matches!(propose(&mut w, HALCYON, o2, 5, 150), Err(EconError::Insufficient { .. })), "reserved stock is not available");
    assert_eq!(w.reserved_by(HAL_ACC, Asset::Res(Resource::Ammo)), stock);
    conserved(&w);
}

#[test]
fn a_replayed_nonce_is_refused() {
    let mut w = world();
    as_vg(&mut w, buy(5, 200, false, 7, 1)).unwrap();
    let o = last_order(&w);
    as_vg(&mut w, Action::CancelOrder { order: o }).unwrap();
    let r = as_vg(&mut w, buy(5, 200, false, 7, 1));
    assert!(matches!(r, Err(EconError::OrderRejected { .. })), "{r:?}");
    as_vg(&mut w, buy(5, 200, false, 8, 1)).unwrap();
}

#[test]
fn a_price_above_the_limit_is_refused_even_for_a_partial_lot() {
    let mut w = world();
    as_vg(&mut w, buy(40, 800, true, 1, 1)).unwrap();
    let o = last_order(&w);
    // 800 for 40 is 20/unit: 10 units may cost at most 200.
    assert!(matches!(propose(&mut w, MERCHANT, o, 10, 201), Err(EconError::PriceMoved { .. })));
    propose(&mut w, MERCHANT, o, 10, 200).unwrap();
}

#[test]
fn only_the_requester_accepts_or_cancels_and_only_merchants_propose() {
    let mut w = world();
    as_vg(&mut w, buy(10, 400, false, 1, 1)).unwrap();
    let o = last_order(&w);
    propose(&mut w, MERCHANT, o, 10, 300).unwrap();
    let p = last_proposal(&w);
    let deny = |r: Result<Vec<Event>, EconError>| assert!(matches!(r, Err(EconError::Unauthorized { .. })), "{r:?}");
    deny(w.execute(&Caller::Agent(ASHEN.into()), &Action::AcceptProposal { order: o, proposal: p }));
    deny(w.execute(&Caller::Player(PLAYER.into()), &Action::CancelOrder { order: o }));
    deny(w.execute(&Caller::Agent(ASHEN.into()), &Action::Propose { order: o, qty: 10, total: 300, note: String::new() }));
    deny(w.execute(&Caller::Agent(MERCHANT.into()), &Action::PlaceOrder { side: Side::Buy, resource: Resource::Med, qty: 1, limit_total: 50, allow_partial: false, ttl_ticks: 6, nonce: 1, urgency: 0, purpose: String::new(), chain_id: None }));
    deny(w.execute(&Caller::System, &Action::AcceptProposal { order: o, proposal: p }));
}

#[test]
fn a_cancelled_order_cannot_then_be_filled_and_a_fill_cannot_repeat() {
    let mut w = world();
    as_vg(&mut w, buy(10, 400, false, 1, 1)).unwrap();
    let o = last_order(&w);
    propose(&mut w, MERCHANT, o, 10, 300).unwrap();
    let p = last_proposal(&w);
    let stock = w.balance(VEX_ACC, Asset::Res(Resource::Ammo));
    as_vg(&mut w, Action::CancelOrder { order: o }).unwrap();
    assert_eq!(w.balance(VEX_ACC, Asset::Res(Resource::Ammo)), stock + 10, "the losing reservation was released");
    assert!(as_vg(&mut w, Action::AcceptProposal { order: o, proposal: p }).is_err());
    // And a filled order can't be filled again.
    as_vg(&mut w, buy(10, 400, false, 2, 1)).unwrap();
    let o2 = last_order(&w);
    propose(&mut w, MERCHANT, o2, 10, 300).unwrap();
    let p2 = last_proposal(&w);
    as_vg(&mut w, Action::AcceptProposal { order: o2, proposal: p2 }).unwrap();
    assert!(as_vg(&mut w, Action::AcceptProposal { order: o2, proposal: p2 }).is_err());
    conserved(&w);
}

#[test]
fn an_expired_proposal_cannot_be_accepted() {
    let mut w = world();
    as_vg(&mut w, buy(10, 400, false, 1, 1)).unwrap();
    let o = last_order(&w);
    propose(&mut w, MERCHANT, o, 10, 300).unwrap();
    let p = last_proposal(&w);
    for _ in 0..orders::PROPOSAL_TICKS {
        w.tick();
    }
    assert_eq!(w.proposals[&p].status, ProposalStatus::Released);
    assert!(as_vg(&mut w, Action::AcceptProposal { order: o, proposal: p }).is_err());
    conserved(&w);
}

#[test]
fn a_player_trades_through_an_order_like_anyone_else() {
    let mut w = world();
    let pa = player_account(PLAYER);
    w.grant(&pa, Asset::Credits, 1_000);
    let me = Caller::Player(PLAYER.into());
    w.execute(&me, &Action::PlaceOrder { side: Side::Buy, resource: Resource::Med, qty: 5, limit_total: 400, allow_partial: false, ttl_ticks: 6, nonce: 1, urgency: 0, purpose: String::new(), chain_id: None }).unwrap();
    let o = last_order(&w);
    assert_eq!(w.orders[&o].requester, pa);
    for m in w.merchant_ids() {
        for d in merchant_proposals(&w, &m) {
            if let Some(a) = &d.action {
                w.execute(&Caller::Agent(m.clone()), a).unwrap();
            }
        }
    }
    let best = w.pending_proposals(o).min_by_key(|p| p.total).unwrap().id;
    w.execute(&me, &Action::AcceptProposal { order: o, proposal: best }).unwrap();
    assert_eq!(w.balance(&pa, Asset::Res(Resource::Med)), 5);
    conserved(&w);
}

#[test]
fn a_merchant_that_keeps_losing_cuts_its_margin() {
    let mut w = world();
    let before = w.profile(MERCHANT).unwrap().strategy.margin_bp;
    for n in 1..=3 {
        as_vg(&mut w, buy(5, 5 * 40, false, n, 1)).unwrap();
        let o = last_order(&w);
        propose(&mut w, MERCHANT, o, 5, 5 * 30).unwrap();
        propose(&mut w, HALCYON, o, 5, 5 * 25).unwrap();
        let hal = last_proposal(&w);
        as_vg(&mut w, Action::AcceptProposal { order: o, proposal: hal }).unwrap();
    }
    let after = w.profile(MERCHANT).unwrap();
    assert_eq!(after.record.losses, 3);
    assert_eq!(after.strategy.margin_bp, before - orders::ADAPT_STEP_BP, "Vex reprices after three losses");
    assert_eq!(w.market.strategy.margin_bp, after.strategy.margin_bp, "and its instant market follows");
    assert!(w.profile(HALCYON).unwrap().record.wins >= 3);
}

#[test]
fn a_need_that_passed_is_cancelled_and_the_credits_kept() {
    let mut w = world();
    as_vg(&mut w, buy(10, 400, false, 1, 1)).unwrap();
    // Plenty of ammunition arrives before any merchant answers.
    w.grant(VG, Asset::Res(Resource::Ammo), 500);
    let c = commander_choices(&w, VANGUARD);
    assert!(matches!(c[0].action, Some(Action::CancelOrder { .. })), "{c:?}");
}

#[test]
fn in_a_living_world_both_merchants_win_business_and_value_is_conserved() {
    let mut w = genesis(11);
    for t in 0..24 * 12 {
        w.tick();
        if t % 3 == 0 {
            policy::run_fallback_agents(&mut w);
        }
    }
    let wins = |m: &str| w.profile(m).unwrap().record.wins;
    let fills = w.orders.values().filter(|o| !o.fills.is_empty()).count();
    assert!(fills > 3, "orders get filled: {fills}");
    assert!(wins(MERCHANT) > 0 && wins(HALCYON) > 0, "competition is real: Vex {} wins, Halcyon {}", wins(MERCHANT), wins(HALCYON));
    assert!(w.proposals.values().all(|p| p.status != ProposalStatus::Pending || p.expires_at > w.tick));
    for o in w.orders.values().filter(|o| !o.is_open()) {
        assert_eq!(w.balance(&o.escrow(), o.escrowed().0), 0, "closed order #{} left escrow behind", o.id);
    }
    conserved(&w);
}

#[test]
fn the_same_seed_gives_the_same_market() {
    let run = || {
        let mut w = genesis(5);
        for t in 0..24 * 4 {
            w.tick();
            if t % 3 == 0 {
                policy::run_fallback_agents(&mut w);
            }
        }
        w
    };
    assert_eq!(run(), run());
}

#[test]
fn an_unanswered_sell_order_is_not_reposted_for_a_day() {
    let mut w = world();
    w.grant(VG, Asset::Res(Resource::Fuel), 400);
    // Bids sit below cost: nobody answers, and it lapses.
    let place = policy::commander(&w, VANGUARD).into_iter().find(|d| d.trigger == "fuel surplus").and_then(|d| d.action).expect("offers its surplus");
    w.execute(&Caller::Agent(VANGUARD.into()), &place).unwrap();
    // Merchants decline; buy no fuel.
    for m in w.merchant_ids() {
        for d in merchant_proposals(&w, &m) {
            if let Some(a) = &d.action { let _ = w.execute(&Caller::Agent(m.clone()), a); }
        }
    }
    for _ in 0..policy::ORDER_TTL_TICKS { w.tick(); }
    assert!(w.orders.values().any(|o| o.resource == Resource::Fuel && o.status == OrderStatus::Expired && o.filled == 0), "no merchant met the cost floor");
    assert!(policy::commander(&w, VANGUARD).iter().all(|d| d.trigger != "fuel surplus"), "not reposted right away");
    for _ in 0..policy::SELL_RETRY_TICKS { w.tick(); }
    assert!(policy::commander(&w, VANGUARD).iter().any(|d| d.trigger == "fuel surplus"), "offered again a day later");
}
