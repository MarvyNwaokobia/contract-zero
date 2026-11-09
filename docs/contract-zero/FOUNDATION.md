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

**Durable advice:**
- A full realign can mint a day's worth of a token at once. Plan large realigns for just after an epoch reset, or split them across epochs.
- The deferral keeps normal play moving either way.
