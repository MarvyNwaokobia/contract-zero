# Intents in CONTRACT ZERO: Supply Orders and the NEAR Intents adapter

CONTRACT ZERO has two distinct things called "intents". They are never confused in code, UI or this document.

| | **Supply Orders** (the game's own intents) | **NEAR Intents** (the official protocol) |
|---|---|---|
| What | Requests for game supplies (ammunition, medical, fuel) for credits, answered by competing in-game merchants | Cross-chain token swaps answered by the protocol's solvers |
| Settles on | `world2.contract-zero.testnet` and `assets.contract-zero.testnet`, on NEAR **testnet** | The Verifier, `intents.near`, on NEAR **mainnet** (there is no testnet Verifier) |
| Assets | CONTRACT ZERO's NEP-245 tokens (`credits`, `ammo`, `med`, `fuel`) | The 216 assets 1Click lists on 39 chains (`GET /v0/tokens`, 2026-11-09) |
| Status here | **Operational.** Players and autonomous commanders trade with Vex and Halcyon. Every step is on chain with transaction hashes | **Read-only integration.** Live asset discovery and live **dry** quotes. Execution is disabled, and no mainnet funds have moved |
| UI label | "Supply Order", "Trading Partners", "Best Offer", "Order Filled" | "NEAR Intents · Official protocol · Mainnet · dry quotes only · not executed" |

A Supply Order is **not** a NEAR Intents transaction. A NEAR Intents quote is **not** a game trade. Game credits have **no exchange rate** to any external token, and none is invented anywhere.

---

## 1. Audit of what existed (Phase 1)

| Component | What it already did | Reused for Supply Orders | Limitation found |
|---|---|---|---|
| `cz-assets` (NEP-245 ledger) | Balances, NEP-145 storage, controller-only `controller_settle`/`controller_mint_burn`, per-op replay ids, epoch issuance budget | All value movement (escrow in, fills, refunds) | A leg may only debit a registered actor or the transaction signer. A merchant filling a player's order therefore can't pull the player's credits, so **escrow is required** |
| `world2` v2.2 (controller) | Roles, merchant-posted offers and bids addressed to one counterparty, quick-trade sessions with budgets, `begin`/`pending`/`used` replay guards, atomic settle-and-callback | Sessions, replay sets, callback pattern | Quotes are one-to-one (a merchant addresses one counterparty). There's no requester-defined order that several merchants can compete for, and no contract-enforced spending limit beyond the acceptor's own `max_total` |
| Rust economy (`cz-economy`) | Deterministic, conservation-checked world; one merchant (`market.merchant`); commanders bought directly from Vex with `Action::Trade` | Ledger, pricing curve (`pricing::walk_total`), escrow-account pattern, decision log | A single hardwired merchant; commanders never compared offers |
| Exchange and player quotes | Firm quotes with merchant-side escrow; chain-first acceptance | The chain-first verification pattern | Player can only trade with Vex at Vex's price |
| Agent policies and planner | Deterministic fallback with logged decisions; the LLM planner validated against policy | Decision format (trigger, context, action, rationale) | No procurement competition |
| Settlement worker | Claim and lease, idempotency checks against `is_used`, classification (not sent, failed, unknown), deferrals, compensation, exact reconciliation | Everything; new step kinds plug into it | `is_used` on `cz-assets` doesn't fit multi-step orders, so a step is checked against the controller's own order state instead |
| War Room | Causal chains (raid → decision → transaction → world → gameplay) | Settlement evidence rendering | No per-order view of competition |

**Decision: extend `world2` in place rather than add a third contract.**
- **Atomic.** The controller already owns authorization, replay and the atomic settlement path into `cz-assets`. An order book is the same kind of rule.
- **Simpler.** A separate contract would need its own controller rights on `cz-assets` (or a second hop), doubling the trust surface.
- **No migration.** `world2` was upgraded in place (v2.3). The new collections are created on demand, so no state migration was needed, and the controller account itself became the escrow holder (`assets.register_actor(world2)`).

## 2. Supply Orders: the contract (`world2` v2.3)

```text
place_order(order_id, side, token_id, quantity, limit_credits, allow_partial, ttl_secs)   requester (player or faction)
propose(order_id, proposal_id, quantity, total_credits, ttl_secs)                          registered merchant
accept_proposal(order_id, proposal_id)                                                      requester only
cancel_order(order_id)                                                                      requester only
expire_order(order_id)                                                                      anyone, after expiry; the refund goes to the requester
retry_refund(order_id)                                                                      anyone; a failed refund only
get_order(order_id) / get_proposal(order_id, proposal_id)                                   views
```

| Requirement | How it is enforced on chain |
|---|---|
| Funding and reservation | `place_order` moves the requester's credits (buy) or goods (sell) into the controller's escrow, in the same transaction the requester signs. An order that can't be funded is dropped, and its id stays free |
| Owner-approved or delegated execution | Only the requester can accept or cancel. Merchants can only propose. A quick-trade session key is held to its credit or unit budget at placement |
| Contract-enforced spending limit | Every proposal and every fill is held to the order's limit **pro rata**, by exact integer cross-multiplication (`total × quantity ≤ limit × qty` for a buy; `≥` for a sell). A partial fill can't take the whole budget |
| No unauthorized debit | The legs debit only the merchant (the actor whose key signs a proposal is checked at acceptance; `cz-assets` debits actors) and the controller's escrow. The requester's own balance was debited only by their signed `place_order` |
| No double fill or replay | `order_id` and the `fill:{order}|{proposal}` op ids are single-use (`used` set). One fill is in flight per order (`Settling`). `cz-assets` also refuses a replayed op id |
| Partial fills | `remaining` and `settled_credits` accumulate; `allow_partial = false` rejects any lot that isn't the whole remainder |
| Expiry | Both the order and each proposal carry a deadline, checked at acceptance |
| Race-safe cancel or accept | Cancel requires `Open`; acceptance moves the order to `Settling` first. Whichever lands first wins; the other is refused |
| Reservation release | Unused escrow returns on fill, cancel or expiry. A failed refund leaves the order `Refunding` until `retry_refund` lands |
| Crash or unknown outcome | A failed fill reopens the order (nothing moved, because `cz-assets` applies all legs or none). The worker checks controller state before resubmitting any step |

**Tests:** 21 new contract tests (57 in total), all passing (`cargo test` in `contracts-near/cz-world-v2`). They cover:
- competition between two merchants;
- replayed ids, merchants placing orders, non-merchants proposing;
- prices above the limit, and partial-fill budget theft;
- all-or-nothing orders, partial accumulation and refund;
- acceptance by someone other than the requester;
- concurrent fills, cancel against fill, failed fills and retry, duplicate fills;
- expired proposals, expiry by a third party, failed refunds and retry;
- session budgets, expired session keys;
- sell orders and the exact integer price check.

## 3. Supply Orders: the economy and its agents

**The engine** (`apps/api/crates/economy/src/orders.rs`) mirrors the contract, deterministically and in integers.
- **Escrow accounts:** `order:{id}` holds the requester's side, and `proposal:{id}` holds the merchant's reservation. Conservation (every asset sums to zero) holds through every step.
- **Per-requester nonces** refuse a replayed order.
- **Expiry:** a tick releases lapsed proposals and expires orders past their deadline.

**Merchants** (Vex and Halcyon Logistics) each have their own:
- inventory and treasury (with a credit reserve);
- pricing strategy (margin and spread), using the same bounded curve on their **own** stock against their **own** shelf targets;
- **floor**: a minimum margin over production cost;
- **risk limit**: the share of one shelf it will commit to a single order;
- **record**: proposals, wins, losses and units, plus a streak.

| | Vex Exchange | Halcyon Logistics |
|---|---|---|
| Margin and spread | 20% / 10% (also its instant-market price) | 12% / 14% |
| Floor | 10% over cost | 8% over cost |
| Commits per order | up to 80% of a shelf | up to 60% of a shelf |
| Shelves (targets) | 120 / 60 / 120 | 80 / 40 / 80 |
| Restocks | by caravan, to its targets | by caravan, to its targets |

**How a merchant answers** (`policy::merchant_proposals`):
1. It inspects every open order and prices it from its own shelf.
2. It shrinks the lot until its price fits the order's limit, when partial fills are allowed.
3. It proposes, or declines with the reason ("my floor is 14 cr/unit", "no fuel to spare", "my shelf is full", "over what I can spend").

**Adaptation.** After three consecutive losses a merchant cuts its margin by 2 points, down to its floor. After three wins it raises it. Vex's instant-market prices follow its margin. The winner is never hardcoded.

**Commanders** (`policy::commander`, `policy::commander_choices`) no longer buy from a predetermined merchant.
- **Placing an order.** On a shortage the commander weighs:
  - stock against target (with hysteresis);
  - shipments already inbound;
  - urgency (critical below a quarter of target);
  - the best ask on the market against its doctrine ceiling;
  - its treasury above reserve.

  It then places a bounded order, or decides to wait ("holding off while stock lasts"), not to buy ("already on the road"), or that it can't ("the treasury can't cover even one unit"). Surplus beyond twice its target becomes a **sell** order with a cost floor.
- **Choosing.**
  - Urgent orders favour coverage first, then price.
  - Routine orders favour price per unit.
  - Sell orders take the best bid.
  - With partial fills allowed, several proposals can fill one order.
- **Cancelling.** If the need passes before anyone delivers (a shipment arrived), the commander cancels and keeps the credits.

**Every step is a logged decision** with its trigger, figures, action and rationale. The choice records the whole field, e.g. *"Take Vex Exchange's 28 ammo for 443 cr on #1472 (routine: cheapest per unit). On the table: Vex Exchange 28×15cr, …"*.

**AI planners.**
- **`request_supplies`.** The LLM planner (when configured) has a `request_supplies` tool. It becomes a supply order only within the same bounds as the deterministic commander:
  - quantity 1–200;
  - limit within spendable credits;
  - the doctrine price ceiling, or the market ceiling when critically short;
  - a sale never below cost, and never more than held;
  - a fresh nonce.

  It sees every merchant's prices and its own open orders with their proposals. The choice among proposals stays with the commander's rule.
- **No keys, no shortcuts.** The planner can propose only engine `Action`s, which the policy and the engine validate exactly like a fallback decision. It holds no keys, and every order step is signed by the server's scoped actor keys after the engine accepts it. Without a NEAR AI key, the deterministic policy runs every turn.

**Engine tests:** 16 new adversarial tests (`crates/economy/tests/orders.rs`). They cover:
- two merchants answering, with the cheaper one winning a routine order and coverage winning an urgent one;
- partial fills from two merchants, refunds, and expiry with no offers;
- a buyer without the credits, merchant stock oversell and double promise, replayed nonces;
- manipulated prices on partial lots, and unauthorized actors on every action;
- cancel against fill, double accept, and expired proposals;
- player orders, merchant adaptation, and needs that pass;
- a 12-day living world where both merchants win business and no escrow is left behind;
- determinism by seed.

All existing suites still pass.

## 4. Settlement on NEAR

**Faction orders are engine-first.** Each committed step is queued in the existing settlement queue and signed by the scoped key of the actor who would sign it:

| Engine event | Chain step | Signed by |
|---|---|---|
| `OrderPlaced` | `place_order` (escrow in) | the faction's v3 key |
| `ProposalPosted` | `propose` | the merchant's v3 key |
| `OrderFilled` | `accept_proposal` (fill; the contract refunds the rest when fully filled) | the faction's v3 key |
| `OrderClosed` (cancelled or expired) | `cancel_order` | the faction's v3 key |

**Player orders are chain-first.** The player signs `place_order`, `accept_proposal` and `cancel_order` in their own wallet, or within a quick-trade budget. The API reads the controller's state back (requester, terms and the fill's `is_used`) before the economy applies the step, and it records the player's transaction as evidence. The merchants' proposals for player orders are queued and signed by the merchants. When the engine lets a player's order lapse, Vex's key calls `expire_order`, and the refund still goes only to the player. The chain's deadline is set to the engine's (ticks × `WORLD_TICK_SECS`).

**Idempotent retries.** Before any order step is submitted, the worker reads the controller:
- `get_order` (exists, not `Funding`);
- `get_proposal`, or a used fill;
- `is_used(fill:…)`;
- the order state (`Refunding` or `Closed`).

So a crash after submitting, or an unknown outcome, never submits twice. A step that waits on another (the order still funding, a proposal before its order, a chain deadline a moment behind the engine) is deferred without blocking the queue. A fill whose chained refund failed triggers `retry_refund`.

**Reconciliation** (`GET /reconciliation`) now also counts:
- **open orders' escrow:** a new row, compared with `world2`'s own balance;
- **merchants' proposal reservations:** still the merchant's own tokens on chain until a fill.

The repair (`align`) refuses to run while any order step is in flight.

**Queue liveness.**
- **Moot proposals.** A proposal that reaches the chain after its order closed (the requester took another offer first), or after the order's deadline, can never land, and the economy has already released it. The worker retires such steps as `superseded`, with the reason. Without this, one late proposal retried at the head of the queue and stalled every settlement behind it; the first live run found this.
- **Deadlines.** Player orders carry wall-clock deadlines on chain. The E2E therefore fast-forwards the world clock only for the faction part.

**Storage, found in live load.** Every order, proposal and used id costs `world2` storage. Two habits made that grow without bound:
- losing proposals were never deleted;
- commanders re-posted surplus sell orders that no merchant would bid on, every six hours. Merchants' bids sat below the commander's cost floor, which is correct behaviour on both sides.

`world2` ran out of NEAR for its state, and every settlement halted, ledger batches included. The fix:
- **v2.4** deletes a closed order's leftover proposals and caps proposals per order;
- **cooldowns:** after an order lapses unanswered, a commander waits 6 hours (buy, unless critical) or 24 hours (sell) before the same request;
- **funding:** `world2` was topped up from the testnet faucet (NEAR.md).

The ledger contract hit the same limit next, and was funded the same way. A refund that failed during that outage left one order in `Refunding`. The worker now sends `retry_refund` after any close, expiry or fill whose order is still refunding, not only after fills. Reconciliation found the 524 credits it had left in escrow, and showed exact again after the retry.

Closed order records and used ids stay on chain on purpose, as replay protection and evidence. On mainnet this would call for a storage-deposit model.

**Gas.** Actor accounts pay their prepaid gas up front, so each method attaches only what it needs: 30 Tgas to propose, 200 Tgas to accept (the fill may chain the refund), 100 Tgas otherwise.

## 5. The official NEAR Intents adapter (Phase 5)

**The protocol.**
- **1Click API** (`https://1click.chaindefuser.com`):
  - `GET /v0/tokens` lists the supported assets;
  - `POST /v0/quote` returns a signed quote (with `dry: true`, prices and fees only, and **no deposit address**);
  - `GET /v0/status?depositAddress=` reports execution: `PENDING_DEPOSIT`, `KNOWN_DEPOSIT_TX`, `INCOMPLETE_DEPOSIT`, `PROCESSING`, `SUCCESS`, `REFUNDED` or `FAILED`;
  - `POST /v0/deposit/submit` optionally speeds up deposit detection.
- **Verifier:** `intents.near`. **There is no testnet deployment**, per the official docs.
- **Message Bus:** the solver relay that broadcasts quote requests to market makers over WebSocket and submits matched, signed intents to the Verifier.
- **Signing standards:** `nep413`, `erc191`, `raw_ed25519` and others; NEP-413 payloads name `intents.near` as the recipient.

**What was chosen and why.** The smallest official integration that shows real protocol interaction without bending the game is **1Click, read-only**. The Verifier and Message Bus would mean running a solver, or signing intents with mainnet funds. That isn't meaningful for testnet game assets, and it's out of scope without approval.

**What the adapter does** (`apps/api/src/services/intents.rs`, `handlers/intents.rs`; UI: Exchange → "NEAR Intents · official protocol"):

| Capability | Status |
|---|---|
| Query supported assets (cached 10 minutes) | **Live.** `GET /intents` reports 216 assets on 39 chains |
| Check network and asset availability before any request | **Live.** Unknown assets, a wrong destination chain and bad amounts are refused |
| Request quotes | **Live dry quotes**: amount out, minimum received, fees and time estimate (`POST /intents/quote`) |
| Display fees and minimum received | **Live.** Fees are read from the quote (20 bps observed without a partner key) |
| Quote expiration | **Tracked.** The deadline is checked and an expired quote is flagged |
| Secure user authorization | Not exercised: no deposit is ever requested |
| Execution status, refunds and failures | **Wired** (`GET /intents/status/{deposit}`), with every state mapped. Never hit with a real deposit address |
| Persist protocol references | **Live.** Every quote is stored in `intents_quotes` with its `correlationId`, `signature`, request and response |
| Execute a swap | **Disabled.** It needs `NEAR_INTENTS_EXECUTION=mainnet-approved`, and even then the UI never offers it |
| Game assets | **Refused** before any request, because they aren't supported (checked against the live list: `tokenIn is not valid`) |

**Tests:**
- **Unit tests:** game assets refused, unsupported assets, wrong chain, bad amounts, request shape, every status meaning, execution refused without approval, and an unreachable service reported rather than invented.
- **One explicitly labelled mock:** a recorded live response, parsed together with its deadline.
- **The E2E:** a live dry quote with its stored reference, and a game asset refused (section 8).

### What it would take for CZ assets to trade on NEAR Intents

1. **A mainnet deployment.** `cz-assets` would need deploying on mainnet, which means real economic value and its own audit. Today it's a testnet ledger whose transfers are restricted to the game controller.
2. **Verifier compatibility.** The Verifier holds NEP-141, NEP-171 and NEP-245 deposits. Our ledger's player transfers are standard NEP-245 (`mt_transfer_call`). Deposits would use `mt_transfer_call` to `intents.near` with the deposit message. The ledger's actor restrictions (only the controller moves actor balances) would have to allow deposits, or only player-held tokens could be deposited.
3. **Liquidity.** Solvers quote only assets they can source. At least one market maker would have to quote `nep245:<assets>:<token>` against a supported asset. That means running a solver on the Message Bus with inventory, and a price feed for game goods that doesn't exist.
4. **1Click listing.** 1Click's `GET /v0/tokens` lists only the assets its partners support. Listing is a partner process, not something an integrator can do.
5. **Policy.** Game credits are an in-game unit, and pricing them in real tokens turns the game into a real-money market, with the legal and design consequences that brings. That decision belongs to the project, not to this integration.

None of this is assumed or simulated anywhere in the game.

### Mainnet acceptance procedure (prepared; not run)

This needs **explicit approval** first: it moves real funds.

1. **Fund.** Fund a fresh mainnet account with about 0.2 NEAR, and wrap 0.1 NEAR to wNEAR.
2. **Deposit.** Deposit 0.05 wNEAR into `intents.near` (`ft_transfer_call` to `intents.near`, standard deposit message).
3. **Configure.** Set `NEAR_INTENTS_EXECUTION=mainnet-approved` and, optionally, `ONECLICK_API_KEY` (a partner key; never logged).
4. **Quote.** Request a **non-dry** quote: 0.05 wNEAR → USDC, `depositType: INTENTS`, `recipientType: INTENTS`, 1% slippage, a 10-minute deadline. Record the `correlationId`, `signature` and `depositAddress`.
5. **Deposit to the quote.** Transfer the exact `amountIn` to the deposit address within the deadline. Optionally `POST /v0/deposit/submit` with the transaction hash.
6. **Track.** Poll `GET /v0/status` until `SUCCESS`, `REFUNDED` or `FAILED`. Persist each state.
7. **Verify.** On `SUCCESS`, check the USDC balance inside `intents.near` (`mt_balance_of`) against `minAmountOut`. On `REFUNDED`, check the wNEAR came back.
8. **Withdraw** (optional) and record every transaction hash in this document.

## 6. Player experience (Phase 7)

**Exchange → Trading Partners.** Each merchant shows:
- its margin, floor and commit limit;
- every shelf, with stock, target, units held for open proposals, and its own sell and buy price;
- its win and loss record.

**Exchange → New Supply Order.**
- **Terms:** buy or sell, supplies, quantity, a spend-at-most or receive-at-least limit (suggested from the best price now, shown per unit), partial fills, and duration.
- **Signing:** the order is signed in the player's wallet, or within a quick-trade budget; new quick-trade keys include the order methods.

**Your Supply Orders, and the market.** Competing offers are ranked, with a **Best Offer** badge. **Accept** is offered only once a proposal is on chain. **Cancel order** is available while the order is open. Statuses read "Order Filled", "Credits Received", "Order Expired" and "Partly filled". **Transaction details** (collapsed) shows the chain order id, each step and its explorer link.

**Exchange → NEAR Intents.** A separate panel with its own label (mainnet, dry quotes only, not executed):
- the live supported-asset count;
- the live check that CONTRACT ZERO assets aren't supported;
- three buttons: two real dry quotes, and one game-asset request that is refused with the reason.

## 7. War Room (Phase 8)

**Supply orders and competition** (`GET /warroom/procurement`) shows one chain per faction order:
1. the player operation that hit the requester (if any);
2. the shortage or surplus, with its figures;
3. the supply order and its rationale;
4. each merchant's proposal, or its refusal with the reason (one per merchant);
5. the winning quote and why;
6. each settlement step on NEAR, with explorer links;
7. supplies delivered and paid;
8. the next mission against that faction (guards, rifles, sidearms, defense).

Each chain carries an **execution-path line**, "CONTRACT ZERO supply order, settled by world2 on NEAR testnet. Not an official NEAR Intents transaction." **Trading Partners** in the War Room shows the competition: margins, shelves and records. All of it is read from recorded decisions, events, the settlement queue and the world. Nothing is composed for display.

## 8. Verification (Phase 9)

| Layer | Suite | Result |
|---|---|---|
| Contract | `cargo test` in `contracts-near/cz-world-v2` | 58 passed (22 new) |
| Engine | `cargo test` in `apps/api/crates/economy` | all suites pass; `orders.rs` 16 new |
| API | `cargo test` in `apps/api` | passes, including 8 adapter tests |
| Live, chain | `node scripts/orders-smoke.mjs` | net-zero place, propose and cancel on testnet (NEAR.md) |
| Live, end to end | `CZ_ADMIN_TOKEN=… node scripts/supply-e2e.mjs` | see below |

**`scripts/supply-e2e.mjs` passed 29 of 29 checks** on 2026-11-09 against the live API and testnet. Results: `evidence/supply-e2e.json`.

**A. Raid → shortage → competing merchants → NEAR → next mission (autonomous)**
| Step | Evidence |
|---|---|
| The player raids Ashen's ammunition at Cinder Yard | 46 of 46 units extracted, settled as `raid:1945` |
| Ashen's commander posts a supply order, not a purchase from one merchant | Order #1946: 59 ammunition, at most 2,124 cr, urgency 2. On chain: `place_order` [`EzjMDkvJ…`](https://testnet.nearblocks.io/txns/EzjMDkvJWhQf3aDqyhEZJPW1isiDC78WtCm31TdVK6cs) |
| Both merchants answer, on chain | Halcyon: 54 for 23 cr each, `propose` [`Ho3adT1d…`](https://testnet.nearblocks.io/txns/Ho3adT1d2NW7n6WyB3D8hZtxhDWAvNBgmsSUxYns6ctk). Vex: 59 for 20 cr each, `propose` [`FwabqBo7…`](https://testnet.nearblocks.io/txns/FwabqBo7SYLqtfAf6R7xcJQjP9RQSgJJDRiucm8C1uEV) |
| The commander chooses by its rule and says why | "Take Vex Exchange's 59 ammo for 1225 cr on #1946 (urgent: most coverage first, then price). On the table: Vex Exchange 59×20cr, Halcyon Logistics 54×23cr." |
| Settled on chain | Ashen `accept_proposal` [`AK5TAFMz…`](https://testnet.nearblocks.io/txns/AK5TAFMzgjD2jGdTbSr95fCvsiFkyYoTovB2n6aeVysZ). The controller shows `Closed`, 59 delivered for 1,225 cr, matching the economy; the unused 899 cr of escrow was refunded |
| The next mission changes | Ashen holds 86 ammunition. Its next fuel-depot defense: 9 guards, all 9 with rifles |

**B. The player in the same market (chain-first)**
| Check | Result |
|---|---|
| The player signs `place_order` with their own key | [`CTxpkFxW…`](https://testnet.nearblocks.io/txns/CTxpkFxWyugArgjDgqtEb5M68PeSomfajtPt67rbup3Y); recorded only after the API read it back |
| Replayed confirmation | Refused (nonce already used) |
| Claiming someone else's order | Refused |
| Trading partners answer on chain | Vex: 3 medical for 158 cr |
| Applying a fill the chain hasn't seen | Refused (409) |
| The player accepts the Best Offer | [`3z1H6c5b…`](https://testnet.nearblocks.io/txns/3z1H6c5bVw98iU2d55zZBQzG8fC3PGwPDHaycg3ieB1p). The player's medical went 11 → 14 on chain, exactly the 3 bought |
| Cancel racing an accept, sent together | The cancel won on chain and the accept was refused (`Closed`/`cancelled`, 0 fills). The economy mirrored only the cancel (200 against 409) |
| An order nobody answers | A 1 cr/unit order: every merchant declined below its floor. It expired on chain (expired by Vex's key) and the escrow came back exactly (2,658 → 2,658) |

**C. Official NEAR Intents (1Click, mainnet, read-only)**
| Check | Result |
|---|---|
| Reachable; supported assets listed | 216 assets; execution disabled |
| CONTRACT ZERO assets supported? | No, checked against the live list |
| Live dry quote | 0.1 wNEAR → 0.36141 USDC, minimum 357,795 base units, 20 bps fee. Reference `b4b45dcc-02b4-4942-b295-58f89676baee`, stored in `intents_quotes` |
| Game asset | Refused before any request (422) |

**Reconciliation.** Economy and chain reconcile **exactly**, with no differences across every actor and the order-escrow row.

**Browser** (`node apps/web/probe-market.mjs`, `evidence/market-ui.json`): **14 of 14** checks pass.
- **Exchange:** both trading partners shown; the order form offered; market orders listed; the official-protocol panel labelled separately; a live dry quote with minimum, fees and expiry; a game asset refused with the reason.
- **War Room:** procurement chains show proposals, the winner, settlement and the execution path ("Not an official NEAR Intents transaction").
- **Layout:** no sideways scroll at 1280 px or 390 px; no page errors.
- **Accessibility:** axe (WCAG 2.1 A/AA) is clean on `/exchange` and `/war-room`.

**What was not done:**
- No official NEAR Intents swap was executed. Mainnet funds need explicit approval; the procedure is in §5.
- No CONTRACT ZERO asset is tradable on NEAR Intents. The requirements are in §5.
- Partial fills from two merchants on one order are proven in the contract and engine tests and happened live: Vanguard's surplus ammunition order #1466 was filled 3 + 3 by Halcyon and Vex, both fills on chain. The E2E above didn't need one.

