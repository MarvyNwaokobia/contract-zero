use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult};

const WORLD: &str = "world2.contract-zero.testnet";
const ASSETS: &str = "assets.contract-zero.testnet";
const OWNER: &str = "contract-zero.testnet";
const SERVER: &str = "server.contract-zero.testnet";
const VANGUARD: &str = "vanguard.contract-zero.testnet";
const VEX: &str = "vex.contract-zero.testnet";
const PLAYER: &str = "player.contract-zero.testnet";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn as_(who: &str) {
    let mut b = VMContextBuilder::new();
    b.predecessor_account_id(acc(who)).signer_account_id(acc(who)).current_account_id(acc(WORLD)).block_timestamp(1_000_000_000_000).prepaid_gas(Gas::from_tgas(300));
    testing_env!(b.build());
}

fn callback(result: PromiseResult) {
    let mut b = VMContextBuilder::new();
    b.predecessor_account_id(acc(WORLD)).current_account_id(acc(WORLD)).prepaid_gas(Gas::from_tgas(300));
    testing_env!(b.build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![result]);
}

fn ok() -> PromiseResult {
    PromiseResult::Successful(vec![])
}

fn setup() -> WorldV2 {
    as_(OWNER);
    let mut w = WorldV2::new(acc(OWNER), acc(SERVER), acc(ASSETS));
    w.register_actor(acc(VANGUARD), Role::Faction);
    w.register_actor(acc(VEX), Role::Merchant);
    w
}

fn offer(w: &mut WorldV2, id: &str, buyer: &str, amount: u128, total: u128) {
    as_(VEX);
    w.post_offer(id.into(), acc(buyer), "ammo".into(), U128(amount), U128(total), 600);
}

fn bid(w: &mut WorldV2, id: &str, seller: &str, amount: u128, total: u128) {
    as_(VEX);
    w.post_bid(id.into(), acc(seller), "ammo".into(), U128(amount), U128(total), 600);
}

// ── the async lifecycle ──────────────────────────────────────────────────────

#[test]
fn an_offer_settles_and_is_consumed() {
    let mut w = setup();
    offer(&mut w, "q1", VANGUARD, 24, 517);
    as_(VANGUARD);
    let _ = w.accept_offer("q1".into(), U128(517));
    assert_eq!(w.get_quote("offer:q1".into()).unwrap().state, QuoteState::Settling);
    assert!(w.is_pending("offer:q1".into()));
    callback(ok());
    assert!(w.on_settled("offer:q1".into(), Some("offer:q1".into()), Ok(())));
    assert!(w.get_quote("offer:q1".into()).is_none());
    assert!(w.is_used("offer:q1".into()));
    assert!(!w.is_pending("offer:q1".into()));
}

#[test]
fn a_failed_settlement_reopens_the_offer_without_consuming_it() {
    let mut w = setup();
    offer(&mut w, "q1", VANGUARD, 24, 517);
    as_(VANGUARD);
    let _ = w.accept_offer("q1".into(), U128(517));
    callback(PromiseResult::Failed);
    assert!(!w.on_settled("offer:q1".into(), Some("offer:q1".into()), Err(PromiseError::Failed)));
    assert_eq!(w.get_quote("offer:q1".into()).unwrap().state, QuoteState::Open);
    assert!(!w.is_used("offer:q1".into()) && !w.is_pending("offer:q1".into()));
    // …and it can be accepted again.
    as_(VANGUARD);
    let _ = w.accept_offer("q1".into(), U128(517));
}

#[test]
#[should_panic(expected = "the quote is already settling")]
fn an_offer_cannot_be_accepted_twice_while_in_flight() {
    let mut w = setup();
    offer(&mut w, "q1", VANGUARD, 24, 517);
    as_(VANGUARD);
    let _ = w.accept_offer("q1".into(), U128(517));
    let _ = w.accept_offer("q1".into(), U128(517));
}

#[test]
#[should_panic(expected = "the quote is settling")]
fn a_settling_quote_cannot_be_cancelled() {
    let mut w = setup();
    offer(&mut w, "q1", VANGUARD, 24, 517);
    as_(VANGUARD);
    let _ = w.accept_offer("q1".into(), U128(517));
    as_(VEX);
    w.cancel_quote("offer:q1".into());
}

#[test]
fn a_raid_reserves_its_id_and_a_failure_frees_it_for_retry() {
    let mut w = setup();
    as_(SERVER);
    let _ = w.settle_raid("1".into(), acc(VANGUARD), acc(PLAYER), "ammo".into(), U128(60), None);
    assert!(w.is_pending("raid:1".into()));
    callback(PromiseResult::Failed);
    w.on_settled("raid:1".into(), None, Err(PromiseError::Failed));
    assert!(!w.is_pending("raid:1".into()) && !w.is_used("raid:1".into()));
    as_(SERVER);
    let _ = w.settle_raid("1".into(), acc(VANGUARD), acc(PLAYER), "ammo".into(), U128(60), None);
    callback(ok());
    w.on_settled("raid:1".into(), None, Ok(()));
    assert!(w.is_used("raid:1".into()));
}

#[test]
#[should_panic(expected = "operation already in flight")]
fn a_raid_cannot_be_submitted_twice_while_in_flight() {
    let mut w = setup();
    as_(SERVER);
    let _ = w.settle_raid("1".into(), acc(VANGUARD), acc(PLAYER), "ammo".into(), U128(60), None);
    let _ = w.settle_raid("1".into(), acc(VANGUARD), acc(PLAYER), "ammo".into(), U128(60), None);
}

#[test]
#[should_panic(expected = "operation already applied")]
fn a_settled_raid_cannot_be_replayed() {
    let mut w = setup();
    as_(SERVER);
    let _ = w.settle_raid("1".into(), acc(VANGUARD), acc(PLAYER), "ammo".into(), U128(60), None);
    callback(ok());
    w.on_settled("raid:1".into(), None, Ok(()));
    as_(SERVER);
    let _ = w.settle_raid("1".into(), acc(VANGUARD), acc(PLAYER), "ammo".into(), U128(60), None);
}

// ── bids: the merchant buys ──────────────────────────────────────────────────

#[test]
fn the_named_seller_accepts_a_bid_with_a_price_floor() {
    let mut w = setup();
    bid(&mut w, "b1", VANGUARD, 20, 300);
    as_(VANGUARD);
    let _ = w.accept_bid("b1".into(), U128(300));
    assert_eq!(w.get_quote("bid:b1".into()).unwrap().state, QuoteState::Settling);
}

#[test]
#[should_panic(expected = "price is below the seller's limit")]
fn a_seller_never_receives_less_than_its_floor() {
    let mut w = setup();
    bid(&mut w, "b1", VANGUARD, 20, 300);
    as_(VANGUARD);
    let _ = w.accept_bid("b1".into(), U128(301));
}

#[test]
#[should_panic(expected = "no such quote")]
fn an_offer_cannot_be_accepted_as_a_bid() {
    // Offer and bid ids live in separate namespaces ("offer:x" vs "bid:x").
    let mut w = setup();
    offer(&mut w, "x", VANGUARD, 1, 18);
    as_(VANGUARD);
    let _ = w.accept_bid("x".into(), U128(0));
}

#[test]
fn a_player_can_sell_to_a_bid_addressed_to_them() {
    let mut w = setup();
    bid(&mut w, "p1", PLAYER, 30, 400);
    as_(PLAYER);
    let _ = w.accept_bid("p1".into(), U128(400));
    assert!(w.is_pending("bid:p1".into()));
}

// ── authorization ────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "this quote is for another account")]
fn only_the_named_counterparty_accepts() {
    let mut w = setup();
    offer(&mut w, "q", VANGUARD, 1, 18);
    as_(PLAYER);
    let _ = w.accept_offer("q".into(), U128(18));
}

#[test]
#[should_panic(expected = "only a registered merchant posts quotes")]
fn a_faction_cannot_post_quotes() {
    let mut w = setup();
    as_(VANGUARD);
    w.post_bid("b".into(), acc(VEX), "ammo".into(), U128(1), U128(1), 60);
}

#[test]
#[should_panic(expected = "only the game server can do this")]
fn a_merchant_cannot_settle_raids() {
    let mut w = setup();
    as_(VEX);
    let _ = w.settle_raid("1".into(), acc(VANGUARD), acc(VEX), "ammo".into(), U128(60), None);
}

#[test]
#[should_panic(expected = "only the game server can do this")]
fn a_faction_cannot_apply_flows() {
    let mut w = setup();
    as_(VANGUARD);
    let _ = w.apply_flows("x".into(), vec![Flow { account_id: acc(VANGUARD), token_id: "credits".into(), amount: U128(1) }], vec![]);
}

#[test]
#[should_panic(expected = "the receiver of raid cargo must be a player")]
fn raid_cargo_cannot_be_routed_to_an_actor() {
    let mut w = setup();
    as_(SERVER);
    let _ = w.settle_raid("1".into(), acc(VANGUARD), acc(VEX), "ammo".into(), U128(60), None);
}

#[test]
#[should_panic(expected = "target is not a registered faction")]
fn raids_target_factions_only() {
    let mut w = setup();
    as_(SERVER);
    let _ = w.settle_raid("1".into(), acc(VEX), acc(PLAYER), "ammo".into(), U128(1), None);
}

#[test]
#[should_panic(expected = "flows apply only to registered actors")]
fn flows_cannot_touch_players() {
    let mut w = setup();
    as_(SERVER);
    let _ = w.apply_flows("x".into(), vec![Flow { account_id: acc(PLAYER), token_id: "credits".into(), amount: U128(1) }], vec![]);
}

#[test]
#[should_panic(expected = "quote expired")]
fn expired_quotes_cannot_settle() {
    let mut w = setup();
    as_(VEX);
    w.post_offer("q".into(), acc(VANGUARD), "ammo".into(), U128(1), U128(18), 1);
    let mut b = VMContextBuilder::new();
    b.predecessor_account_id(acc(VANGUARD)).current_account_id(acc(WORLD)).block_timestamp(1_000_000_000_000 + 2_000_000_000);
    testing_env!(b.build());
    let _ = w.accept_offer("q".into(), U128(18));
}

#[test]
#[should_panic(expected = "quote id already used")]
fn a_cancelled_quote_id_stays_consumed() {
    let mut w = setup();
    offer(&mut w, "q", VANGUARD, 1, 18);
    w.cancel_quote("offer:q".into());
    offer(&mut w, "q", VANGUARD, 1, 18);
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn the_server_cannot_register_actors() {
    let mut w = setup();
    as_(SERVER);
    w.register_actor(acc(PLAYER), Role::Merchant);
}

// ── trading sessions ─────────────────────────────────────────────────────────

const WALLET_PK: &str = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
const SESSION_PK: &str = "ed25519:DcA2MzgpJbrUATQLLceocVckhhAqrkingax4oJ9kZ847";

fn pk(s: &str) -> PublicKey {
    s.parse().unwrap()
}

/// Act as `who`, signing with `key`, optionally attaching a deposit, at time `t_s` (s).
fn signed(who: &str, key: &str, deposit: u128, t_s: u64) {
    let mut b = VMContextBuilder::new();
    b.predecessor_account_id(acc(who))
        .signer_account_id(acc(who))
        .signer_account_pk(pk(key))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .current_account_id(acc(WORLD))
        .block_timestamp(t_s * 1_000_000_000)
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(b.build());
}

fn open_session(w: &mut WorldV2, credits: u128, units: u128, ttl: u32) {
    signed(PLAYER, WALLET_PK, SESSION_DEPOSIT, 1_000);
    w.register_session(pk(SESSION_PK), U128(credits), U128(units), ttl);
}

#[test]
fn a_session_key_trades_within_its_budget_and_spends_it() {
    let mut w = setup();
    open_session(&mut w, 600, 50, 3_600);
    offer(&mut w, "o1", PLAYER, 10, 250);
    signed(PLAYER, SESSION_PK, 0, 1_000);
    let _ = w.accept_offer("o1".into(), U128(250));
    bid(&mut w, "b1", PLAYER, 20, 300);
    signed(PLAYER, SESSION_PK, 0, 1_000);
    let _ = w.accept_bid("b1".into(), U128(300));
    let s = w.get_session(acc(PLAYER), pk(SESSION_PK)).unwrap();
    assert_eq!((s.credit_budget, s.unit_budget), (U128(350), U128(30)));
}

#[test]
#[should_panic(expected = "over this session's credit budget")]
fn a_session_key_cannot_overspend() {
    let mut w = setup();
    open_session(&mut w, 200, 0, 3_600);
    offer(&mut w, "o1", PLAYER, 10, 250);
    signed(PLAYER, SESSION_PK, 0, 1_000);
    let _ = w.accept_offer("o1".into(), U128(250));
}

#[test]
#[should_panic(expected = "over this session's sale budget")]
fn a_session_key_cannot_oversell() {
    let mut w = setup();
    open_session(&mut w, 0, 5, 3_600);
    bid(&mut w, "b1", PLAYER, 20, 300);
    signed(PLAYER, SESSION_PK, 0, 1_000);
    let _ = w.accept_bid("b1".into(), U128(300));
}

#[test]
#[should_panic(expected = "this session has expired")]
fn an_expired_session_is_powerless() {
    let mut w = setup();
    open_session(&mut w, 1_000, 0, 60);
    offer(&mut w, "o1", PLAYER, 1, 18);
    signed(PLAYER, SESSION_PK, 0, 1_000 + 61);
    let _ = w.accept_offer("o1".into(), U128(18));
}

#[test]
#[should_panic(expected = "this session was revoked")]
fn a_revoked_session_key_is_powerless_even_before_the_key_is_deleted() {
    let mut w = setup();
    open_session(&mut w, 1_000, 0, 3_600);
    // The session key may sign itself out.
    signed(PLAYER, SESSION_PK, 0, 1_000);
    let _ = w.revoke_session(pk(SESSION_PK));
    offer(&mut w, "o1", PLAYER, 1, 18);
    signed(PLAYER, SESSION_PK, 0, 1_000);
    let _ = w.accept_offer("o1".into(), U128(18));
}

#[test]
fn the_wallet_key_is_not_limited_by_a_session() {
    let mut w = setup();
    open_session(&mut w, 0, 0, 3_600);
    offer(&mut w, "o1", PLAYER, 10, 250);
    signed(PLAYER, WALLET_PK, 0, 1_000);
    let _ = w.accept_offer("o1".into(), U128(250));
    assert!(w.is_pending("offer:o1".into()));
}

#[test]
#[should_panic(expected = "a session key cannot open its own session")]
fn a_session_key_cannot_widen_itself() {
    let mut w = setup();
    signed(PLAYER, SESSION_PK, SESSION_DEPOSIT, 1_000);
    w.register_session(pk(SESSION_PK), U128(1_000_000), U128(1_000_000), 60);
}

#[test]
#[should_panic(expected = "attach 0.001 NEAR")]
fn a_session_needs_its_storage_deposit() {
    let mut w = setup();
    signed(PLAYER, WALLET_PK, 0, 1_000);
    w.register_session(pk(SESSION_PK), U128(1), U128(1), 60);
}

#[test]
#[should_panic(expected = "this key was revoked; use a new key")]
fn a_revoked_key_cannot_be_reopened() {
    let mut w = setup();
    open_session(&mut w, 1_000, 0, 3_600);
    signed(PLAYER, WALLET_PK, 0, 1_000);
    let _ = w.revoke_session(pk(SESSION_PK));
    open_session(&mut w, 1_000, 0, 3_600);
}

#[test]
#[should_panic(expected = "session length out of range")]
fn sessions_are_bounded_in_time() {
    let mut w = setup();
    signed(PLAYER, WALLET_PK, SESSION_DEPOSIT, 1_000);
    w.register_session(pk(SESSION_PK), U128(1), U128(1), MAX_SESSION_SECS + 1);
}

// ── operations ───────────────────────────────────────────────────────────────

fn leg(from: &str, to: &str, token: &str, amount: u128) -> Leg {
    Leg { from: acc(from), to: acc(to), token_id: token.into(), amount: U128(amount) }
}

#[test]
fn the_server_settles_a_recovery_and_its_fee() {
    let mut w = setup();
    as_(SERVER);
    let _ = w.settle_operation("7".into(), acc(PLAYER), vec![leg(VANGUARD, VEX, "fuel", 60), leg(VEX, PLAYER, "credits", 540)]);
    assert!(w.is_pending("op:7".into()));
    callback(ok());
    assert!(w.on_settled("op:7".into(), None, Ok(())));
    assert!(w.is_used("op:7".into()));
}

#[test]
#[should_panic(expected = "only the game server can do this")]
fn only_the_server_settles_operations() {
    let mut w = setup();
    as_(VEX);
    let _ = w.settle_operation("7".into(), acc(PLAYER), vec![leg(VEX, PLAYER, "credits", 1)]);
}

#[test]
#[should_panic(expected = "operation legs debit actors only")]
fn an_operation_cannot_debit_a_player() {
    let mut w = setup();
    as_(SERVER);
    let _ = w.settle_operation("7".into(), acc(PLAYER), vec![leg(PLAYER, VEX, "ammo", 1)]);
}

#[test]
#[should_panic(expected = "operation legs pay actors or the player")]
fn an_operation_pays_only_actors_or_the_named_player() {
    let mut w = setup();
    as_(SERVER);
    let _ = w.settle_operation("7".into(), acc(PLAYER), vec![leg(VEX, "someone.testnet", "credits", 1)]);
}

#[test]
#[should_panic(expected = "operation already applied")]
fn an_operation_settles_once() {
    let mut w = setup();
    as_(SERVER);
    let _ = w.settle_operation("7".into(), acc(PLAYER), vec![leg(VEX, PLAYER, "credits", 1)]);
    callback(ok());
    w.on_settled("op:7".into(), None, Ok(()));
    as_(SERVER);
    let _ = w.settle_operation("7".into(), acc(PLAYER), vec![leg(VEX, PLAYER, "credits", 1)]);
}

// ── supply orders ────────────────────────────────────────────────────────────

const HALCYON: &str = "halcyon.contract-zero.testnet";

fn order_world() -> WorldV2 {
    let mut w = setup();
    as_(OWNER);
    w.register_actor(acc(HALCYON), Role::Merchant);
    w
}

fn at(who: &str, t_s: u64) {
    signed(who, WALLET_PK, 0, t_s);
}

fn step(w: &mut WorldV2, order: &str, op: &str, proposal: Option<&str>, ok_: bool) -> bool {
    callback(if ok_ { ok() } else { PromiseResult::Failed });
    match w.on_order_step(order.into(), op.into(), proposal.map(String::from), if ok_ { Ok(()) } else { Err(PromiseError::Failed) }) {
        PromiseOrValue::Value(v) => v,
        PromiseOrValue::Promise(_) => true,
    }
}

/// Vanguard asks for 40 ammo, at most 800 credits, partial fills allowed; funded.
fn open_order(w: &mut WorldV2, id: &str, partial: bool) {
    at(VANGUARD, 1_000);
    let _ = w.place_order(id.into(), OrderSide::Buy, "ammo".into(), U128(40), U128(800), partial, 600);
    assert_eq!(w.get_order(id.into()).unwrap().state, OrderState::Funding);
    assert!(step(w, id, &format!("order:{id}"), None, true));
    assert_eq!(w.get_order(id.into()).unwrap().state, OrderState::Open);
}

fn propose(w: &mut WorldV2, who: &str, order: &str, id: &str, qty: u128, total: u128) {
    at(who, 1_010);
    w.propose(order.into(), id.into(), U128(qty), U128(total), 300);
}

#[test]
fn two_merchants_compete_and_the_requester_picks_one() {
    let mut w = order_world();
    open_order(&mut w, "o1", false);
    propose(&mut w, VEX, "o1", "vex-1", 40, 760);
    propose(&mut w, HALCYON, "o1", "hal-1", 40, 700);
    at(VANGUARD, 1_020);
    let _ = w.accept_proposal("o1".into(), "hal-1".into());
    assert_eq!(w.get_order("o1".into()).unwrap().state, OrderState::Settling);
    assert!(step(&mut w, "o1", "fill:o1|hal-1", Some("hal-1"), true));
    let o = w.get_order("o1".into()).unwrap();
    // Filled: 100 credits of escrow (800 - 700) are on their way back.
    assert_eq!((o.remaining.0, o.settled_credits.0, o.fills, o.state, o.close_reason.as_deref()), (0, 700, 1, OrderState::Refunding, Some("filled")));
    assert!(w.is_pending("refund:o1".into()));
    assert!(step(&mut w, "o1", "refund:o1", None, true));
    assert_eq!(w.get_order("o1".into()).unwrap().state, OrderState::Closed);
    assert!(w.is_used("fill:o1|hal-1".into()) && w.is_used("refund:o1".into()));
    // The losing proposal is deleted from storage once the order closes…
    assert!(w.get_proposal("o1".into(), "vex-1".into()).is_none(), "leftover proposals are cleaned up");
    // …and can't be accepted afterwards.
    at(VANGUARD, 1_030);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = w.accept_proposal("o1".into(), "vex-1".into()); })).is_err());
}

#[test]
#[should_panic(expected = "order id already used")]
fn an_order_id_is_never_replayed() {
    let mut w = order_world();
    open_order(&mut w, "o1", false);
    at(VANGUARD, 1_001);
    let _ = w.place_order("o1".into(), OrderSide::Buy, "ammo".into(), U128(1), U128(10), false, 600);
}

#[test]
fn a_failed_funding_drops_the_order_and_frees_the_id() {
    let mut w = order_world();
    at(VANGUARD, 1_000);
    let _ = w.place_order("o1".into(), OrderSide::Buy, "ammo".into(), U128(40), U128(800), false, 600);
    assert!(!step(&mut w, "o1", "order:o1", None, false));
    assert!(w.get_order("o1".into()).is_none());
    at(VANGUARD, 1_001);
    let _ = w.place_order("o1".into(), OrderSide::Buy, "ammo".into(), U128(40), U128(800), false, 600);
}

#[test]
#[should_panic(expected = "merchants fill orders")]
fn merchants_cannot_place_orders() {
    let mut w = order_world();
    at(VEX, 1_000);
    let _ = w.place_order("o1".into(), OrderSide::Buy, "ammo".into(), U128(1), U128(10), false, 600);
}

#[test]
#[should_panic(expected = "only a registered merchant proposes")]
fn only_merchants_propose() {
    let mut w = order_world();
    open_order(&mut w, "o1", false);
    propose(&mut w, PLAYER, "o1", "p", 40, 700);
}

#[test]
#[should_panic(expected = "outside the order's price limit")]
fn a_proposal_above_the_limit_is_refused() {
    let mut w = order_world();
    open_order(&mut w, "o1", false);
    propose(&mut w, VEX, "o1", "vex-1", 40, 801);
}

#[test]
#[should_panic(expected = "outside the order's price limit")]
fn a_partial_fill_cannot_take_the_whole_budget() {
    // 10 of 40 units may cost at most 200 (pro rata), even though 800 is escrowed.
    let mut w = order_world();
    open_order(&mut w, "o1", true);
    propose(&mut w, VEX, "o1", "vex-1", 10, 201);
}

#[test]
#[should_panic(expected = "this order takes no partial fills")]
fn an_all_or_nothing_order_refuses_partials() {
    let mut w = order_world();
    open_order(&mut w, "o1", false);
    propose(&mut w, VEX, "o1", "vex-1", 20, 300);
}

#[test]
fn partial_fills_add_up_and_the_rest_is_refunded() {
    let mut w = order_world();
    open_order(&mut w, "o1", true);
    propose(&mut w, VEX, "o1", "vex-1", 15, 270);
    propose(&mut w, HALCYON, "o1", "hal-1", 25, 450);
    at(VANGUARD, 1_020);
    let _ = w.accept_proposal("o1".into(), "vex-1".into());
    assert!(step(&mut w, "o1", "fill:o1|vex-1", Some("vex-1"), true));
    let o = w.get_order("o1".into()).unwrap();
    assert_eq!((o.remaining.0, o.settled_credits.0, o.state), (25, 270, OrderState::Open));
    at(VANGUARD, 1_021);
    let _ = w.accept_proposal("o1".into(), "hal-1".into());
    assert!(step(&mut w, "o1", "fill:o1|hal-1", Some("hal-1"), true));
    let o = w.get_order("o1".into()).unwrap();
    assert_eq!((o.remaining.0, o.settled_credits.0, o.fills, o.state), (0, 720, 2, OrderState::Refunding));
}

#[test]
#[should_panic(expected = "only the requester accepts")]
fn nobody_else_can_accept_for_the_requester() {
    let mut w = order_world();
    open_order(&mut w, "o1", false);
    propose(&mut w, VEX, "o1", "vex-1", 40, 760);
    at(VEX, 1_020);
    let _ = w.accept_proposal("o1".into(), "vex-1".into());
}

#[test]
#[should_panic(expected = "the order is not open")]
fn two_fills_cannot_race() {
    let mut w = order_world();
    open_order(&mut w, "o1", true);
    propose(&mut w, VEX, "o1", "vex-1", 20, 380);
    propose(&mut w, HALCYON, "o1", "hal-1", 20, 360);
    at(VANGUARD, 1_020);
    let _ = w.accept_proposal("o1".into(), "vex-1".into());
    let _ = w.accept_proposal("o1".into(), "hal-1".into());
}

#[test]
#[should_panic(expected = "the order is not open")]
fn a_cancel_cannot_race_a_fill() {
    let mut w = order_world();
    open_order(&mut w, "o1", false);
    propose(&mut w, VEX, "o1", "vex-1", 40, 760);
    at(VANGUARD, 1_020);
    let _ = w.accept_proposal("o1".into(), "vex-1".into());
    let _ = w.cancel_order("o1".into());
}

#[test]
fn a_failed_fill_reopens_the_order_and_can_be_retried() {
    let mut w = order_world();
    open_order(&mut w, "o1", false);
    propose(&mut w, VEX, "o1", "vex-1", 40, 760);
    at(VANGUARD, 1_020);
    let _ = w.accept_proposal("o1".into(), "vex-1".into());
    assert!(!step(&mut w, "o1", "fill:o1|vex-1", Some("vex-1"), false));
    let o = w.get_order("o1".into()).unwrap();
    assert_eq!((o.state, o.remaining.0, o.fills), (OrderState::Open, 40, 0));
    assert!(!w.is_used("fill:o1|vex-1".into()) && w.get_proposal("o1".into(), "vex-1".into()).is_some());
    at(VANGUARD, 1_021);
    let _ = w.accept_proposal("o1".into(), "vex-1".into());
}

#[test]
#[should_panic(expected = "proposal id already used")]
fn a_settled_fill_cannot_settle_twice() {
    let mut w = order_world();
    open_order(&mut w, "o1", true);
    propose(&mut w, VEX, "o1", "vex-1", 10, 190);
    at(VANGUARD, 1_020);
    let _ = w.accept_proposal("o1".into(), "vex-1".into());
    assert!(step(&mut w, "o1", "fill:o1|vex-1", Some("vex-1"), true));
    // The merchant re-posts the same proposal id to replay the fill.
    propose(&mut w, VEX, "o1", "vex-1", 10, 190);
}

#[test]
#[should_panic(expected = "proposal expired")]
fn an_expired_proposal_cannot_be_accepted() {
    let mut w = order_world();
    open_order(&mut w, "o1", false);
    propose(&mut w, VEX, "o1", "vex-1", 40, 760); // ttl 300 s from t=1010
    at(VANGUARD, 1_311);
    let _ = w.accept_proposal("o1".into(), "vex-1".into());
}

#[test]
fn an_expired_order_refunds_its_requester_whoever_expires_it() {
    let mut w = order_world();
    open_order(&mut w, "o1", false);
    at(VEX, 1_500);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = w.expire_order("o1".into()); })).is_err(), "not before the deadline");
    at(VEX, 1_601);
    let _ = w.expire_order("o1".into());
    let o = w.get_order("o1".into()).unwrap();
    assert_eq!((o.state, o.close_reason.as_deref(), o.requester.as_str()), (OrderState::Refunding, Some("expired"), VANGUARD));
}

#[test]
fn a_failed_refund_waits_for_a_retry() {
    let mut w = order_world();
    open_order(&mut w, "o1", false);
    at(VANGUARD, 1_100);
    let _ = w.cancel_order("o1".into());
    assert!(!step(&mut w, "o1", "refund:o1", None, false));
    assert_eq!(w.get_order("o1".into()).unwrap().state, OrderState::Refunding);
    at(PLAYER, 1_200);
    let _ = w.retry_refund("o1".into());
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = w.retry_refund("o1".into()); })).is_err(), "one refund in flight at a time");
    assert!(step(&mut w, "o1", "refund:o1", None, true));
    assert_eq!(w.get_order("o1".into()).unwrap().state, OrderState::Closed);
}

#[test]
fn a_session_key_places_orders_only_within_its_budget() {
    let mut w = order_world();
    open_session(&mut w, 600, 50, 3_600);
    signed(PLAYER, SESSION_PK, 0, 1_000);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let _ = w.place_order("p1".into(), OrderSide::Buy, "ammo".into(), U128(40), U128(800), false, 600); })).is_err(), "over budget");
    signed(PLAYER, SESSION_PK, 0, 1_000);
    let _ = w.place_order("p2".into(), OrderSide::Buy, "ammo".into(), U128(20), U128(500), false, 600);
    assert_eq!(w.get_session(acc(PLAYER), pk(SESSION_PK)).unwrap().credit_budget.0, 100);
}

#[test]
#[should_panic(expected = "this session has expired")]
fn an_expired_session_key_cannot_place_orders() {
    let mut w = order_world();
    open_session(&mut w, 600, 50, 60);
    signed(PLAYER, SESSION_PK, 0, 2_000);
    let _ = w.place_order("p1".into(), OrderSide::Buy, "ammo".into(), U128(1), U128(10), false, 600);
}

#[test]
fn a_sell_order_escrows_goods_and_holds_a_minimum() {
    let mut w = order_world();
    at(PLAYER, 1_000);
    let _ = w.place_order("s1".into(), OrderSide::Sell, "fuel".into(), U128(30), U128(450), false, 600);
    assert!(step(&mut w, "s1", "order:s1", None, true));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| propose(&mut w, VEX, "s1", "lowball", 30, 449))).is_err(), "below the minimum");
    propose(&mut w, HALCYON, "s1", "hal-1", 30, 480);
    at(PLAYER, 1_020);
    let _ = w.accept_proposal("s1".into(), "hal-1".into());
    assert!(step(&mut w, "s1", "fill:s1|hal-1", Some("hal-1"), true));
    let o = w.get_order("s1".into()).unwrap();
    // Nothing unsold: closes without a refund transfer.
    assert_eq!((o.state, o.settled_credits.0), (OrderState::Closed, 480));
}

#[test]
fn the_price_check_is_exact_integer_arithmetic() {
    assert!(within_limit(OrderSide::Buy, 3, 100, 1, 33));
    assert!(!within_limit(OrderSide::Buy, 3, 100, 1, 34));
    assert!(within_limit(OrderSide::Sell, 3, 100, 1, 34));
    assert!(!within_limit(OrderSide::Sell, 3, 100, 1, 33));
}

#[test]
fn an_order_takes_a_bounded_number_of_proposals() {
    let mut w = order_world();
    open_order(&mut w, "o1", true);
    for i in 0..16 {
        propose(&mut w, if i % 2 == 0 { VEX } else { HALCYON }, "o1", &format!("p{i}"), 1, 20);
    }
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| propose(&mut w, VEX, "o1", "p16", 1, 20))).is_err());
}
