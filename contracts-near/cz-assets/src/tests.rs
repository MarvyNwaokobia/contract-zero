use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult};

const ASSETS: &str = "assets.contract-zero.testnet";
const OWNER: &str = "contract-zero.testnet";
const CONTROLLER: &str = "world2.contract-zero.testnet";
const SERVER: &str = "server.contract-zero.testnet";
const VANGUARD: &str = "vanguard.contract-zero.testnet";
const VEX: &str = "vex.contract-zero.testnet";
const PLAYER: &str = "player.contract-zero.testnet";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

/// `predecessor` calls this contract in a transaction signed by `signer`.
fn ctx(predecessor: &str, signer: &str) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(signer))
        .current_account_id(acc(ASSETS))
        .block_timestamp(1_000_000_000_000)
        .prepaid_gas(Gas::from_tgas(300));
    b
}

fn as_(predecessor: &str, signer: &str) {
    testing_env!(ctx(predecessor, signer).build());
}

/// The controller, in a transaction the server signed.
fn as_server_via_controller() {
    as_(CONTROLLER, SERVER);
}

fn flow(a: &str, t: &str, n: u128) -> Flow {
    Flow { account_id: acc(a), token_id: t.into(), amount: U128(n) }
}

fn leg(from: &str, to: &str, t: &str, n: u128) -> Leg {
    Leg { from: acc(from), to: acc(to), token_id: t.into(), amount: U128(n) }
}

fn setup() -> Assets {
    as_(OWNER, OWNER);
    let mut a = Assets::new(acc(OWNER), 2);
    a.set_controller(acc(CONTROLLER));
    a.register_actor(acc(VANGUARD));
    a.register_actor(acc(VEX));
    for t in BASE_TOKENS {
        a.set_epoch_budget(t.into(), U128(10_000));
    }
    as_server_via_controller();
    a.controller_mint_burn("genesis".into(), vec![flow(VANGUARD, "ammo", 100), flow(VANGUARD, "credits", 1_000), flow(VEX, "ammo", 100), flow(VEX, "credits", 500)], vec![]);
    a
}

fn bal(a: &Assets, who: &str, t: &str) -> u128 {
    a.mt_balance_of(acc(who), t.into()).0
}

// ── controller authority ─────────────────────────────────────────────────────

#[test]
fn atomic_trade_between_actors() {
    let mut a = setup();
    as_server_via_controller();
    a.controller_settle("offer:q1".into(), vec![leg(VEX, VANGUARD, "ammo", 24), leg(VANGUARD, VEX, "credits", 517)]);
    assert_eq!((bal(&a, VANGUARD, "ammo"), bal(&a, VANGUARD, "credits")), (124, 483));
    assert_eq!((bal(&a, VEX, "ammo"), bal(&a, VEX, "credits")), (76, 1_017));
    let ev: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(get_logs()[0].trim_start_matches("EVENT_JSON:")).unwrap();
    assert_eq!(ev["event"], "mt_transfer");
    assert_eq!(ev["data"].as_array().unwrap().len(), 2, "one event carries both legs");
    assert_eq!(ev["data"][0]["authorized_id"], CONTROLLER);
}

#[test]
#[should_panic(expected = "insufficient balance")]
fn a_trade_with_one_unpayable_leg_moves_nothing() {
    let mut a = setup();
    as_server_via_controller();
    a.controller_settle("offer:q".into(), vec![leg(VEX, VANGUARD, "ammo", 24), leg(VANGUARD, VEX, "credits", 5_000)]);
}

#[test]
fn a_raid_moves_actor_cargo_to_a_registered_player() {
    let mut a = setup();
    as_server_via_controller();
    a.controller_register(acc(PLAYER));
    a.controller_settle("raid:1".into(), vec![leg(VANGUARD, PLAYER, "ammo", 60)]);
    assert_eq!(bal(&a, VANGUARD, "ammo"), 40);
    assert_eq!(bal(&a, PLAYER, "ammo"), 60);
    assert_eq!(a.sponsored_remaining(), 1);
}

#[test]
#[should_panic(expected = "a leg may only debit an actor or the transaction signer")]
fn the_server_cannot_spend_a_players_holdings() {
    let mut a = setup();
    as_server_via_controller();
    a.controller_register(acc(PLAYER));
    a.controller_settle("raid:1".into(), vec![leg(VANGUARD, PLAYER, "ammo", 60)]);
    // A server-signed transaction tries to take the player's ammo for Vex.
    a.controller_settle("forged".into(), vec![leg(PLAYER, VEX, "ammo", 60)]);
}

#[test]
fn a_player_can_spend_their_own_holdings_when_they_signed() {
    let mut a = setup();
    as_server_via_controller();
    a.controller_register(acc(PLAYER));
    a.controller_settle("raid:1".into(), vec![leg(VANGUARD, PLAYER, "ammo", 60)]);
    // The player signs accept_bid on the controller: they sell 30 ammo to Vex.
    as_(CONTROLLER, PLAYER);
    a.controller_settle("bid:b1".into(), vec![leg(PLAYER, VEX, "ammo", 30), leg(VEX, PLAYER, "credits", 400)]);
    assert_eq!((bal(&a, PLAYER, "ammo"), bal(&a, PLAYER, "credits")), (30, 400));
}

#[test]
#[should_panic(expected = "only the controller can do this")]
fn nobody_but_the_controller_settles() {
    let mut a = setup();
    as_(SERVER, SERVER);
    a.controller_settle("x".into(), vec![leg(VANGUARD, VEX, "ammo", 1)]);
}

#[test]
#[should_panic(expected = "only the controller can do this")]
fn an_agent_cannot_mint() {
    let mut a = setup();
    as_(VANGUARD, VANGUARD);
    a.controller_mint_burn("steal".into(), vec![flow(VANGUARD, "credits", 1)], vec![]);
}

#[test]
#[should_panic(expected = "receiver is not registered")]
fn tokens_only_go_to_registered_accounts() {
    let mut a = setup();
    as_server_via_controller();
    a.controller_settle("raid:1".into(), vec![leg(VANGUARD, "stranger.testnet", "ammo", 1)]);
}

// ── issuance ─────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "mints and burns apply only to registered actors")]
fn the_controller_cannot_mint_to_players() {
    let mut a = setup();
    as_server_via_controller();
    a.controller_register(acc(PLAYER));
    a.controller_mint_burn("x".into(), vec![flow(PLAYER, "credits", 10)], vec![]);
}

#[test]
#[should_panic(expected = "epoch issuance budget exceeded")]
fn issuance_is_capped_per_epoch() {
    let mut a = setup();
    as_server_via_controller();
    // 1,000 + 500 credits already minted this epoch; the budget is 10,000.
    a.controller_mint_burn("a".into(), vec![flow(VANGUARD, "credits", 8_500)], vec![]);
    a.controller_mint_burn("b".into(), vec![flow(VANGUARD, "credits", 1)], vec![]);
}

#[test]
fn the_epoch_budget_resets_after_a_day() {
    let mut a = setup();
    as_server_via_controller();
    a.controller_mint_burn("a".into(), vec![flow(VANGUARD, "credits", 8_500)], vec![]);
    testing_env!(ctx(CONTROLLER, SERVER).block_timestamp(1_000_000_000_000 + EPOCH_NS + 1).build());
    a.controller_mint_burn("b".into(), vec![flow(VANGUARD, "credits", 9_000)], vec![]);
    assert_eq!(a.token_info("credits".into()).unwrap().minted_this_epoch, U128(9_000));
}

#[test]
#[should_panic(expected = "epoch issuance budget exceeded")]
fn an_unbudgeted_token_cannot_be_minted() {
    let mut a = setup();
    as_(OWNER, OWNER);
    a.register_token("gun:smg".into(), "Compact SMG".into(), "".into(), U128(0));
    as_server_via_controller();
    a.controller_mint_burn("x".into(), vec![flow(VEX, "gun:smg", 1)], vec![]);
}

#[test]
fn burns_destroy_supply_and_emit_mt_burn() {
    let mut a = setup();
    as_server_via_controller();
    a.controller_mint_burn("ops".into(), vec![], vec![flow(VANGUARD, "ammo", 24)]);
    assert_eq!(a.mt_supply("ammo".into()), Some(U128(176)));
    assert!(get_logs()[0].contains("\"event\":\"mt_burn\""));
}

#[test]
#[should_panic(expected = "amount over the per-operation limit")]
fn single_amounts_are_bounded() {
    let mut a = setup();
    as_server_via_controller();
    a.controller_settle("x".into(), vec![leg(VANGUARD, VEX, "ammo", MAX_AMOUNT + 1)]);
}

// ── replay ───────────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "operation already applied")]
fn controller_operations_apply_once() {
    let mut a = setup();
    as_server_via_controller();
    a.controller_settle("offer:q1".into(), vec![leg(VEX, VANGUARD, "ammo", 1)]);
    a.controller_settle("offer:q1".into(), vec![leg(VEX, VANGUARD, "ammo", 1)]);
}

#[test]
#[should_panic(expected = "operation already applied")]
fn mint_batches_apply_once() {
    let mut a = setup();
    as_server_via_controller();
    a.controller_mint_burn("genesis".into(), vec![flow(VEX, "ammo", 1)], vec![]);
}

// ── owner, import, pause ─────────────────────────────────────────────────────

#[test]
fn v1_balances_import_once_then_seal() {
    let mut a = setup();
    as_(OWNER, OWNER);
    a.import_balances("v1-0".into(), vec![flow(PLAYER, "ammo", 60)]);
    assert_eq!(bal(&a, PLAYER, "ammo"), 60);
    assert!(a.storage_balance_of(acc(PLAYER)).is_some(), "imported holders are registered");
    a.seal_import();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| a.import_balances("v1-1".into(), vec![flow(PLAYER, "ammo", 1)])));
    assert!(r.is_err(), "the window is closed");
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn the_controller_cannot_import() {
    let mut a = setup();
    as_server_via_controller();
    a.import_balances("x".into(), vec![flow(PLAYER, "credits", 1_000_000)]);
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn the_server_cannot_raise_budgets() {
    let mut a = setup();
    as_(SERVER, SERVER);
    a.set_epoch_budget("credits".into(), U128(u128::MAX));
}

#[test]
#[should_panic(expected = "the ledger is paused")]
fn a_paused_ledger_refuses_settlement() {
    let mut a = setup();
    as_(OWNER, OWNER);
    a.set_paused(true);
    as_server_via_controller();
    a.controller_settle("x".into(), vec![leg(VEX, VANGUARD, "ammo", 1)]);
}

#[test]
#[should_panic(expected = "no sponsored registrations left")]
fn sponsorship_is_bounded() {
    let mut a = setup();
    as_server_via_controller();
    a.controller_register(acc("p1.testnet"));
    a.controller_register(acc("p2.testnet"));
    a.controller_register(acc("p3.testnet"));
}

// ── NEP-145 ──────────────────────────────────────────────────────────────────

#[test]
fn storage_deposit_registers_a_player() {
    let mut a = setup();
    testing_env!(ctx(PLAYER, PLAYER).attached_deposit(STORAGE_DEPOSIT).build());
    let b = a.storage_deposit(None, None);
    assert_eq!(b.total, U128(STORAGE_DEPOSIT.as_yoctonear()));
    assert_eq!(a.storage_balance_bounds().min, U128(STORAGE_DEPOSIT.as_yoctonear()));
    assert!(a.storage_balance_of(acc(PLAYER)).is_some());
}

#[test]
#[should_panic(expected = "attach at least the minimum storage deposit")]
fn storage_deposit_requires_the_minimum() {
    let mut a = setup();
    testing_env!(ctx(PLAYER, PLAYER).attached_deposit(NearToken::from_yoctonear(1)).build());
    a.storage_deposit(None, None);
}

// ── NEP-245 ──────────────────────────────────────────────────────────────────

#[test]
fn holders_transfer_with_one_yocto_and_metadata_describes_tokens() {
    let mut a = setup();
    testing_env!(ctx(VANGUARD, VANGUARD).attached_deposit(NearToken::from_yoctonear(1)).build());
    a.mt_transfer(acc(VEX), "ammo".into(), U128(5), None, None);
    assert_eq!(bal(&a, VEX, "ammo"), 105);
    assert_eq!(a.mt_metadata_contract().spec, "mt-1.0.0");
    let m = a.mt_metadata_token_all(vec!["ammo".into(), "nope".into()]);
    assert_eq!(m[0].as_ref().unwrap().base.id, "ammo");
    assert!(m[1].is_none());
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn transfers_without_one_yocto_are_refused() {
    let mut a = setup();
    as_(VANGUARD, VANGUARD);
    a.mt_transfer(acc(VEX), "ammo".into(), U128(1), None, None);
}

fn resolve(a: &mut Assets, r: PromiseResult) -> Vec<U128> {
    testing_env!(ctx(ASSETS, VANGUARD).build(), near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), vec![r]);
    a.mt_resolve_transfer(vec![acc(VANGUARD)], acc(VEX), vec!["ammo".into()], vec![U128(10)])
}

#[test]
fn transfer_call_refunds_what_the_receiver_returns() {
    let mut a = setup();
    testing_env!(ctx(VANGUARD, VANGUARD).attached_deposit(NearToken::from_yoctonear(1)).build());
    let _ = a.mt_transfer_call(acc(VEX), "ammo".into(), U128(10), None, None, "".into());
    let kept = resolve(&mut a, PromiseResult::Successful(near_sdk::serde_json::to_vec(&vec![U128(4)]).unwrap()));
    assert_eq!(kept, vec![U128(6)]);
    assert_eq!(bal(&a, VANGUARD, "ammo"), 94);
}

#[test]
fn transfer_call_refunds_everything_when_the_receiver_fails() {
    let mut a = setup();
    testing_env!(ctx(VANGUARD, VANGUARD).attached_deposit(NearToken::from_yoctonear(1)).build());
    let _ = a.mt_transfer_call(acc(VEX), "ammo".into(), U128(10), None, None, "".into());
    assert_eq!(resolve(&mut a, PromiseResult::Failed), vec![U128(0)]);
    assert_eq!(bal(&a, VANGUARD, "ammo"), 100);
}

#[test]
fn equipment_tokens_can_be_registered_and_minted_within_budget() {
    let mut a = setup();
    as_(OWNER, OWNER);
    a.register_token("gun:assault_rifle".into(), "Assault Rifle".into(), "Tier 3".into(), U128(10));
    as_server_via_controller();
    a.controller_mint_burn("stock".into(), vec![flow(VEX, "gun:assault_rifle", 3)], vec![]);
    assert_eq!(bal(&a, VEX, "gun:assault_rifle"), 3);
    assert!(a.tokens().contains(&"gun:assault_rifle".to_string()));
}
