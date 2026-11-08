# Migration: CZ World v1 → cz-assets + cz-world v2

**Goal:** move every balance from the single v1 contract (`world.contract-zero.testnet`) to the split architecture:
- `assets.contract-zero.testnet`: the NEP-245 ledger
- `world2.contract-zero.testnet`: the game controller

**Invariants:**
- No balance is created or lost.
- v1 and v2 can never both settle the same economic event.
- v1's verified history stays intact on chain.

## Why the old and new contracts can't double-settle

1. **v1 is frozen before the snapshot.** `freeze()` sets a raw storage flag, and every v1 method that moves value or changes state then panics. Only views and `mt_resolve_transfer` (which completes an in-flight transfer) still work.
2. **The settlement queue is drained before the freeze.** Every row is `confirmed`, and none is `pending` or `submitted`.
3. **Each queue row records its contract.** Rows created before migration are tagged with v1, and the worker only processes rows for the configured controller. A v1 row can never be submitted to v2, or the reverse.
4. **v2 has its own replay sets** (in `cz-world` v2 and independently in `cz-assets`), and v1 is inert. An operation ID reused across versions can't move value twice.

## Procedure

| # | Step | Signer | Verification |
|---|---|---|---|
| 0 | Stop the API (settlement worker and world clock) | — | No API process running |
| 1 | Check the queue is drained | — | `SELECT status, count(*) FROM settlements`: everything `confirmed` |
| 2 | Build and test all three contracts | — | `cargo test` in each crate; record each wasm's SHA-256 (bs58) |
| 3 | Upgrade v1 in place with the freeze code (no init; state layout unchanged) | world (full access) | The v1 code hash equals the new build; balances unchanged |
| 4 | `freeze()` v1 | server (full access; the restricted key doesn't allow it) | `is_frozen() == true`; a test `settle_raid` is refused |
| 5 | Consolidate funds for the new accounts | own accounts | Balances via `view_account` |
| 6 | Create `assets` and `world2` and deploy them | parent | Code hashes equal the builds |
| 7 | Initialize `assets` (owner = parent), set controller = `world2`, register Vanguard and Vex, set issuance budgets | parent | Views: `controller`, `is_actor`, `token_info` |
| 8 | Initialize `world2` (owner = parent, server, assets) and register roles | parent | `config()`, `role_of` |
| 9 | Snapshot v1. Holders are every actor plus every account the server paid through `settle_raid`, taken from the settlement log | — | **For every token, the sum of the snapshot equals v1's `mt_supply`.** A missed holder would break this |
| 10 | `import_balances("v1-snapshot", …)` on `assets` | parent | Each holder's `assets` balance equals its v1 balance; `assets` supply equals v1 supply |
| 11 | `seal_import()` | parent | A second import is refused |
| 12 | Add restricted v2 keys, then delete the v1 function-call keys | each account | Key lists via `view_access_key_list` |
| 13 | Point the API at v2 (`CZ_WORLD`, `CZ_ASSETS`, the v2 key directory) and start it | — | `GET /reconciliation`: `in_sync` |
| 14 | Re-run the acceptance sequence on v2 | — | `scripts/acceptance-e2e.mjs` passes |

## Restricted keys after migration

Each function-call key works for exactly one receiver, so v2 keys are new keys for `world2.contract-zero.testnet`. They live in `~/.contract-zero/keys/v2/`, outside the repository.

| Account | v2 methods |
|---|---|
| server | `settle_raid`, `apply_flows` |
| vanguard | `accept_offer`, `accept_bid` |
| vex | `post_offer`, `post_bid`, `cancel_quote` |

## Evidence

Recorded below as each step runs.

### Run of 2026-11-08 (testnet)

| # | Step | Result |
|---|---|---|
| 1 | Queue drained | 8 rows `confirmed` |
| 2 | Builds | v1 `66e5xsBm1WpwtmuDhPLBxzXTRGg5ZDGHTyRz9knnvKcJ` (51 tests). cz-assets `5o8uRxxLcHzC7vqYMRRDhr5AHSEcwCLsfbRD6EW2LU3L` (28 tests). cz-world v2 `6c4sHyPgZq3qYkgH4F61tJ3MEM41k3qjDo3BoFD8TzeD` (21 tests) |
| 3 | v1 upgraded in place | [`7hZAZuVSbVbxN279SVVDCN4Bg1tvkgeGrV7iizrTogaS`](https://testnet.nearblocks.io/txns/7hZAZuVSbVbxN279SVVDCN4Bg1tvkgeGrV7iizrTogaS). On-chain code hash = `66e5xsBm…` |
| 4 | v1 frozen | [`CHECBJdUbUYKJw751c16D33g1R6vhbrRqCBDtT3QsbMj`](https://testnet.nearblocks.io/txns/CHECBJdUbUYKJw751c16D33g1R6vhbrRqCBDtT3QsbMj). `is_frozen() == true`. A later `settle_raid` ([`4eVp8rvk…`](https://testnet.nearblocks.io/txns/4eVp8rvkgzrD3CmkQVd85yi2mNVmnezdemYujhb7TtJF)) failed on chain: "frozen: this contract migrated to cz-assets + cz-world v2" |
| 5 | Funds consolidated into the parent | 5.271 NEAR |
| 6 | Accounts and deploys | `assets` [`F4uoPnsZ…`](https://testnet.nearblocks.io/txns/F4uoPnsZ73wfChbBsJnzhNAurDYySAyUZUZGGiXV4FSV), `world2` [`9BcUeaxh…`](https://testnet.nearblocks.io/txns/9BcUeaxhvFqvQE9QDKXmWMJ5QN32UzRETSz6pcHJZ7jA) |
| 7–8 | Configured | `assets`: controller `world2`; actors Vanguard and Vex; daily budgets credits 50,000 / ammo 10,000 / med 5,000 / fuel 10,000. `world2`: Vanguard Faction, Vex Merchant |
| 9 | Snapshot (`scripts/migrate-v1.mjs`) | Holders: Vanguard, Vex, and `player.contract-zero.testnet` (the only player in the confirmed raid log). **Per-token sums equal v1 supply:** credits 2,540, ammo 226, med 67, fuel 108 |
| 10 | Imported | [`6dHFpcxcjTz9bJRgn7RaRLVvry4YgM4P9sqFDzgKuXqk`](https://testnet.nearblocks.io/txns/6dHFpcxcjTz9bJRgn7RaRLVvry4YgM4P9sqFDzgKuXqk). Every holder's `assets` balance equals its v1 balance, and `assets` supply equals v1 supply |
| 11 | Sealed | [`DsaDLHFu…`](https://testnet.nearblocks.io/txns/DsaDLHFug769WadNb8SRCxh7a8Kv4q2qYHqXwQBzBLcs). A later import ([`GMq6vggr…`](https://testnet.nearblocks.io/txns/GMq6vggrupovWrPoQNUVJxSkUeVW8Kz2fxfG8oEc2dfr)) failed: "import window is sealed" |
| 12 | v2 keys added; v1 function-call keys deleted | server `ed25519:9hg6yCxY…`, vanguard `ed25519:EVB73ozU…`, vex `ed25519:7CUkGTCt…`. v1 keys deleted ([`6zzHQJJ8…`](https://testnet.nearblocks.io/txns/6zzHQJJ85PaqVQjfAJucDuBw3teW8bRo8MEbR4gXH8Ks), [`8uMBW4ZN…`](https://testnet.nearblocks.io/txns/8uMBW4ZNfV2rJFKG3BJYSpMFiFZLgtxn1iXhFMrYi5aS), [`CtT2VXTj…`](https://testnet.nearblocks.io/txns/CtT2VXTjckbRtvCoyepZra4VbGhsCC7jwpLweU3sm2Jw)) |

### Incident found during migration: a settlement marked confirmed that never settled

**What happened to `offer:trade-5`** (a v1 trade during a play session before the freeze):
1. Vanguard's `accept_offer` failed with "offer expired".
2. The worker cancelled the offer.
3. On retry it saw `is_used("offer:trade-5") == true`. In v1 that flag is also set for a *cancelled* offer.
4. So it marked the row `confirmed` with no transaction.

The economy recorded a purchase the chain doesn't have. The chain itself is consistent: the snapshot's sums equal supply. So the migrated balances are exactly what actually settled. The local development economy is reset for v2.

**Fixed in the v2 worker:**
- "Already applied" is checked against `cz-assets.is_used("ctl:<op>")`, which is set only when value actually moved. A cancelled or expired quote never sets it.
- Each retry posts a fresh, attempt-scoped quote ID.
- The callback's `false` result counts as a failure.
- A trade that can't settle is reversed in the economy and marked `compensated`, never `confirmed`.

Steps 13–14 (API cutover and the acceptance re-run on v2) are recorded in `NEAR.md`.
