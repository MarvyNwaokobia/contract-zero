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
| **`world2.contract-zero.testnet`** | **cz-world v2**: the game controller, and the only controller of `assets`. Code `2ncNvQimwaEetX948nGFHyKy3rpuVobNyEvhK8AqjHUs`. Upgraded in place, with state unchanged each time: `6c4sHyPg…` → `8ne76NEq…` (accepting a quote registers a new player's ledger storage) → `2mxwU9PE…` (quick-trade sessions, [`7dkJtkBg…`](https://testnet.nearblocks.io/txns/7dkJtkBgVvwRmAp8QpgXQAVhuzP8Ejyyr9uJzsTHQwwN)) → `2ncNvQim…` (`settle_operation` for sabotage and recovery, [`8xFWew5s…`](https://testnet.nearblocks.io/txns/8xFWew5sydNAExyXM2DmZtGazr8rRR44nK3hTEfKLC9T)) |
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
| server | `ed25519:2Vp55RZXdz6iJifKDqtVzuFc1X1fJo4HYVQ3MZve5ApC` ([added](https://testnet.nearblocks.io/txns/H2C2k9AcAdGWt23xhowCfjsPYG81MS7BscbHL13h6eps); the previous `9hg6yCxY…` was [deleted](https://testnet.nearblocks.io/txns/9K64CbkJ3QXqhp2TJwxRkzJo9x3XvqDUeeaMr1LTiZWX)) | `settle_raid`, `apply_flows`, `settle_operation` |
| vanguard | `ed25519:EVB73ozU…` | `accept_offer`, `accept_bid` |
| vex | `ed25519:7CUkGTCt…` | `post_offer`, `post_bid`, `cancel_quote` |
| *a player's quick-trade key* | generated in their browser | `accept_offer`, `accept_bid`, `place_order`, `accept_proposal`, `cancel_order`, `revoke_session` (1 NEAR gas allowance), held to the budgets and expiry the player registered on `world2` ([AUTH.md](AUTH.md)) |

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

## Sabotage on testnet (2026-11-08)

`scripts/operations-e2e.mjs` ran against the live API on the `genesis` world.
- **The contract came from the merchant agent.** Holding 209 ammo against a target of 120 while Vanguard makes its own, Vex posted a 435 cr contract to knock out Vanguard's ammo line.
- **A signed-in player ran the operation:** two charges, extracted after 36 s (the server's minimum is 35 s).

| Step | Evidence |
|---|---|
| Stock destroyed | 75 ammo burned from Vanguard in a flow batch ([`B84YEUpf…`](https://testnet.nearblocks.io/txns/B84YEUpfNpLFqzsMLs9AqoTXwr8uEoNYAy35fjq3MhhQ)) |
| Fee paid | `settle_operation`: Vex → player, 435 credits ([`3NRa6gCL…`](https://testnet.nearblocks.io/txns/3NRa6gCLDTp5nr75u3qbvJX3BsqXVbTfKoyEkwvxaYLv)), final `Success(true)`. On chain the player went 65 → 500 cr and Vex 2,207 → 1,772 cr |
| Consequence | Vanguard's ammo production is down for 36 ticks (`disrupted: true` on the board). The next ammo depot fields 7 of 15 guards: "8 stayed home (not enough ammunition)" |

Recovery settles through the same `settle_operation`, with an extra faction → merchant cargo leg. That leg is covered by contract and economy tests, but hasn't run live yet: it needs Vanguard to seize a caravan, which happens only in a squeezed, raided world.

## Supply orders on chain: `world2` v2.3 (2026-11-09)

`world2` gained supply orders: an escrow-funded intent that merchants answer with proposals on chain. The design is in [INTENTS.md](INTENTS.md).
- **Upgraded in place.** State is unchanged; the new collections are created on demand.
- **New code hash:** `BgrQgAJ9pxUMaurGgUumCsa653F1CWEyAhXPD5EpWEQC`, which matches the local `cargo near build non-reproducible-wasm` built with the stable toolchain.

| Step | Transaction |
|---|---|
| Storage for the larger code (0.7 NEAR, Vex → `world2`) | [`5Srnf5py…`](https://testnet.nearblocks.io/txns/5Srnf5pyHEct7AmC5MzaRz8XcnSaJX5AnCP7kwm1E9Ls) |
| Deploy v2.3 | [`D8xPBJG9…`](https://testnet.nearblocks.io/txns/D8xPBJG9tWkQbH1ymYdeVYTpyF4isCx9dsc6xRXrMePp) |
| `assets.register_actor(world2)`, so the controller can hold order escrow | [`GMbcHqC5…`](https://testnet.nearblocks.io/txns/GMbcHqC5DzgQLaH67rmdx2AHELGfZFCoDtCb4spMvgSL) |
| Create `halcyon.contract-zero.testnet`, the second merchant | [`C5FZqPxb…`](https://testnet.nearblocks.io/txns/C5FZqPxbDRrUEWcz4mgLH499b335nDjEciQPj2tzV1hb) |
| `world2.register_actor(halcyon, Merchant)` | [`C1e1khfy…`](https://testnet.nearblocks.io/txns/C1e1khfy2Khx9zxaMWrr7Lc998fTiwF52y9i4SkwFsHc) |
| `assets.register_actor(halcyon)` | [`4cYEu4Wm…`](https://testnet.nearblocks.io/txns/4cYEu4WmkqF7JtAoX7wWWZXNdNcjSMkdhCzsFtuV4kjU) |
| v3 function-call keys: Vanguard, Ashen, Vex, Halcyon | [`8HLSZHGF…`](https://testnet.nearblocks.io/txns/8HLSZHGFGWiL7RAESNY3ZneGenZUBexJWk5JMJAeu9HP), [`4VbHvbVu…`](https://testnet.nearblocks.io/txns/4VbHvbVubGx2Nau4depfAAVhozfMXMSE8hMSBDBHaJ7L), [`DWuYvZnU…`](https://testnet.nearblocks.io/txns/DWuYvZnUM7y1bdTuU82MbCVdiJaamUnP3ky1hjiu32rg), [`GFqmoAVq…`](https://testnet.nearblocks.io/txns/GFqmoAVqGShxYdPPVG4zR6XftJjykWzeicPrafSwMnpd) |

**The v3 keys** live in `~/.contract-zero/keys/v3` (mode 600). Each is limited to `world2`:
- **Factions:** `accept_offer`, `accept_bid`, `place_order`, `accept_proposal`, `cancel_order`, `expire_order` and `retry_refund`.
- **Merchants:** `post_offer`, `post_bid`, `cancel_quote`, `propose`, `expire_order` and `retry_refund`.

**Smoke test** (`node scripts/orders-smoke.mjs`), which nets to zero:
1. Vanguard `place_order` [`BAub3jHC…`](https://testnet.nearblocks.io/txns/BAub3jHCGw6hZHVQe4J71iTvSBJYsoB1mQ1rvGRd1Vao): Vanguard's credits went from 13,573 to 13,423, and `world2`'s escrow to 150.
2. Vex `propose` [`G2gqeypP…`](https://testnet.nearblocks.io/txns/G2gqeypP8xtbPJXmCjfRHJe9uwaFQPCN3CVso3yiai9b): 5 ammunition for 140 credits.
3. Vanguard `cancel_order` [`9cpAJG3Z…`](https://testnet.nearblocks.io/txns/9cpAJG3Z3tVoVTn2TADJKEYXp8aFvkq6ujbsfQj9Tcvz): the order closed as `cancelled`, and both balances returned exactly (13,573 and 0).

**v2.4 (same day).**
- **Storage stop.** Live load showed that storage grows with every order. `world2` ran out of NEAR for its own state (`LackBalanceForState`), which halted every settlement, ledger batches included. The fix had three parts:
  - **Funding:** a faucet-funded helper (`cz-fund-1794234663.testnet`, from the official testnet faucet) funded `world2` with 5 NEAR ([`BCWcTs1P…`](https://testnet.nearblocks.io/txns/BCWcTs1PziionetjjnHdckJN56SAeRYwXf6Qq6CiXFEh)) and each actor with 1 NEAR for gas ([`BHECjZ84…`](https://testnet.nearblocks.io/txns/BHECjZ84bx5affd3bTQbtpS23AQ2yveJpZn6QvySfZCj), [`AMDYQbnW…`](https://testnet.nearblocks.io/txns/AMDYQbnW26zCdDYsn2wRfAvmbpcy1rndDJuRtetkjY8p), [`B3gQM6zg…`](https://testnet.nearblocks.io/txns/B3gQM6zg8BJVugS2qwsrAJCjTzwti8AnpsBWd13Vvv1o), [`4bLKwzTH…`](https://testnet.nearblocks.io/txns/4bLKwzTHkeJTh9xUV1ogx5zGmzD8n8B8BkpCEYqsRvMS)).
  - **Contract:** v2.4 deletes a closed order's leftover proposals and caps an order at 16 proposals. Code hash `GUnt4fZNVRSvMJ9AJK5UHc6V8D9BnQbSX9AVXrbXS4u5`, deploy [`4bnLK3Wn…`](https://testnet.nearblocks.io/txns/4bnLK3Wnzjsatgt7wDLuhJuhX9Wtc9cKqtuh2EPjkE79), state unchanged.
  - **Commanders:** they stopped re-posting orders nobody answers (see [INTENTS.md](INTENTS.md)).
- **The ledger's storage.** The ledger itself (`assets`) then ran out of storage too. A second faucet helper (`cz-fund2-1794237513.testnet`) sent it 8 NEAR ([`E3xvUX5g…`](https://testnet.nearblocks.io/txns/E3xvUX5gzSw24qPEvmSXp1BN8SmYMvTtphfvmTds7ZQa)). One order's refund (`o1890`, Ashen, 524 credits) had failed during that outage. It was retried with `retry_refund` ([`tXjtdHMC…`](https://testnet.nearblocks.io/txns/tXjtdHMC61u1ZwPacapxiSR1EUF1KBAk7PS62LJDsVZ)), and reconciliation returned to exact. The worker now retries a stuck refund after any close, expiry or fill.
- **Halcyon's gas.** Halcyon was also topped up for gas ([`FkFvYKw4…`](https://testnet.nearblocks.io/txns/FkFvYKw4ZQwNPJwbMxfcrc1TXcUf5XMmsYtrMACiwhpz)).

**Without `wee_alloc` (RUSTSEC-2022-0054).** Both contracts were rebuilt with `near-sdk` `default-features = false` and redeployed in place, with state unchanged. A net-zero order smoke test passed on the new code (place, propose, cancel; escrow 150 in and returned exactly).
- **`assets`:** code `FMXGm9CwdXANTxdxgA67ewsiFLU2aq95xtkRvhN8VHoT`, deployed in [`2Y2Gkwov…`](https://testnet.nearblocks.io/txns/2Y2GkwovQFHFrGkyctkuQF97BqE8Piz6jZ5pmYffnLZx).
- **`world2`:** code `BLTKXSVCDpvovMdwK26c63WKxWjeeVy7PbF5LZ39B2YG`, deployed in [`GzsxuK8c…`](https://testnet.nearblocks.io/txns/GzsxuK8cVhoB8kiJt4MqNdRd68YKRbAGKQDmLVb73t1f).

## Repairing an out-of-order mirror

A long RPC outage left 129 flow batches failed. The old worker then skipped past them, so later batches applied first and an earlier one became impossible ("insufficient balance").

The changes:
- **Sends use `NEAR_RPC_URL`** with patient retries.
- **Only trades give up;** flows, raids and operations retry with backoff.
- **Alignment batches run first.**
- **`POST /admin/realign`** (admin token) replaces stranded flow batches with one exact alignment batch. Its target is the economy minus queued trades, so it lands without double-applying them. It refuses while a raid or operation is open.

This repaired the dev world: `realign` (6 mints, 1 burn), then the queue drained with 0 open settlements.

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
cd contracts-near/cz-world-v2 && cargo test && RUSTUP_TOOLCHAIN=stable cargo near build non-reproducible-wasm   # 58 tests
cd contracts-near/cz-world    && cargo test                                            # v1, 51 tests
```

`MIGRATION.md` gives the deploy and initialization steps.
