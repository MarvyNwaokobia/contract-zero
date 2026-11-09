# CONTRACT ZERO — Game Design

**Status legend.** **Built:** in the codebase and tested. **Proposed:** designed here, not yet implemented. Every section ends with acceptance criteria a judge or a test can check.

## 1. The game

CONTRACT ZERO is a first-person extraction shooter set in a frontier held together by supply lines. You are a contractor. You raid, escort and sabotage for whoever pays, and you keep what you carry out. The factions and merchants around you are autonomous economic agents. They hold real inventories and treasuries on NEAR, they remember what you did, and they respond.

**The promise:** every fight changes the world, and the world decides the next fight.

**Pillars**

1. **Tactical, lethal, readable combat.** Fights are short and decided by positioning and cover. Lethality is high and every guard's loadout is visible in how hard it hits. (Built: FPS engine, `engine/fps/FpsSim.ts`.)
2. **The economy is the level designer.** Guard counts, loadouts, reinforcements, mission availability, rewards and prices all come from live economic state, through rules a player can learn. (Built for depot raids: `crates/economy/src/mission.rs`.)
3. **Agents with motives, not scripts.** Each faction and merchant pursues its own objectives with its own budget and memory. Its decisions are validated and logged with their reasons. (Built: deterministic policies. Proposed: LLM planning and memory.)
4. **You own what you take.** Extracted cargo and bought equipment are NEP-245 tokens in your account. You can sell them, use them, or trade them to another player. (Built: cargo settles to the player on chain. Proposed: equipment items and player-signed trading.)
5. **Every consequence is observable.** The War Room shows why the world changed: what triggered each decision, what it cost, whether it settled on NEAR, and what it did to your next mission. (Proposed. The event feed and reconciliation it reads from are built.)

## 2. The player experience

**Every 30 seconds (the fight).** You move between cover, read the guard composition, and decide where to push. A guard with a sidearm hits for 45% of a rifle guard; you can hear and see the difference. While you load the cargo, reinforcements arrive at a cadence set by the faction's medicine. Dying ends the run and costs you the consumables you brought.

**Every five minutes (the contract).** You pick a target on the Contract Board. Each entry tells you what the depot holds, how many guards it could actually arm, what the cargo is worth at each merchant, and who is paying a bounty. You load out from gear you own, deploy, fight, and extract. Extraction Results shows what you took, and the board then shows how the target has changed. On the next world tick its commander reacts: it buys stock, raises escorts, or hires someone to come after you.

**Every session (the campaign you write).** You decide who to support and who to bleed:

- **Raid a faction until it starves.** Its guards thin out, its convoys stop running for lack of fuel, and its depots disappear from the board.
- **Sell your loot.** You earn credits, but you also restock the merchant who supplies your target, so the next raid is harder.
- **Hoard your loot.** The price climbs while you sit on it.
- **Take a faction's contract.** Its standing with you rises, and its rival's falls.

Prices, standing and the next missions all carry over between sessions.

**Acceptance (Built for the core loop):** from the Main Menu a new player can pick a depot, load out, fight, extract, see the result, and see the next mission change. This was verified by `apps/web/probe-loop.mjs` and by `scripts/acceptance-e2e.mjs` on NEAR testnet.

## 3. The world: actors with competing objectives

| Actor | Kind | What it wants | How it plays | Status |
|---|---|---|---|---|
| **Vanguard** | faction (industrial military) | Hold its territory; keep two days of every resource | Produces ammunition and receives fuel shipments. Defensive: raises escorts after raids and buys to restock. It sells surplus ammunition to merchants | Built (selling surplus through sell orders, §8a) |
| **Ashen Compact** | faction (fuel-refining militia, Cinder Yard) | Bleed Vanguard; survive on what it can take | Refines fuel, short of ammunition, light garrison. Aggressive: pays bounties to have Vanguard raided first, and retaliates against rivals that paid for raids on it | Built |
| **Vex Exchange** | merchant (wholesale) | Profit on volume | Deep stock, wide margin, imports by caravan. Sponsors raids on whatever its shelves lack. Goes insolvent if it overpays | Built |
| **Halcyon Logistics** | merchant (lean supplier) | Win routine business | Smaller shelves, a thinner margin (12%, floor 8%), commits at most 60% of a shelf to one order; competes with Vex for every supply order and reprices on win/loss streaks | Built (§8a) |

**Why these four:**
- **Two factions** create sides: helping one hurts the other, and they react to each other's weakness as well as to you.
- **Two merchants** create price competition: the cheapest seller depends on stock, so buying or dumping at the right place is a skill. Arbitrage between them is real but self-correcting, because every trade moves both price curves.

**Architecture.** Actors are `Actor` records in `World` (`crates/economy/src/lib.rs`) with income, production, consumption, a reserve policy, defense and shipments. Each merchant has a `MerchantProfile` (its own targets, strategy, floor, commit limit and record) and prices from its own shelves (`World::merchant_quote`); Vex's profile is also the instant market's.

**Acceptance:**
- **Factions react to each other:** with Ashen Compact present, a simulated week shows its contracts against Vanguard rising as Vanguard's stock falls.
- **Price competition:** with two merchants, the same purchase quotes differently, and a large purchase from the cheaper merchant raises its price above the other's. A test asserts both.

## 4. The economy

**Assets.**

| Asset | Kind | Status |
|---|---|---|
| Credits | fungible | Built |
| Ammunition | fungible resource | Built |
| Medical supplies | fungible resource | Built |
| Fuel | fungible resource | Built |
| Equipment | weapons (Built: gun tokens, owned-gear loadout); attachments, armor (Proposed) |

**Equipment** would use the engine's existing gun catalog (`engine/combat/GunStats.ts`, tiers 1–10) and attachments (`engine/combat/Loadout.ts`). Each owned item would be a distinct NEP-245 token, so it has provenance.

**Sources and sinks.** Built and documented in `ECONOMY.md`. All issuance and destruction goes through one source/sink account and is totalled separately from transfers; tests check conservation every tick.

- **Sources:** production, income, and supply shipments that arrive.
- **Sinks:** consumption, the fuel burned by logistics, escort wages, and import costs.
- **Player-side sinks (Proposed):**
  - Ammunition you bring is consumed on deployment.
  - Medkits are spent to revive.
  - On death you lose the consumables you carried.

  This makes your loadout a real economic decision, and keeps credits from piling up without limit.

**Scarcity and logistics.** Built.
- Fuel gates both shipments and whether a depot can be staged.
- An unaffordable defense level drops to what the actor can pay.
- An insolvent merchant stops buying and restocking.

**Pricing.** Built. A pure function of stock against target, production cost and net demand over the last day. It's bounded to [cost, 4 × cost], and big orders walk the price curve one unit at a time.

**Acceptance (Built):** 45 economy tests, covering:
- conservation, determinism and JSON round-trips
- atomicity, stale-quote races, insolvency and price discipline
- every economy-to-battlefield rule
- the acceptance scenario and its no-stock, partial-stock, over-budget and rejected-proposal branches

## 5. Autonomous agents

**The loop:** observe → plan → validate → execute → settle → remember.

| Stage | What happens | Status |
|---|---|---|
| Observe | The agent receives a structured observation: its holdings, requirements, budget and defense; each merchant's quote and stock; recent raids on it; open bounties and contracts; and its memory (below) | Built for the deterministic policies |
| Plan | The planner proposes up to N actions as typed tool calls. The tools are exactly the engine's `Action`s: `request_quote` (read), `purchase_supplies`, `sell_supplies`, `post_bounty`, `post_contract`, `configure_defense` and `set_strategy`. Each carries a one-sentence rationale | Built: the deterministic planner, and an LLM planner on NEAR AI Cloud (`services/planner.rs`, including `request_supplies`). The LLM is off until the NEAR AI account has credits |
| Validate | The proposal is parsed against the tool schema, authorized for this agent, and dry-run in the engine on a copy of the world. Anything malformed, unauthorized or failing is rejected with its reason and logged | Built: schema, policy (`planner::validate`) and the engine, for both planners |
| Execute | The accepted action is applied to the live world under the world lock | Built |
| Settle | Value-moving actions are queued for NEAR and confirmed at FINAL | Built |
| Remember | See below | Built in part |

**The LLM never touches keys or balances.** It produces JSON. The server validates it and signs with the agent's restricted key. If the model times out, returns an invalid schema or proposes something rejected, the deterministic policy acts for that turn and the log records which planner acted.

**Strategy profiles** make agents behave differently from the same information:

| Profile | Risk tolerance | Spending policy | Behavior |
|---|---|---|---|
| Vanguard: "Quartermaster" | low | keep 30% of credits in reserve | Restock early, escort heavily after raids |
| Ashen: "Opportunist" | high | spend down to 10% | Buy medicine first; post contracts when Vanguard's stock is below target |
| Vex: "Wholesaler" | medium | — | Widen margin when shelves are low; sponsor raids for scarce goods |
| Halcyon Logistics (**Built**) | medium | credit reserve 400 | 12% margin with an 8% floor, smaller shelves, commits at most 60% of a shelf to one order; never sponsors raids. Competes with Vex for every supply order (§8a) |

The deterministic policy is parameterized by the profile, and the LLM gets the profile as its standing orders.

**Memory.** **Built:** each faction remembers, per player, the operations run against it, and per rival, the bounties it paid for raids on it (`FactionMemory`); retaliation and the planner's observation use it. **Proposed:** the richer summaries below, kept in Postgres and summarized into the observation:
- **Episodic:** the last N decisions and their outcomes. For example: "bought 24 ammo at 21; the next raid still took 39".
- **Beliefs:** derived numbers updated each tick, such as the raid rate per depot, the price trend per merchant, and its standing with each player.
- **Commitments:** open bounties and contracts it funded, and when they expire.

Memory changes behavior: an agent that has been raided three times on fuel prefers escorts over restocking fuel. That's a testable rule.

**Cadence.** The world clock drives the agents. They act whether or not anyone is playing (Built: `services/scheduler.rs`).

**Acceptance:**
- **Built:** decisions are logged with trigger, figures, action, rationale and validation (`GET /events?kind=agent_decision`). The acceptance run shows an autonomous purchase that settled on chain.
- **Built and tested:** an invalid LLM proposal is rejected and the fallback acts (`planner` tests); a remembered grudge changes a faction's decisions (`tests/factions.rs`).
- **Awaiting credits:** with a funded NEAR AI key, at least one logged decision per agent per day comes from the LLM.

## 6. Missions generated by the economy

A mission is a pure function of live state, so the server validates exactly the mission the client builds. The rules live in `crates/economy/src/mission.rs`; the client builder is `engine/fps/convoy.ts`.

| Mission | Generated when | Economic effect | Status |
|---|---|---|---|
| **Depot raid** | A faction holds ≥ 20 fuel and a depot of ≥ 10 units | The cargo goes faction → player | Built |
| **Convoy intercept** | A faction shipment is in transit | The shipment never arrives; its cargo goes to the player | Proposed (shipments already exist in the economy) |
| **Escort** | A merchant caravan is in transit and its owner posts a contract | Success delivers the cargo and pays the contract; failure means a sponsor's raiders take it | Proposed |
| **Sabotage** | A rival funds it against a produced resource | Stock is destroyed, not transferred, and that line stops producing for 36 hours | Built |
| **Recovery** | A faction seizes a merchant caravan and the owner posts a contract | The cargo goes back to its owner for the fee | Built |

**Where and how it's played** (Built; full detail in `MISSIONS.md`):
- **Site.** Every operation is bound to a site the target holds: Dustline Depot, the Blacksite, or Cinder Yard. The site is chosen by owner, resource and purpose, so the clock never moves the objective.
- **Conditions.** The hour sets them at the site: lighting, guard sight and accuracy, how fast relief arrives, and whether night vision is issued.
- **Physical objects.** The player acts on objects with E:
  - cargo cases split from the manifest, carried and slowing you down;
  - charges set on named targets;
  - the one seized case.
- **Supplies.** Ammunition is finite and replenished from crates and dropped magazines; field dressings come from medical cases.
- **Extraction.** Each operation ends at a marked zone: a vehicle or a painted landing zone, flares, smoke, and a countdown that pauses when you leave.
- **Settlement.** The server settles only what its own manifest says the reported objects hold.

**The resource rules apply to every mission type** (Built for depot raids):

| Resource | What it controls |
|---|---|
| Ammunition | Guard count and loadout; a guard who can't be armed doesn't deploy |
| Medicine | Reinforcements during the hold |
| Fuel | Whether the mission exists at all |
| Defense posture | Guard HP and planned headcount |

**Acceptance:** each mission type has a property test showing that its plan never uses more ammunition than the target holds, and that its outcome conserves value. The acceptance run already shows a raid changing the next mission (5 rifle guards → 3 rifles + 1 sidearm at a higher defense level).

## 7. Player progression and ownership

| Track | How it works | Status |
|---|---|---|
| **Rank** (reputation) | XP from kills and clears (`engine/fps/xp.ts`). Never pays currency | Built |
| **Faction standing** | Per faction, a score from your jobs for it against your operations on it; Vex's tiers (Known, Trusted, Partner) give better prices | Built (`Standing`). Unlocking contracts by standing: Proposed |
| **Owned gear** | Equipment tokens in your account, bought at the Exchange or recovered from missions. Only owned gear can be loaded out, and the loadout screen shows each item's stats and resale value | Built: guns are tokens in your account, bought in the Armory; the loadout offers only what you own and the server checks it against the ledger |
| **Consumables at risk** | You bring ammunition and medkits from your inventory; whatever you carry and lose is destroyed | Proposed |

**Acceptance:**
- A player who sells ammo to Vex sees Vex's ammo stock and Vanguard's ability to restock rise in the War Room.
- A player cannot deploy with gear they don't own; the API refuses it.

## 8. The market and the Exchange

**Exchange screen (Built for merchant trades: `/exchange`, `GET /exchange`, `POST /exchange/quotes`).** Live bid and ask at each merchant, with the pricing factors behind them, plus your holdings and what they'd sell for at each. Actions:

| Action | What happens | Who signs on chain |
|---|---|---|
| **Buy** (Built for supplies; equipment Proposed) | The merchant posts a firm offer addressed to you; you accept it with your price ceiling | Vex posts (`post_offer`); **you** sign `accept_offer`. Both legs settle atomically in `cz-assets` |
| **Sell** (Built) | The merchant posts a firm bid addressed to you; you accept it with your price floor | Vex posts (`post_bid`); **you** sign `accept_bid` |
| **List** (P2P, Proposed) | Put an item up for another player; it sits in escrow in `cz-assets` | The seller |
| **Buy listing** (P2P, Proposed) | Another player's listing settles atomically | The buyer |

**How a player trade stays honest (Built).**
- **The quote is firm.** While a quote stands (5 minutes), the merchant's side is held in escrow in the economy, so no agent can buy those goods out from under you. Reconciliation counts the hold as the merchant's, because on chain it still is.
- **Players own their tokens.** The economy treats the chain as the truth for a player: before quoting, it resyncs your holdings from `cz-assets`. Tokens you moved in or out of the game cross an explicit `OUTSIDE` boundary account, which is never counted as issuance or destruction.
- **The trade settles only once value has moved.** The economy settles the quote only after `cz-assets` reports that the operation applied.
- **A lapsed quote is cleaned up.** A quote that isn't accepted in time is cancelled on chain by Vex, and the hold is released.
- **Your trades move the market.** Player purchases and sales feed the same demand and stock terms in the price as agent trades.

**Shortage signals (Built).** When a faction falls below its target, the Exchange flags it and links to the Contract Board. Players can see the opportunity and act on it: raid to deepen the shortage, or sell into the higher price.

**Acceptance:**
- *(Passed on testnet, `scripts/exchange-e2e.mjs`.)* A player sells extracted ammo and buys medkits. Both trades settle on NEAR, each signed by the player's own key, and the player's engine balances equal their chain balances. A quote left unsigned is cancelled and released.
- *(Proposed.)* A player-to-player listing transfers atomically, or not at all.

## 8a. Supply Orders: an intent-driven war economy (Built)

**The idea.** Nobody "buys from Vex" any more except at Vex's instant counter. A faction that runs short, or a player who wants a better price, states an intent and lets the market compete for it:
- **what:** 30 ammunition;
- **limit:** at most 600 credits;
- **flexibility:** partial fills fine;
- **deadline:** within 6 hours.

Every merchant decides for itself whether to answer, and at what price, from its own shelves, treasury, margin, floor and risk limit. The requester picks.

**Why it matters in play.**
- **Raids reach the market.** Your raid empties a depot. The commander's order goes out, and the competition between Vex and Halcyon decides how fast and how dearly it restocks. That sets how many rifles the next defenders carry.
- **Urgency costs.** A critically short faction takes the biggest lot, not the cheapest. A comfortable one shops around, waits out a price spike, or withdraws when a shipment arrives.
- **Merchants learn.** One that keeps losing cuts its margin, and Vex's instant prices follow. One that keeps winning raises its.
- **Players are in the same market.** You can sell your raid's haul to the best bidder, or buy below Vex's ask by letting both partners compete. Your orders move the same shelves and prices the factions trade against.

**Guarantees** (the contract enforces them; the economy mirrors them):
- **Escrow.** The requester's side is escrowed when the order is placed, so nothing unfunded can be promised. A merchant's proposal reserves its goods, so nothing is promised twice.
- **Limits.** Every fill is held to the order's price limit pro rata, in exact integers.
- **Control.** Only the requester accepts or cancels. Cancel and accept can't both happen. Unused escrow always returns.
- **On chain.** Every step is on chain with its transaction. Faction steps are signed with each actor's scoped key. Player steps are signed by the player and verified before the economy applies them.

Full design, the contract, the agents, settlement, the NEAR Intents adapter and the evidence: **[INTENTS.md](INTENTS.md)**.

## 9. On-chain architecture: `cz-assets` + `cz-world` v2

**Why split.** The first single contract (`world.contract-zero.testnet`, verified on testnet and now frozen) kept every balance and all game logic in one account, so it:
- couldn't upgrade the game without redeploying the ledger
- gave the server's key reach over the whole ledger
- could only send tokens to accounts the server has registered, which blocks wallets and NEAR Intents
- had no NEP-245 metadata

The split fixes each of these without losing atomic trades.

| Contract | Holds | Authority |
|---|---|---|
| **`cz-assets`** (NEP-245 ledger) | Every token balance, NEP-245 metadata, storage deposits (NEP-145), issuance budgets | **Holders** move their own tokens (1 yoctoNEAR, standard `mt_*`). **The controller** (`cz-world` v2) may mint and burn within per-epoch issuance budgets set by the owner, and may move tokens only between registered actors, or from a player who has approved that specific operation. **The owner** (a cold key) sets the controller and budgets and pauses in an emergency |
| **`cz-world` v2** (game controller) | Raid records, offers and bids, contracts, the replay set, actor roles | **The server** settles raids and applies flows (through the controller). **Merchants** post offers and bids; **buyers and sellers** accept them. Everything that moves value is a single cross-contract call into `cz-assets`, which applies all legs atomically in its own receipt |

**Atomicity.** A trade's two legs, goods one way and credits the other, are moved by one `cz-assets` call, `controller_settle`. That call applies every leg or panics, so there are no half trades.

**Asynchrony.** `cz-world` v2 marks an operation as pending before calling `cz-assets`, then commits or rolls back in a callback. The operation ID is consumed only when the callback sees success. A failed call releases the offer.

**Storage.**
- **Players** register with a NEP-145 storage deposit, which the server can sponsor.
- **Actors** are registered by the owner.
- **Receivers:** `cz-assets` accepts transfers to any registered account, so wallets and NEAR Intents work once registered.

**Issuance.** Mints are capped per entry, per batch and per epoch (rolling 24 h) per token. Exceeding the budget panics, so even a compromised server key can only inflate within one epoch's budget.

**Replay protection.** Operation IDs are consumed in `cz-world` v2, and `cz-assets` independently refuses a controller operation ID it has already seen. Both layers have to agree.

**Migration from v1.** This is the documented procedure in `docs/contract-zero/MIGRATION.md`:
1. Stop the settlement worker.
2. Drain the queue.
3. Freeze v1 by registering a `migrated` flag through an owner call, after which settlement on v1 is refused.
4. Snapshot v1's balances over RPC.
5. Mint them in `cz-assets` under a single `migration:v1` operation ID.
6. Reconcile v1 against v2.
7. Repoint the API.

The settlement queue records the contract each row belongs to, so the old and new contracts can never settle the same event.

**Acceptance:** contract tests for every authority boundary, storage, issuance budgets, replay at both layers, and a failed cross-contract call releasing its offer. On testnet:
- the migration reconciles exactly
- v1 refuses settlement after the freeze
- the raid → autonomous purchase → settlement → changed-mission sequence passes again on v2

## 10. Identity and onboarding

**Requirement:** a player signs in without seed phrases. Game actions that don't move the player's assets need no popups. Moving the player's own assets (selling, listing) takes their explicit authorization.

**What a player must be able to do on chain:** sign `accept_offer` / `accept_bid` on `world2` as themselves. Both methods are deposit-free.
- The controller pays the player's ledger storage from its sponsorship quota, so a player needs no NEAR deposit.
- `cz-assets` debits a player only when the player is the transaction's signer.

**FastAuth evaluation (2026-11-08).** FastAuth is now "NEAR Auth": Auth0 login (Google, Apple, email, passkey) with an MPC-derived key (`@fast-auth-near/react-sdk`, `@fast-auth-near/browser-sdk`).
- **It can satisfy the authorization model.** It signs arbitrary transactions for the user, so it can sign an accept, and the relayer creates the account with gas and deposit covered.
- **But every signature is an Auth0 popup or redirect.** The docs document no way to add a function-call key.
- **It needs an Auth0 client ID.** Mainnet requires approved credentials.

So it suits players without a wallet, but it isn't a drop-in. **Decision:** ship wallet sign-in now and add NEAR Auth as a second sign-in method once we have a client ID.

**Built: NEAR Connect** (`@hot-labs/near-connect`). Wallet sign-in on testnet with HOT, Meteor, Intear, MyNearWallet, Nightly, Ledger, EVM wallets and NEAR CLI.
- **Every trade is an explicit wallet confirmation.** That's deliberate: a trade moves the player's own assets.
- **We don't use a silent function-call key for trading.** Vex is run by the game server. A key that accepts any quote addressed to the player, without a prompt, would let a compromised client accept a lowball bid on the player's behalf.
- **Silent keys are reserved for actions that move none of the player's assets** (Proposed: none exist yet).
- **Mission identity:** *(superseded below)*.

**Built (2026-11-08): sign-in with Google first, sessions bound to on-chain accounts, and quick trade.** See [AUTH.md](AUTH.md) for the design and for what is verified versus documented.
- **Sign-in options:** Google (default), email or passkey via NEAR Auth, and "I already have a NEAR wallet" (NEP-413) as the fallback.
- **Sessions:** every player action now acts for the session's proven account; a supplied account ID is never accepted as proof.
- **Quick trade:** a browser-held session key scoped to `world2`, with budgets and an expiry enforced by the contract, revocable by the key itself.
- **Trades aren't gas-relayed:** in a meta-transaction the chain sees the relayer as the signer, so a relayed trade could never prove the player's consent (verified on testnet).

## 11. The War Room

The War Room explains the world rather than only measuring it. Every major economic action is shown as one causal card:

> **Trigger** (raid on Vanguard's ammo depot, 60 units) → **Agent** (Vanguard commander, "Quartermaster") → **Context** (41 of 84 ammo, budget 740, Vex asks 18) → **Proposal** (buy 24 ammo for 517) → **Validation** (accepted) → **Settlement** (confirmed, tx `D276igAR…`) → **Updated state** (ammo 65, credits 523) → **Gameplay consequence** (next ammo raid: defense L3, 3 rifles + 1 sidearm).

**Panels:**
- the causal timeline
- each actor's holdings against its requirements
- prices with their factors
- the settlement queue with explorer links, and live reconciliation (`GET /reconciliation`)
- **Observer Mode:** a seeded simulation on a copy of the world, labelled simulated everywhere (Built: `POST /observer/simulate`)

Model reasoning stays private. The cards show the structured trigger, context and one-line rationale only.

**Acceptance (Proposed UI, Built data):** after a raid, the War Room shows the full card above within one world tick, the settlement turns from "settling" to "confirmed" only after FINAL, and Observer Mode never shows a transaction hash.

## 12. Presentation

These build on the working FPS engine; nothing here is a rewrite.

- **The depot map.** Dress the raid compound as a depot using the restored `IndustrialArena` as a visual backdrop outside the playable walls, and `ItemMesh` cargo crates in the yard.
- **The HUD.** It shows the guard composition you face (rifles and sidearms) and the cargo progress.
- **Voice.** The radio cast speaks the economy: the handler names the depot and its guard count, and the convoy owner reacts to your raid.
- **Onboarding.** A first contract that teaches the loop in under five minutes.
- **Visual identity.** Consistent across Main Menu, Board, Armory, Exchange and War Room.

## 13. Delivery order and status

| # | Milestone | Status |
|---|---|---|
| 1 | FPS engine, convoy raid mission, contract mode | Built |
| 2 | Deterministic economy, economy-to-battlefield rules, acceptance scenario | Built |
| 3 | API: board, mission sessions, world clock, decisions, Observer Mode | Built |
| 4 | CZ World v1 on testnet, settlement, reconciliation, on-chain acceptance run | Built |
| 5 | This design | Built |
| 6 | `cz-assets` + `cz-world` v2, migration, acceptance re-run on v2 | Built (deployed on testnet; acceptance passed on v2) |
| 7 | Merchant bids (commander selling), player ownership, Exchange, onboarding | Built: commander selling; the Exchange with player-signed buys and sells on testnet; wallet (NEP-413) and NEAR Auth sign-in; equipment tokens and owned-gear loadout. Proposed: P2P listings |
| 8 | Second faction and merchant, strategy profiles, memory | Built (Ashen Compact, Halcyon Logistics, doctrines, faction memory; §8a supply orders) |
| 9 | LLM planner on NEAR AI Cloud with validated tool calls | Built (off until the NEAR AI account has credits) |
| 10 | War Room UI and the causal timeline | Built (including supply-order procurement chains) |
| 11 | Mission types: intercept, escort, sabotage, recovery | Built: sabotage, recovery. Proposed: intercept, escort |
| 12 | Presentation pass and onboarding mission | Built: three site maps, Practice, the Field Manual, first-time tips (README, PLAYER_GUIDE.md) |
