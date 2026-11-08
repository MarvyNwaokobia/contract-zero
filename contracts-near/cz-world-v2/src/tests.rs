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
