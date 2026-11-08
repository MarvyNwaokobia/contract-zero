# NEAR integration

CONTRACT ZERO settles its economy on **NEAR testnet** through two contracts, each with its own authority:

- **cz-assets** ([`contracts-near/cz-assets`](../../contracts-near/cz-assets)): the NEP-245 ledger. It holds every balance and moves value. It accepts value-moving calls only from its one controller, within daily issuance budgets, and records every controller operation ID so none can apply twice.
- **cz-world v2** ([`contracts-near/cz-world-v2`](../../contracts-near/cz-world-v2)): the game controller. It handles raids, flows, merchant offers and bids, and who may do what. It holds no balances. It asks cz-assets to settle, and a callback resolves each async outcome.

The first version, a single contract (**CZ World v1**, `world.contract-zero.testnet`), is **frozen**. Its verified history is kept below, and the migration is recorded in [`MIGRATION.md`](MIGRATION.md).

## Accounts

| Account | Role |
|---|---|
| `contract-zero.testnet` | Parent, and owner of `assets` and `world2` |
| **`assets.contract-zero.testnet`** | **cz-assets**: NEP-245 ledger. Code `5o8uRxxLcHzC7vqYMRRDhr5AHSEcwCLsfbRD6EW2LU3L` |
| **`world2.contract-zero.testnet`** | **cz-world v2**: the game controller, and the only controller of `assets`. Code `2mxwU9PEbYbDuvsunxkPGBwcXPL88FPkpkgxVYLxUp5W`. Upgraded in place, with state unchanged each time: `6c4sHyPg…` → `8ne76NEq…` (accepting a quote registers a new player's ledger storage) → `2mxwU9PE…` (quick-trade sessions, [`7dkJtkBg…`](https://testnet.nearblocks.io/txns/7dkJtkBgVvwRmAp8QpgXQAVhuzP8Ejyyr9uJzsTHQwwN)) |
| `cz-relayer-9abaff.testnet` | Gas relayer for players' signed delegate actions (quick-trade setup and sign-out) and for sponsoring new NEAR Auth accounts. Holds a gas float, no game assets. See [AUTH.md](AUTH.md) |
| `server.contract-zero.testnet` | The game server: settles raids and applies flows |
| `vanguard.contract-zero.testnet` | The Vanguard commander (a faction actor) |
| `vex.contract-zero.testnet` | The Vex merchant (a merchant actor) |
| `world.contract-zero.testnet` | CZ World v1, **frozen** (code `66e5xsBm1WpwtmuDhPLBxzXTRGg5ZDGHTyRz9knnvKcJ`) |
| `player.contract-zero.testnet` | A test player ([created](https://testnet.nearblocks.io/txns/FUErvSMYZJF9CBPQEMvdzv9vdjELTJAG29cKzgjwU8Dv) so the raid cargo it already held is now owned by a real account). Its keys play the part of a wallet in `scripts/exchange-e2e.mjs` |

Each code hash matches the SHA-256 (base58) of the local `cargo near build non-reproducible-wasm` output.

## Keys

No key is in the repository.

- **Full-access keys** stay in the CLI's `~/.near-credentials` (mode 600). They're used only for account administration.
- **The running game** uses one function-call key per actor, restricted to `world2.contract-zero.testnet` and to that actor's methods. These keys live in `~/.contract-zero/keys/v2` (mode 600). `scripts/near-keygen.mjs` generated them and prints only the public key. The v1 keys were deleted during the migration.

| Account | Function-call key | Allowed methods |
|---|---|---|
| server | `ed25519:9hg6yCxYWuejzhwN23pmootDAe3ZyrDXU5bbo4WqMyAB` | `settle_raid`, `apply_flows` |
| vanguard | `ed25519:EVB73ozU…` | `accept_offer`, `accept_bid` |
| vex | `ed25519:7CUkGTCt…` | `post_offer`, `post_bid`, `cancel_quote` |
| *a player's quick-trade key* | generated in their browser | `accept_offer`, `accept_bid`, `revoke_session`, held to the budgets and expiry the player registered on `world2` ([AUTH.md](AUTH.md)) |

The test player holds a key of the kind a wallet grants: `ed25519:B92fjTuZ…`, limited to `world2`'s `accept_offer` and `accept_bid` ([added](https://testnet.nearblocks.io/txns/4Bsm6P2hcEZeoA1rbYxo21YVCtVcnDtZxRcWa4hRSr3G)). It's stored in `~/.contract-zero/keys/players/`. Real players sign with their own wallet, and the server never holds a player key.

None of these keys can call `assets` at all. Value moves only when `world2` asks `assets` to move it, and only within the rules `world2` enforces. Under those rules:
- a quote can be accepted only by the counterparty it names;
- a seller never receives less than its floor, and a buyer never pays more than its ceiling;
- raid cargo goes only to players, never to actors.

The LLM planner never sees a key. It proposes an action, the engine validates it, and the server signs with the actor's restricted key.

## How the API settles

The economy commits a change first, then queues the matching on-chain operation in Postgres (`settlements`, tagged with the controller it targets). A worker submits each queued operation and marks it `confirmed` only after it re-fetches every transaction at FINAL over RPC and checks three things:
- the final status is `SuccessValue`;
- no receipt failed;
- the controller's callback did not return `false` (the ledger refused the operation).

| Economy event | On chain |
|---|---|
| Raid extracted | server `settle_raid` → `assets.controller_settle`: the faction's depot pays the player |
| Agent buys from Vex | vex `post_offer` (attempt-scoped ID) → agent `accept_offer(max_total)` → atomic two-leg `controller_settle` |
| Agent sells to Vex | vex `post_bid` → agent `accept_bid(min_total)` → atomic two-leg `controller_settle` |
| **Player** buys / sells (Exchange) | vex `post_offer` / `post_bid` addressed to the player → **the player's own wallet** signs `accept_offer` / `accept_bid` → `controller_register` (sponsored storage) + atomic `controller_settle`. The economy settles the quote only once `cz-assets` shows the operation applied. An unsigned quote is cancelled by Vex after its TTL |
| Income, upkeep, consumption | server `apply_flows` (batched, within the daily budget) |

**When a crash leaves an operation half-done,** the worker checks whether it actually applied by asking `assets.is_used("ctl:<op>")`. That flag is set only when value moved, so a cancelled or expired quote never counts as settled (the [v1 incident](MIGRATION.md#incident-found-during-migration-a-settlement-marked-confirmed-that-never-settled)).

**When a trade fails,** the worker cancels the quote. It retries under a new quote ID. If the trade finally gives up, the worker reverses it in the economy and marks it `compensated`, never `confirmed`.

`GET /reconciliation` compares every actor's engine balances with `assets` over RPC.

## Acceptance run on v2: raid → shortage → autonomous purchase → NEAR → next mission (2026-11-08)

**Setup:**
- `scripts/acceptance-e2e.mjs` runs against the live API on a fresh database (`WORLD_SCENARIO=acceptance`, `CZ_WORLD=world2…`, `CZ_ASSETS=assets…`).
- Balances are read back from `assets` over RPC.
- A step counts only when its settlement row is `confirmed`.

Each transaction was then checked again by a separate script (final status, callback value, failed receipts).

| Step | Evidence |
|---|---|
| Starting state, aligned on chain | Vanguard 100 ammo / 1,000 cr. Vex 100 ammo / 500 cr. Baseline [`EHwWjQt8…`](https://testnet.nearblocks.io/txns/EHwWjQt8Bx8sB2RSFpE1JHfQwMF3JVahJe138dAuZutu) (server `apply_flows`, final `Success(true)`) |
| Player raids the ammo depot (manifest 60, 5 rifle guards) | Mission session validated server-side; extracted after 37 s |
| Raid settled | [`AJTujuPH…`](https://testnet.nearblocks.io/txns/AJTujuPHdxbfwzmKyop8LzQjUqJCqEsams2oZScZHEEt) (server `settle_raid`; receipts on `world2` and `assets`; final `Success(true)`). On chain: **Vanguard 100 → 40 ammo**. `assets.is_used("ctl:raid:1") == true` |
| Commander decides on its own (one world tick) | "ammo below target": have 41 of 84, budget 740. Quoted Vex at 18 cr/unit and chose to "Buy 24 ammo for 517 credits (24 of the 43 short; that is all the budget or stock allows)." The engine accepted it |
| Vex offers (`trade-2-a1`) | [`GdziXaE9…`](https://testnet.nearblocks.io/txns/GdziXaE9tHAbcXyNtqs3LL4e4c7cdhEHBJCuLXjRQFdS) (vex `post_offer`) |
| **Vanguard buys** | [`GM9qTLTj…`](https://testnet.nearblocks.io/txns/GM9qTLTjFKk9gChis2ZTfz8qfN9hVwrSZNNH3quZs9Z) (vanguard `accept_offer`; receipts on `world2` and `assets`; final `Success(true)`). One `mt_transfer` event with both legs: 24 ammo Vex → Vanguard and 517 credits Vanguard → Vex. `assets.is_used("ctl:offer:trade-2-a1") == true` |
| Reconciled | `in_sync: true`. Engine and chain match exactly: Vanguard 65 ammo / 523 cr / 98 fuel / 30 med; Vex 76 ammo / 1,017 cr / 60 fuel / 50 med |
| Next mission changed | Before the raid: ammo depot with 5 deployed guards (5 rifles), defense L2, manifest 60. **Now: defense L3 (11 planned), 4 deployed (3 rifles, 1 sidearm), manifest 39** |

The player's ledger balance is 120 ammo: 60 migrated from v1 plus 60 from this raid.

**Not yet exercised on testnet.** Each item below is implemented and unit-tested but hasn't run live:
- **(Fixed during the Exchange work.)** The world clock queued only agent *purchases* for settlement, so an agent sale would have stayed off chain. It now queues both.
- **The bid path** (the commander selling surplus to Vex): economy policy tests, plus `cz-world-v2` bid tests. It triggers only when a faction holds more than twice its target, and that doesn't happen in the acceptance scenario.
- **The worker's retry and compensation path on v2.**

## Exchange run: the player sells, buys, and lets a quote lapse (2026-11-08)

`scripts/exchange-e2e.mjs` (`LAPSE=1`) ran against the live API with settlement on and the world clock running.
- The player signs with their own restricted key, built and sent with `near-api-js` exactly as a wallet would. The server only posts and cancels Vex's quotes.
- After each trade, the script checks every leg on chain and checks that the player's engine balances equal their chain balances.
- Each transaction was then checked again separately (final status, callback value, failed receipts).

| Step | Evidence |
|---|---|
| Starting point | The player owns 120 ammo on chain: 60 migrated from v1, 60 raided on v2. The engine knew 60. The first quote resynced the other 60 across the `OUTSIDE` boundary |
| **Sell 30 ammo for 548 cr** | Vex `post_bid` [`62tfZnJx…`](https://testnet.nearblocks.io/txns/62tfZnJxG87C3njDbMwiH1vJzKN9zFKP48bssK4wQgC3). **The player signs** `accept_bid` [`4Kxu9JG3…`](https://testnet.nearblocks.io/txns/4Kxu9JG3gpVBYcSC6AHzASyCtFy7BLts5pt4JnSCb5tf) (receipts on `world2` and `assets`; final `Success(true)`). Player 120 → 90 ammo, 0 → 548 cr. Vex 76 → 106 ammo, 1,017 → 469 cr |
| **Buy 5 med for 242 cr** | Vex `post_offer` [`7JmWpLkd…`](https://testnet.nearblocks.io/txns/7JmWpLkd1cvRXncxMq3zPNGnD681gtKQ42FABjxNoBS2). **The player signs** `accept_offer` [`BMujWMxQ…`](https://testnet.nearblocks.io/txns/BMujWMxQ5zr93Z3SW4zXwj7MJwBtoY4rPHQvAQihXY5U) (final `Success(true)`). Player 548 → 306 cr, 0 → 5 med |
| A quote left unsigned | After its 5-minute TTL, Vex `cancel_quote` [`72LPNbej…`](https://testnet.nearblocks.io/txns/72LPNbejdAU6vZPLgb1hQ65cGgPyPY9VDxkMqurPWLsB). The hold was released, and Vex's balances were unchanged. An earlier abandoned bid was cleaned up the same way ([`BZQBjVXW…`](https://testnet.nearblocks.io/txns/BZQBjVXWVAdsvugttTjYD7HWn4Dviab95CmbA8U4zHFo)) |
| Reconciled | Player: engine = chain (90 ammo, 306 cr, 5 med). Vex: no difference. Vanguard differed only by 14 world-clock ledger entries not yet mirrored. After the next flow sync, `GET /reconciliation` was `in_sync: true`, with 0 unsynced entries, 0 open settlements, and no difference for Vanguard or Vex |

**Gas.** An accept burns about 10 TGas. The player attaches 60 TGas, which covers the controller's 50 TGas of follow-up calls. Prepaid gas is reserved from the player's balance up front (about 0.06 NEAR) and mostly refunded.

## History: CZ World v1 (frozen)

v1 was one contract that held balances and game logic together. Everything below was verified on testnet before it was frozen. The same acceptance sequence passed on v1 (raid [`FqMfQZ2C…`](https://testnet.nearblocks.io/txns/FqMfQZ2CGz2Gm6tBmUrFpxrEgwXBNHCucjtbXzym8XSZ), offer [`444Mctay…`](https://testnet.nearblocks.io/txns/444MctayLz9g9SMdZ7eUmf4Mw3nyjK6PyVCPovfhmTJC), purchase [`D276igAR…`](https://testnet.nearblocks.io/txns/D276igARNKFQ5EZJMf6uzLBirxtyLGRNNaeQ714SowJX)), with the same balances and the same changed mission.

| Step | Signer | Transaction |
|---|---|---|
| Register Vanguard as a faction | server | [`E4cMVES4…`](https://testnet.nearblocks.io/txns/E4cMVES4BPhuMqfgenP593D9UQeiGRz2KdDgVw3cYunU) |
| Register Vex as a merchant | server | [`C8kXMBif…`](https://testnet.nearblocks.io/txns/C8kXMBif79jQyPAwNisiRBdjpcBttuK4xSzBd7RjAxGB) |
| Mint the acceptance balances | server | [`6FK6PYrh…`](https://testnet.nearblocks.io/txns/6FK6PYrhz4o7t4Luq6jW4ee6Ysm6GNj6R7rzFEk9oQCu) |
| Vex offers 20 ammo for 360 credits | vex | [`5xzJ3nYt…`](https://testnet.nearblocks.io/txns/5xzJ3nYt6BSr9eMu7seLFkvJMQTEnojadahpnJZizzmp) |
| Vanguard accepts (two `mt_transfer` events) | vanguard | [`89KjjFvE…`](https://testnet.nearblocks.io/txns/89KjjFvEA6xRrpt12wau6QYZTmXsczo3hm1B5Noz1UPv) |
| Replay of the acceptance | — | Failed on chain: "no such offer" ([`A4Hs1SV1…`](https://testnet.nearblocks.io/txns/A4Hs1SV1toXLNmMMkBuEXPFkE1btKWGDGduJcg7jr8d8)) |
| Vanguard's key calls `post_offer` / Vex's key calls `settle_raid` | — | Rejected before execution: "method name isn't allowed by the access key" |

## Rebuild and test

```bash
cd contracts-near/cz-assets   && cargo test && cargo near build non-reproducible-wasm   # 28 tests
cd contracts-near/cz-world-v2 && cargo test && cargo near build non-reproducible-wasm   # 21 tests
cd contracts-near/cz-world    && cargo test                                            # v1, 51 tests
```

`MIGRATION.md` gives the deploy and initialization steps.
