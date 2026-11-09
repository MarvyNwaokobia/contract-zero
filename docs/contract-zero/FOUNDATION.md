# CONTRACT ZERO: foundation handoff (2026-11-09)

The state of the correctness and security findings raised before Milestone 8. Each item is labelled **Fixed**, **Mitigated** or **Open**, with the code that changed and the evidence.

## How to run the checks

| Check | Command |
|---|---|
| Engine | `cd apps/api/crates/economy && cargo test` |
| API unit tests | `cd apps/api && cargo test` (pure tests) |
| API database tests | `cd apps/api && CZ_DB_TESTS=1 cargo test` (needs `DATABASE_URL`). Covers claim races, leases, deferral and transaction rollback. |
| Web | `cd apps/web && npx vitest run` |
| Mission integrity and settlement, live | `node scripts/field-e2e.mjs` (API running, NEAR testnet) |
| Physical gameplay in a browser | `node apps/web/probe-field.mjs` |
| Pages, Practice, Endless and Campaign | `node apps/web/probe-modes.mjs` (signed in) |
| The full §17 run, recorded | `node apps/web/demo-run.mjs <web> <api> <outdir>` |

## Findings

### 1. Mission rewards depended on a client-reported outcome: **Mitigated**

A valid session could claim an extraction without playing it.

**What changed** (`services/protocol.rs`, `handlers/missions.rs` `events` and `complete`, migration 0013):
- Sessions now run the mission event protocol. The server folds a live event stream into its own `field_state`, and checks each event for order, replay, bounded client time, movement speed, proximity on the server's copy of the map, hold durations, capacity, consumption and the extraction countdown.
- Completion settles only a server-observed extraction, with amounts from the stored manifest.
- Any impossible event taints the session.
- Rewards are capped at 8 paid operations per player per hour.
- Details and the remaining trust limits are in `MISSIONS.md` ("What a modified client can still do").

**Evidence:**
- **12 protocol unit tests:**
  - an honest run;
  - forged cargo and teleporting;
  - a clock ahead of the server;
  - a tap instead of a hold;
  - a replay and a second take;
  - carrying more than three, and a mismatched object;
  - premature and interrupted extraction;
  - dropped cargo picked up again;
  - sabotage order and the recovery handover.
- **`field-e2e.mjs`, 24/24 against the live API:**
  - a forged record settles nothing;
  - teleporting taints the run ("impossible movement: 45.9 m in 0 ms");
  - a clock 600 s ahead taints it;
  - a replay is ignored;
  - unknown and expired sessions are refused;
  - death pays nothing;
  - a walked partial run pays exactly the carried case, once.

**Still open:**
- A scripted client that walks legal paths at legal speed can earn what a real run would, no faster.
- Walls and combat aren't validated on the server.

### 2. Settlement selection had no atomic claim: **Fixed**

**What changed** (`services/settlement.rs` `claim`, migration 0012):
- The worker claims the head of the queue in one statement (`FOR UPDATE` plus a lease).
- A second worker blocks, sees the lease and backs off. It never takes the same row and never skips ahead.
- An expired lease (a crashed worker) is reclaimable.
- Status updates are conditioned on the claiming worker.

**Evidence:** `two_workers_never_claim_the_same_row_or_jump_the_queue` (database test). Two concurrent claims gave exactly one winner, a live lease blocks a reclaim, and an expired lease is reclaimable with the attempt count kept.

### 3. Trades were compensated after 3 failures whatever the chain outcome: **Fixed**

**What changed:**
- Each attempt is recorded in `evidence.attempts` with its outcome: `not_sent` (never broadcast), `failed` (refused on chain, with its hash) or `unknown` (a timeout or lost response after broadcast).
- A trade is reversed in the economy only when:
  - every attempt is known not to have moved value, or its unknown outcome is older than the quote's lifetime plus 5 minutes; and
  - the assets contract's `is_used` confirms nothing moved.
- If `is_used` can't be read, nothing is submitted.
- `verify` now reports the refusing receipt's reason.

**Evidence:**
- Unit tests `errors_are_classified_by_what_they_prove` and `a_trade_is_compensated_only_when_no_attempt_could_have_moved_value`.
- In the existing data, all 289 compensated rows were `not_sent` nonce failures, so they were never broadcast.

### 4. In-memory rollback could leave rows committed in PostgreSQL: **Fixed**

**What changed** (`services/world.rs` `transact`):
- Each action runs inside one PostgreSQL transaction. That covers every row it writes (events, sessions, settlements, history) and the world snapshot.
- The transaction commits only if everything succeeds. Otherwise it rolls back, together with the in-memory world.
- Chain calls stay outside the transaction.

**Evidence:** `a_failed_transaction_rolls_back_the_database_and_the_world` (database test). An event written before a failure is gone, the world version is restored, and a successful transaction commits.

### 5. Quick-trade keys held in the browser: **Mitigated**

**What changed** (`lib/auth.ts`, `lib/useSession.ts`):
- Turning quick trade off, or signing out, now revokes it on chain and confirms the revocation through the controller's `get_session`.
- Previously sign-out didn't revoke, and a failed revoke was swallowed. A failure is now reported to the player, along with when the session expires anyway.

**Evidence:** `quickTrade.test.ts` (the rule for when a session can no longer trade).

**Still open:**
- **The key is readable by page scripts.** It sits in `localStorage`, where an XSS or a malicious extension could read it. What it could do is bounded by the contract: accept quotes Vex has already addressed to this player, within the remaining budget (credits and units the player chose), until expiry (24 hours by default).
- **Revocation leaves the access key on the account.** It becomes a powerless tombstone, because deleting it needs the account's full-access approval.
- **Fix for both:** a non-extractable WebCrypto Ed25519 key, plus a CSP.

### 6. Credentialed CORS, CSRF and cookies: **Fixed**

**What changed** (`main.rs`, `services/auth.rs`):
- `CZ_ENV=production` allows credentialed CORS only for `FRONTEND_ORIGIN`, with no localhost exceptions, and refuses to boot without that variable.
- Every state-changing request carrying a browser `Origin` must come from an allowed origin.
- Production cookies are `HttpOnly; Secure; SameSite=None`, which the Vercel and Railway split needs. The Origin check is what protects against CSRF there.
- Development keeps `SameSite=Lax` and the local origins.

**Evidence:** `production_allows_only_listed_origins` and `development_also_allows_local_origins`. Prefix spoofing such as `…vercel.app.evil.example` is refused.

### 7. Single-writer world: **Fixed (enforced)**

**What changed:**
- The world lives in one process's memory. The API now holds a PostgreSQL advisory lock for the life of the process, and a second instance against the same database refuses to start.
- Scaling out needs a different design (a shared world service). This isn't safe to run as replicas.

**Evidence:** startup check in `main.rs`. The running dev API holds the lock.

## The blocked partial-cargo settlement

**Rows:**
- `flows:ledger-12506-12519-0` (row 1475): mint 87 credits plus small ammo and fuel mints and burns. The ledger refused it for the credits epoch budget: 99,928 of 100,000 used since 2026-11-08 08:14 UTC, mostly by the full realign that night.
- It was the head of the queue, with 97 rows behind it, including `raid:1125` (row 1527).

**Correction** (no cap change):
- A batch refused for its issuance budget is deferred to the token's epoch reset, read from `token_info`. Row 1475 was deferred to 08:14:35 UTC.
- Player raid and operation payouts may pass a deferred batch. They move existing tokens, mint nothing, and the chain checks the balances. Agent trades and later flows keep their order.

**Result:**
- `raid:1125` confirmed: tx `FCwkqzN1JDYqapeQyENJSyHd2oj32qimN9UNuZitRuYW`, NEP-245 `mt_transfer` of 31 ammo vanguard → player.
- Player ammo 90 → 121. `is_used(ctl:raid:1125)` is true, and there is one settlement row.
- Under the event protocol, `raid:1182` (a walked partial run) confirmed in tx `AVspDz46xkitaKoKY1wMi2MRqawKcELPUky5yfba8xxx`: ammo 121 → 151, exactly the 30-unit case.

**Follow-up found during verification** (and fixed):
- **What happened.** Letting payouts pass a deferred batch reordered the queue. Two Cinder Yard payouts moved the Ashen Compact's ammunition to the player before queued trades had brought ammunition in on chain.
- **The effect.** After the epoch reset the next ledger batch (`flows:ledger-12577-12592-0`) was refused for "insufficient balance": a head-of-line deadlock. One agent sale (`sale-1080`) was compensated for the same transient reason.
- **The fix.**
  - A refusal for insufficient balance now defers the row for 45 s and blocks nothing, so the operations behind it, which may be what funds it, can land.
  - It only counts toward compensating a trade once it has persisted for 30 minutes.
  - This is safe because every operation is replay-protected and only adds or subtracts amounts: order changes when a step can land, never the final balances.
- **Tests:** `an_issuance_deferral_lets_only_player_payouts_pass` (extended) and `a_trade_is_compensated_only_when_no_attempt_could_have_moved_value` (balance cases).

**Durable advice:**
- A full realign can mint a day's worth of a token at once. Plan large realigns for just after an epoch reset, or split them across epochs.
- The deferral keeps normal play moving either way.

## The gameplay phases (2026-11-09)

| Phase | Commit | Status |
|---|---|---|
| 1. Mission integrity: server-authoritative event protocol | `24bbdca` | Built and verified; trust limits in `MISSIONS.md` |
| 2. Battlefield weapons: guards drop their guns; take, swap, strip for rounds | `2b1d0a8` | Built and verified |
| 3. Item inspection: Armory, loadout and in the field | `b7adecc` | Built and verified |
| 4. Cinder Yard: the Ashen Compact's refinery, a third map | `b7fe2b3` | Built and verified |
| Settlement, persistence and session hardening (findings 2–7) | `81aed08` | See the findings above |

## Verification evidence

**Test suites:**

| Suite | Result |
|---|---|
| Engine | 86 passed |
| API, with `CZ_DB_TESTS=1` | 37 passed: protocol, settlement, origins, rollback |
| Web | 491 passed |

**`scripts/field-e2e.mjs`, live, 24/24 each time:**

| Target map | Settlement | Payout |
|---|---|---|
| Dustline Depot | `raid:1182` | 30 ammo, ammo 121 → 151 |
| Cinder Yard (`… ashen`) | `raid:1250`, tx `81fNa5ZCeUWQYzpygWa1HpxUbkFhUXobv7wmWHpBeUwi` | 25 ammo, ammo 190 → 215 |

**`apps/web/demo-run.mjs`, the recorded §17 run, played through the UI with the event stream:**
- The Cinder Yard run was validated by the server: 3 cases, 69 events, none refused except heartbeats after the extraction. It settled `raid:1202` (59 ammo, 151 → 210, tx `GmoDFJirNU…`), and a Vex sale also settled on chain.
- A Dustline Depot run settled `raid:1235` (73 fuel plus the 700 cr bounty, tx `41pY1hLPz3…`).
- Both runs: 13/13 steps, 0 page errors.

**`apps/web/probe-field.mjs`, the real scene, all at 57–60 fps with no page errors:**
- **Operation types:** raid, sabotage and recovery on the Depot, the Blacksite and Cinder Yard, by day, dusk and night.
- **Combat run:** 3 kills with finite ammunition spent through reloads. The guards' weapons dropped, and a rifle was swapped for the SMG (17/24), with the SMG left on the ground.

**`apps/web/probe-inspect.mjs`:**
- The Armory Marksman shows "Owned · token gun:marksman", 776 cr, and its model turns and zooms.
- In the field, a crate and your own weapon can be inspected. The fight continued while the inspector was open, and the player stayed still.

**`apps/web/probe-modes.mjs`:**
- Practice (Blacksite, dusk, recovery) completes with "Nothing was scored or settled".
- Endless runs on the generated chain, and the Campaign ends at an extraction zone.
- The only economic requests across all three were read-only `GET /exchange` (the top bar's stash).

## Manual testing

Start the API (`apps/api`: `cargo run`) and the web app (`apps/web`: `npx next dev -p 3000`).

1. **Hub and board.** The clock, the sites, and contracts at their own sites.
2. **A live contract.** View intel → Accept → briefing → Choose loadout → Inspect the weapon → Deploy.
   - In the fight:
     - E on crates, cases and charges;
     - E on a dead guard's gun to swap it;
     - I to inspect;
     - H for a dressing;
     - E at the extraction zone, then hold it.
   - Afterwards: the results screen shows "Settled on NEAR" once confirmed.
3. **Cinder Yard.** Pick an Ashen Compact contract, or Practice → Cinder Yard.
4. **Training.**
   - Practice: every site, hour, type and difficulty.
   - Endless.
   - Campaign: run `localStorage.setItem('cz_progress','15')` in the console to unlock every op.
5. **The War Room.** Operations show trigger → validation → transaction → consequence.

## Outstanding risks

- **Scripted runs.** A client that obeys the movement, timing and order rules can fabricate a run. It earns no more than playing would, at no more than 8 paid operations an hour. Walls and combat aren't validated on the server.
- **The quick-trade secret is in `localStorage`.** The contract bounds what it can do; a non-extractable key and a CSP are the next steps.
- **One API instance per database.** Scaling out needs a shared world service.
- **Realigns and the mint cap.** A full realign can spend a day's credit mint budget; schedule large realigns just after an epoch reset. Deferral keeps player payouts flowing meanwhile.
- **Cinder Yard is flat.** Its catwalks and pipe bridges are scenery: the simulation is 2D on the ground plane, so there are no elevated firing positions.
- **The NEAR AI planner and story voicing need credits** on the NEAR AI account. Until then the deterministic agents and authored lines run.
