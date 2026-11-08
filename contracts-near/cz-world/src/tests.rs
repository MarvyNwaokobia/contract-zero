use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, NearToken, PromiseResult};

const CONTRACT: &str = "world.contract-zero.testnet";
const SERVER: &str = "server.contract-zero.testnet";
const VANGUARD: &str = "vanguard.contract-zero.testnet";
const VEX: &str = "vex.contract-zero.testnet";
const PLAYER: &str = "raider.testnet";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn ctx(predecessor: &str) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.predecessor_account_id(acc(predecessor))
        .current_account_id(acc(CONTRACT))
        .block_timestamp(1_000_000_000_000)
        .prepaid_gas(Gas::from_tgas(300));
    b
}

fn as_(who: &str) {
    testing_env!(ctx(who).build());
}

fn as_with_yocto(who: &str) {
    testing_env!(ctx(who).attached_deposit(NearToken::from_yoctonear(1)).build());
}

fn flow(a: &str, t: &str, n: u128) -> Flow {
    Flow { account_id: acc(a), token_id: t.into(), amount: U128(n) }
}

/// The acceptance scenario's starting state on chain.
fn setup() -> World {
    as_(SERVER);
    let mut w = World::new(acc(SERVER));
    w.register_actor(acc(VANGUARD), Role::Faction);
    w.register_actor(acc(VEX), Role::Merchant);
    w.apply_flows(
        "genesis".into(),
        vec![flow(VANGUARD, "ammo", 100), flow(VANGUARD, "credits", 1_000), flow(VEX, "ammo", 100), flow(VEX, "credits", 500)],
        vec![],
    );
    w
}

fn bal(w: &World, a: &str, t: &str) -> u128 {
    w.mt_balance_of(acc(a), t.into()).0
}

fn offer(w: &mut World, id: &str, buyer: &str, token: &str, amount: u128, total: u128) {
    as_(VEX);
    w.post_offer(id.into(), acc(buyer), token.into(), U128(amount), U128(total), 300);
}

// ── happy paths ──────────────────────────────────────────────────────────────

#[test]
fn genesis_mints_tracks_supply_and_emits_nep245_mint_events() {
    let w = setup();
    assert_eq!(bal(&w, VANGUARD, "ammo"), 100);
    assert_eq!(w.mt_supply("ammo".into()), Some(U128(200)));
    assert_eq!(w.mt_supply("gold".into()), None);
    assert_eq!(w.mt_batch_balance_of(acc(VEX), vec!["ammo".into(), "credits".into()]), vec![U128(100), U128(500)]);
    let logs = get_logs();
    assert_eq!(logs.len(), 1, "a batch emits one aggregated mt_mint event");
    let ev: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(logs[0].trim_start_matches("EVENT_JSON:")).unwrap();
    assert_eq!(ev["standard"], "nep245");
    assert_eq!(ev["version"], "1.0.0");
    assert_eq!(ev["event"], "mt_mint");
    assert_eq!(ev["data"].as_array().unwrap().len(), 4);
    assert_eq!(ev["data"][0]["owner_id"], VANGUARD);
    assert_eq!(ev["data"][0]["token_ids"][0], "ammo");
    assert_eq!(ev["data"][0]["amounts"][0], "100");
}

#[test]
fn mt_token_lists_known_tokens_only() {
    let w = setup();
    assert_eq!(w.mt_token(vec!["fuel".into(), "gold".into()]), vec![Some(Token { token_id: "fuel".into(), owner_id: None }), None]);
}

#[test]
fn the_acceptance_raid_and_purchase() {
    let mut w = setup();
    as_(SERVER);
    w.settle_raid("1".into(), acc(VANGUARD), acc(PLAYER), "ammo".into(), U128(60), None);
    assert_eq!(bal(&w, VANGUARD, "ammo"), 40);
    assert_eq!(bal(&w, PLAYER, "ammo"), 60);
    assert!(w.is_holder(acc(PLAYER)), "the player was registered on settlement");
    let log = get_logs().pop().unwrap();
    assert!(log.contains("\"event\":\"mt_transfer\"") && log.contains("\"memo\":\"raid:1\"") && log.contains(PLAYER));

    offer(&mut w, "q1", VANGUARD, "ammo", 20, 360);
    as_(VANGUARD);
    w.accept_offer("q1".into(), U128(360));
    assert_eq!((bal(&w, VANGUARD, "ammo"), bal(&w, VANGUARD, "credits")), (60, 640));
    assert_eq!((bal(&w, VEX, "ammo"), bal(&w, VEX, "credits")), (80, 860));
    assert_eq!(w.mt_supply("ammo".into()), Some(U128(200)), "raids and trades never change supply");
    assert!(w.is_used("offer:q1".into()));
    assert_eq!(get_logs().len(), 2, "one mt_transfer per leg");
}

#[test]
fn a_raid_can_pay_the_sponsors_bounty_in_the_same_receipt() {
    let mut w = setup();
    as_(SERVER);
    w.settle_raid("2".into(), acc(VANGUARD), acc(PLAYER), "ammo".into(), U128(10), Some((acc(VEX), U128(120))));
    assert_eq!(bal(&w, PLAYER, "credits"), 120);
    assert_eq!(bal(&w, VEX, "credits"), 380);
}

#[test]
fn players_can_transfer_with_one_yocto_to_registered_holders() {
    let mut w = setup();
    as_(SERVER);
    w.settle_raid("1".into(), acc(VANGUARD), acc(PLAYER), "ammo".into(), U128(10), None);
    as_with_yocto(PLAYER);
    w.mt_transfer(acc(VEX), "ammo".into(), U128(4), None, Some("sold".into()));
    assert_eq!(bal(&w, PLAYER, "ammo"), 6);
    assert_eq!(bal(&w, VEX, "ammo"), 104);
}

#[test]
fn burns_destroy_supply() {
    let mut w = setup();
    as_(SERVER);
    w.apply_flows("ops-1".into(), vec![], vec![flow(VANGUARD, "ammo", 24)]);
    assert_eq!(bal(&w, VANGUARD, "ammo"), 76);
    assert_eq!(w.mt_supply("ammo".into()), Some(U128(176)));
    assert!(get_logs()[0].contains("\"event\":\"mt_burn\""));
}

// ── unauthorized trading ─────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "only a registered merchant posts offers")]
fn a_faction_cannot_post_offers() {
    let mut w = setup();
    as_(VANGUARD);
    w.post_offer("q".into(), acc(VEX), "ammo".into(), U128(1), U128(1), 60);
}

#[test]
#[should_panic(expected = "only a registered merchant posts offers")]
fn a_player_cannot_post_offers() {
    let mut w = setup();
    as_(PLAYER);
    w.post_offer("q".into(), acc(VANGUARD), "ammo".into(), U128(1), U128(1), 60);
}

#[test]
#[should_panic(expected = "this offer is for another buyer")]
fn only_the_named_buyer_accepts() {
    let mut w = setup();
    offer(&mut w, "q", VANGUARD, "ammo", 1, 18);
    as_(PLAYER);
    w.accept_offer("q".into(), U128(18));
}

#[test]
#[should_panic(expected = "this offer is for another buyer")]
fn the_merchant_cannot_accept_its_own_offer() {
    let mut w = setup();
    offer(&mut w, "q", VANGUARD, "ammo", 1, 18);
    as_(VEX);
    w.accept_offer("q".into(), U128(18));
}

#[test]
#[should_panic(expected = "cannot sell to yourself")]
fn the_merchant_cannot_offer_to_itself() {
    let mut w = setup();
    offer(&mut w, "q", VEX, "ammo", 1, 18);
}

#[test]
#[should_panic(expected = "receiver is not a registered holder")]
fn offers_go_only_to_registered_holders() {
    let mut w = setup();
    offer(&mut w, "q", "stranger.testnet", "ammo", 1, 18);
}

#[test]
#[should_panic(expected = "credits are the payment, not the goods")]
fn credits_cannot_be_offered_as_goods() {
    let mut w = setup();
    offer(&mut w, "q", VANGUARD, "credits", 10, 1);
}

#[test]
#[should_panic(expected = "price is above the buyer's limit")]
fn the_buyer_never_pays_more_than_its_limit() {
    let mut w = setup();
    offer(&mut w, "q", VANGUARD, "ammo", 10, 900);
    as_(VANGUARD);
    w.accept_offer("q".into(), U128(180));
}

#[test]
#[should_panic(expected = "offer expired")]
fn an_expired_offer_cannot_settle() {
    let mut w = setup();
    as_(VEX);
    w.post_offer("q".into(), acc(VANGUARD), "ammo".into(), U128(1), U128(18), 1);
    testing_env!(ctx(VANGUARD).block_timestamp(1_000_000_000_000 + 2_000_000_000).build());
    w.accept_offer("q".into(), U128(18));
}

#[test]
#[should_panic(expected = "ttl out of range")]
fn offer_lifetimes_are_bounded() {
    let mut w = setup();
    as_(VEX);
    w.post_offer("q".into(), acc(VANGUARD), "ammo".into(), U128(1), U128(18), MAX_OFFER_TTL_SECS + 1);
}

#[test]
#[should_panic(expected = "not your offer")]
fn only_the_merchant_cancels_its_offer() {
    let mut w = setup();
    offer(&mut w, "q", VANGUARD, "ammo", 1, 18);
    as_(VANGUARD);
    w.cancel_offer("q".into());
}

// ── forged raid settlement ───────────────────────────────────────────────────

#[test]
#[should_panic(expected = "only the game server can do this")]
fn a_player_cannot_settle_its_own_raid() {
    let mut w = setup();
    as_(PLAYER);
    w.settle_raid("9".into(), acc(VANGUARD), acc(PLAYER), "ammo".into(), U128(60), None);
}

#[test]
#[should_panic(expected = "only the game server can do this")]
fn the_contract_account_itself_is_not_the_server() {
    let mut w = setup();
    as_(CONTRACT);
    w.settle_raid("9".into(), acc(VANGUARD), acc(PLAYER), "ammo".into(), U128(60), None);
}

#[test]
#[should_panic(expected = "target is not a registered faction")]
fn a_raid_cannot_target_the_merchant() {
    let mut w = setup();
    as_(SERVER);
    w.settle_raid("9".into(), acc(VEX), acc(PLAYER), "ammo".into(), U128(10), None);
}

#[test]
#[should_panic(expected = "the receiver of raid cargo must be a player, not an actor")]
fn a_raid_cannot_pay_an_actor() {
    let mut w = setup();
    as_(SERVER);
    w.settle_raid("9".into(), acc(VANGUARD), acc(VEX), "ammo".into(), U128(10), None);
}

#[test]
#[should_panic(expected = "raids move resources, not credits")]
fn a_raid_cannot_take_credits() {
    let mut w = setup();
    as_(SERVER);
    w.settle_raid("9".into(), acc(VANGUARD), acc(PLAYER), "credits".into(), U128(10), None);
}

#[test]
#[should_panic(expected = "amount over the per-operation limit")]
fn raid_amounts_are_bounded() {
    let mut w = setup();
    as_(SERVER);
    w.settle_raid("9".into(), acc(VANGUARD), acc(PLAYER), "ammo".into(), U128(MAX_AMOUNT + 1), None);
}

#[test]
#[should_panic(expected = "the bounty sponsor must be a registered actor")]
fn a_bounty_cannot_be_drawn_from_a_player() {
    let mut w = setup();
    as_(SERVER);
    w.settle_raid("1".into(), acc(VANGUARD), acc(PLAYER), "ammo".into(), U128(10), None);
    w.settle_raid("2".into(), acc(VANGUARD), acc("other.testnet"), "ammo".into(), U128(10), Some((acc(PLAYER), U128(1))));
}

// ── duplicate operations ─────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "operation already applied")]
fn a_raid_settles_once() {
    let mut w = setup();
    as_(SERVER);
    w.settle_raid("1".into(), acc(VANGUARD), acc(PLAYER), "ammo".into(), U128(10), None);
    w.settle_raid("1".into(), acc(VANGUARD), acc(PLAYER), "ammo".into(), U128(10), None);
}

#[test]
#[should_panic(expected = "operation already applied")]
fn a_flow_batch_applies_once() {
    let mut w = setup();
    as_(SERVER);
    w.apply_flows("genesis".into(), vec![flow(VANGUARD, "ammo", 1)], vec![]);
}

#[test]
#[should_panic(expected = "no such offer")]
fn an_offer_is_accepted_once() {
    let mut w = setup();
    offer(&mut w, "q1", VANGUARD, "ammo", 5, 90);
    as_(VANGUARD);
    w.accept_offer("q1".into(), U128(90));
    w.accept_offer("q1".into(), U128(90));
}

#[test]
#[should_panic(expected = "offer id already used")]
fn a_consumed_offer_id_cannot_be_reposted() {
    let mut w = setup();
    offer(&mut w, "q1", VANGUARD, "ammo", 5, 90);
    as_(VANGUARD);
    w.accept_offer("q1".into(), U128(90));
    offer(&mut w, "q1", VANGUARD, "ammo", 5, 90);
}

#[test]
#[should_panic(expected = "offer id already used")]
fn a_cancelled_offer_id_cannot_be_reposted() {
    let mut w = setup();
    offer(&mut w, "q1", VANGUARD, "ammo", 5, 90);
    w.cancel_offer("q1".into());
    offer(&mut w, "q1", VANGUARD, "ammo", 5, 1);
}

// ── insufficient balances ────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "buyer cannot pay")]
fn an_unaffordable_offer_cannot_settle() {
    let mut w = setup();
    offer(&mut w, "q", VANGUARD, "ammo", 50, 5_000);
    as_(VANGUARD);
    w.accept_offer("q".into(), U128(5_000));
}

#[test]
#[should_panic(expected = "merchant does not hold the goods")]
fn a_merchant_cannot_offer_what_it_does_not_hold() {
    let mut w = setup();
    offer(&mut w, "q", VANGUARD, "ammo", 101, 1);
}

#[test]
fn a_failed_acceptance_moves_nothing() {
    let mut w = setup();
    offer(&mut w, "q", VANGUARD, "ammo", 50, 5_000);
    as_(VANGUARD);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| w.accept_offer("q".into(), U128(5_000))));
    assert!(r.is_err());
    // (On chain a panic reverts the receipt; here we check no leg ran before the check.)
    assert_eq!((bal(&w, VANGUARD, "ammo"), bal(&w, VEX, "ammo")), (100, 100));
    assert!(!w.is_used("offer:q".into()), "a failed acceptance does not burn the offer id");
}

#[test]
#[should_panic(expected = "insufficient balance")]
fn a_raid_cannot_take_more_than_the_faction_holds() {
    let mut w = setup();
    as_(SERVER);
    w.settle_raid("1".into(), acc(VANGUARD), acc(PLAYER), "ammo".into(), U128(101), None);
}

#[test]
#[should_panic(expected = "insufficient balance")]
fn burns_cannot_exceed_balance() {
    let mut w = setup();
    as_(SERVER);
    w.apply_flows("b".into(), vec![], vec![flow(VEX, "fuel", 1)]);
}

#[test]
#[should_panic(expected = "insufficient balance")]
fn a_holder_cannot_transfer_more_than_it_has() {
    let mut w = setup();
    as_with_yocto(VANGUARD);
    w.mt_transfer(acc(VEX), "ammo".into(), U128(101), None, None);
}

// ── issuance rules ───────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "flows apply only to registered actors")]
fn the_server_cannot_mint_to_players() {
    let mut w = setup();
    as_(SERVER);
    w.apply_flows("x".into(), vec![flow(PLAYER, "credits", 1_000)], vec![]);
}

#[test]
#[should_panic(expected = "amount over the per-operation limit")]
fn mints_are_bounded_per_entry() {
    let mut w = setup();
    as_(SERVER);
    w.apply_flows("x".into(), vec![flow(VANGUARD, "credits", MAX_AMOUNT + 1)], vec![]);
}

#[test]
#[should_panic(expected = "too many flows in one batch")]
fn batches_are_bounded() {
    let mut w = setup();
    as_(SERVER);
    let mints = (0..=MAX_FLOWS).map(|_| flow(VANGUARD, "ammo", 1)).collect();
    w.apply_flows("x".into(), mints, vec![]);
}

#[test]
#[should_panic(expected = "supply cap exceeded")]
fn supply_is_capped() {
    let mut w = setup();
    as_(SERVER);
    for i in 0..(MAX_SUPPLY / (MAX_AMOUNT * MAX_FLOWS as u128) + 1) {
        as_(SERVER); // fresh receipt per batch, as on chain
        let mints = (0..MAX_FLOWS).map(|_| flow(VANGUARD, "fuel", MAX_AMOUNT)).collect();
        w.apply_flows(format!("x{i}"), mints, vec![]);
    }
}

#[test]
#[should_panic(expected = "unknown token")]
fn unknown_tokens_are_refused() {
    let mut w = setup();
    as_(SERVER);
    w.apply_flows("x".into(), vec![flow(VANGUARD, "gold", 1)], vec![]);
}

// ── compromised agents ───────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "only the game server can do this")]
fn a_compromised_faction_key_cannot_mint() {
    let mut w = setup();
    as_(VANGUARD);
    w.apply_flows("steal".into(), vec![flow(VANGUARD, "credits", 50_000)], vec![]);
}

#[test]
#[should_panic(expected = "only the game server can do this")]
fn a_compromised_merchant_key_cannot_settle_raids() {
    let mut w = setup();
    as_(VEX);
    w.settle_raid("steal".into(), acc(VANGUARD), acc("accomplice.testnet"), "ammo".into(), U128(100), None);
}

#[test]
#[should_panic(expected = "only the game server can do this")]
fn a_compromised_agent_cannot_register_accomplices() {
    let mut w = setup();
    as_(VEX);
    w.register_player(acc("accomplice.testnet"));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn an_agent_function_call_key_cannot_move_tokens_directly() {
    // Function-call keys cannot attach a deposit, so a leaked agent key cannot call
    // NEP-245 transfers at all.
    let mut w = setup();
    as_(VANGUARD);
    w.mt_transfer(acc(VEX), "credits".into(), U128(1_000), None, None);
}

#[test]
#[should_panic(expected = "receiver is not a registered holder")]
fn tokens_cannot_be_sprayed_to_unregistered_accounts() {
    let mut w = setup();
    as_with_yocto(VANGUARD);
    w.mt_transfer(acc("stranger.testnet"), "ammo".into(), U128(1), None, None);
}

#[test]
#[should_panic(expected = "the server and the contract are not actors")]
fn the_server_cannot_make_itself_an_actor() {
    let mut w = setup();
    as_(SERVER);
    w.register_actor(acc(SERVER), Role::Faction);
}

// ── transfer_call resolution ─────────────────────────────────────────────────

fn resolve_with(w: &mut World, result: PromiseResult, amount: u128) -> Vec<U128> {
    testing_env!(
        ctx(CONTRACT).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
    w.mt_resolve_transfer(vec![acc(VANGUARD)], acc(VEX), vec!["ammo".into()], vec![U128(amount)])
}

#[test]
fn transfer_call_refunds_what_the_receiver_returns() {
    let mut w = setup();
    as_with_yocto(VANGUARD);
    let _ = w.mt_transfer_call(acc(VEX), "ammo".into(), U128(10), None, None, "deposit".into());
    assert_eq!(bal(&w, VEX, "ammo"), 110);
    let unused = near_sdk::serde_json::to_vec(&vec![U128(4)]).unwrap();
    let kept = resolve_with(&mut w, PromiseResult::Successful(unused), 10);
    assert_eq!(kept, vec![U128(6)]);
    assert_eq!((bal(&w, VANGUARD, "ammo"), bal(&w, VEX, "ammo")), (94, 106));
}

#[test]
fn transfer_call_refunds_everything_if_the_receiver_fails() {
    let mut w = setup();
    as_with_yocto(VANGUARD);
    let _ = w.mt_transfer_call(acc(VEX), "ammo".into(), U128(10), None, None, "".into());
    let kept = resolve_with(&mut w, PromiseResult::Failed, 10);
    assert_eq!(kept, vec![U128(0)]);
    assert_eq!(bal(&w, VANGUARD, "ammo"), 100);
}


#[test]
fn a_full_flow_batch_stays_under_the_log_limit() {
    let mut w = setup();
    as_(SERVER);
    let mints = (0..MAX_FLOWS).map(|_| flow(VANGUARD, "ammo", MAX_AMOUNT)).collect();
    w.apply_flows("full".into(), mints, vec![]);
    let total: usize = get_logs().iter().map(|l| l.len()).sum();
    assert!(total < 16_384 / 2, "logs {total} bytes leave headroom under the 16 KB receipt limit");
}

// ── migration freeze ─────────────────────────────────────────────────────────

#[test]
fn freezing_keeps_balances_readable_and_refuses_every_settlement() {
    let mut w = setup();
    as_(SERVER);
    w.freeze();
    assert!(w.is_frozen());
    assert_eq!(bal(&w, VANGUARD, "ammo"), 100, "balances stay readable for the migration snapshot");
    let attempts: Vec<Box<dyn Fn(&mut World)>> = vec![
        Box::new(|w| w.settle_raid("1".into(), acc(VANGUARD), acc(PLAYER), "ammo".into(), U128(1), None)),
        Box::new(|w| w.apply_flows("f".into(), vec![flow(VANGUARD, "ammo", 1)], vec![])),
        Box::new(|w| w.register_player(acc(PLAYER))),
    ];
    for f in attempts {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&mut w)));
        assert!(r.is_err());
    }
    as_(VEX);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| w.post_offer("q".into(), acc(VANGUARD), "ammo".into(), U128(1), U128(1), 60))).is_err());
    as_with_yocto(VANGUARD);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| w.mt_transfer(acc(VEX), "ammo".into(), U128(1), None, None))).is_err());
}

#[test]
#[should_panic(expected = "only the game server can do this")]
fn only_the_owner_can_freeze() {
    let mut w = setup();
    as_(VANGUARD);
    w.freeze();
}
