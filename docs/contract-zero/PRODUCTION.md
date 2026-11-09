# Production plan: from prototype to game

> **This is a dated progress log.** Each entry records what was true on its date; later entries supersede earlier ones (for example, Cinder Yard gained its own map after the entries that say it shares the depot map). For the current state, read the [README](../../README.md) and [DESIGN.md](DESIGN.md).

The master brief describes months of production. The hackathon deadline is **2026-11-14 23:59 UTC**. This plan orders the brief's milestones by what the final demonstration (brief §17) needs most, keeps every milestone playable, and says plainly what won't make the deadline.

## Audit (2026-11-08)

**Already built and verified (keep; don't rebuild):**
- the deterministic economy;
- NEAR settlement on cz-assets + cz-world v2;
- the commander and merchant fallback agents;
- the Exchange with player-signed trades;
- sign-in (Google, email, passkey, wallet) and quick-trade sessions;
- the raid loop: board → deploy → fight → extract → settlement → changed mission.

**The gap the brief targets** (screenshots of the live build, compared with `artifacts/visual-references/`):

| Area | Today |
|---|---|
| Environments | One 2-room box layout (`LAYOUT_B`) under a flat sky, with three themes (`DUSTLINE`, `REDYARD`, `BLACKSITE`) that change only lighting and fog. There is no environment art in the repo; `IndustrialArena.tsx` is a decorative hangar with no collisions. |
| Screens | Utility panels in the leftover Valor theme (purple and gold tokens, Cinzel font). No hub, Armory, War Room or Settings. |
| Missions | One family (depot raid) and one objective chain. |
| Factions | One faction (Vanguard) and one merchant (Vex); both run fallback policies, and there is no LLM planner yet. |
| Narrative | `story/presence.ts`: three speakers, no triggers. |
| Assets | Mixamo operator rig, five gun models, Poly Haven textures (CC0), and a few sounds with unrecorded sources (see `apps/web/CREDITS.md`). |

**Engine fact that shapes the plan:** a level is data: axis-aligned wall and cover boxes grouped into rooms, plus objectives, spawns and enemies. Collision and AI already run on that data. So new environments are new level definitions plus their own set-dressing meshes, lighting and atmosphere, not an engine rewrite.

## Milestones, in delivery order

| # | Milestone | Target scope by the deadline |
|---|---|---|
| 1 | Visual direction, Operations Hub, unified interface | Design system (graphite, amber, steel blue); one app frame and navigation; operator callsign; a 3D hangar hub showing real data only (operator, stash, next operation, world status, faction activity); Settings (graphics preset) |
| 2 | Distinct environments, better combat presentation | **Dustline Depot** (large outdoor yard) and **Blacksite** (night, interiors, verticality): separate geometry, cover, routes and lighting, each with an FPS profile. Combat feedback pass (hit markers, alert states) |
| 3 | Mission Director | Templates separate trigger, sponsor, objectives, layout, deployment, rules, economic effect and narrative. Families: **Depot Raid** (exists), **Sabotage** (disable production; the economy loses output), **Recovery** (retrieve stolen cargo). Seeded and reproducible |
| 4 | Narrative | Setting and cast document; authored briefings and radio; trigger system on `presence.ts`; LLM lines grounded in verified events, with authored fallback |
| 5 | Competing factions | Second faction (Ashen Compact) and second merchant (Halcyon) with different strategies; LLM strategic planner on NEAR AI Cloud with validation, logging and fallback; faction memory of player actions |
| 6 | War Room | Regional map; causal timeline (trigger → state → proposal → validation → transaction → consequence); Observer Mode clearly marked as simulation |
| 7 | Progression and economy depth | Reputation per faction, career record, equipment tokens and owned-gear loadout |
| 8 | Audio, performance, accessibility | Settings for audio, subtitles and graphics; adaptive quality; licensing audit |
| 9 | Integration and demo | The §17 run end to end in a browser, recorded |

**Expected not to make the deadline** (proposed, documented, not shown as shipped):
- **Mission families:** Convoy Interception with moving vehicles, Escort, Defense, High-Value Target.
- **Environment:** Redyard.
- **Audio:** fully voiced radio (subtitles carry it instead).
- **Trading:** player-to-player listings.

Each milestone's report gives what changed, what's playable, what's verified, screenshots, performance, tests and remaining gaps.


## Progress

### Before Milestone 2: the live world (2026-11-08)

The dev world was the frozen acceptance fixture with a live clock, so it collapsed. The live `genesis` world also stagnated or bled out over long runs. Fixed with live-world economy rules (see `ECONOMY.md`), held by `tests/living.rs`, and the dev world was reset to `genesis` and aligned on chain.

Two infrastructure fixes came out of it:
- NEAR retired `rpc.testnet.near.org`, so every default now points at FastNEAR.
- `world2` and `assets` needed more NEAR for storage, topped up by 1 NEAR each.

### Milestone 2: two playable environments (2026-11-08)

| | Dustline Logistics Depot | Blacksite Research Facility |
|---|---|---|
| Footprint | 60 × 72 m outdoor yard | 44 × 66 m walled site, most of it indoors |
| Structure | Gate and motor pool (trucks, fuel tanks, watchtower, barriers) → container wall with two crossings → warehouse (racks, two doors) and a container yard | Floodlit courtyard (booth, APC, tower, catwalk) → facade with two entrances → corridor, two labs, control room, server room → vault |
| Cargo | Inside the warehouse | In the vault at the back |
| Lighting | Day (DUSTLINE) or dusk (REDYARD); light poles at dusk | Night: moonlight, floodlight beam, fluorescent strips, red server room |

**What's built:**
- **Levels are data** (`engine/fps/levels.ts`): every collider is drawn as what it is (`engine/scene/LevelArt.tsx`), and visual-only art covers roofs, towers, poles, catwalks, beacons and cameras.
- **Raids pick the level from the time of day** the server already sends.
- **Enemies navigate:** A* on a grid with path smoothing (`engine/fps/nav.ts`), and on levels they keep searching for 20 s instead of 6 s.

**Verified:**
- 16 level and navigation tests. Every objective point is on open floor and reachable in order, each level has a second route when the main threshold is blocked, and a full fortified guard (7 + 8) places and can reach the start, over 20 seeds.
- Browser (`apps/web/probe-levels.mjs`, `probe-nav.mjs`, `probe-fps.mjs`): with the player in the warehouse, Dustline guards 27–44 m away converged to 6–10 m through the container gap and the warehouse door. Blacksite guards 44–54 m away closed to 13–31 m through the facility doors in 14 seconds.
- 58–60 FPS at every sampled position on Apple M2 (Chrome, 1280×760). A single dusk sample read 48.

**Fixed along the way:**
- The player was clamped to the old ±9.4 × ±17.6 m compound on every non-endless mission.
- Instanced meshes vanished whenever the world origin was off-screen.
- N8AO's extra normal pass is now off on levels.

**Not done in this milestone:**
- The combat-feedback pass (alert states on the HUD, hit-reaction polish).
- Redyard as its own level: REDYARD is currently the depot at dusk.
- Verticality: enemies are ground-only, so catwalks are visual.

### Milestone 3: Mission Director, sabotage and recovery (2026-11-08)

**Missions come from agent decisions:**
- **Sabotage:** a merchant with a glut pays to knock out a faction's production line of that resource. Success destroys 40% of that stock and halts the line for 36 ticks.
- **Recovery:** a squeezed faction that can't afford to restock seizes a merchant caravan on the road, and the merchant pays for its return. Success returns the cargo to its owner.

In 30-day simulations, sabotage contracts appear every 2 to 3 days. Seizures, and recovery contracts with them, appear only in raided worlds.

**Each kind plays differently** on both levels:

| Kind | What you do |
|---|---|
| Raid | Clear the outer area, load the cargo, walk out |
| Sabotage | Plant two charges in two parts of the site, no clearing required, get clear |
| Recovery | Find the cargo at a different spot, secure it under fire, hand it over at a different exit |

**Built:**
- The board shows the kind, what you do, what it changes, the reward and the guards.
- The server checks a minimum time per kind.
- Sabotage and recovery settle on chain through a new `settle_operation`.

**Verified:**
- 5 economy tests, 5 contract tests, and level tests that the three kinds differ and every point is reachable.
- A live sabotage on testnet (`NEAR.md`).

**Not yet:**
- A live recovery on testnet.
- The other mission families: convoy interception, escort, defense, high-value target, blacksite infiltration.

### Milestone 5: competing factions and the AI planner (2026-11-08)

**Ashen Compact.** A second faction with a mirror economy. It refines fuel (72 a day) and needs ammunition, while Vanguard makes ammunition and needs fuel.

| Doctrine | Vanguard | Ashen Compact |
|---|---|---|
| Base defense | 2 | 1 |
| Price ceiling (× production cost) | 2 | 3 |
| Aggression | 20 | 70 |

**Built:**
- **On chain:** `ashen.contract-zero.testnet` is an actor on `assets` and a faction on `world2`, with a restricted trading key. Existing live worlds gain it on load, minted on chain by the next flow sync.
- **Memory:** each faction remembers, per player, raids, sabotages, recoveries, units lost and when, and which rival paid bounties for raids on it.
- **Rivalry, through bounties the player chooses whether to take:**
  - **Retaliation:** a faction strikes back at a rival that paid for raids on it in the last 72 hours.
  - **Pre-emptive strike:** an aggressive faction pays to bleed a richer rival.
  In 45-day simulations without players, Ashen posts 30 bounties on the richer Vanguard. In raided worlds, Vanguard is no longer richer, so Ashen stops.
- **Selling:** any surplus is sold, so Ashen sells its fuel.
- **Strategic planner** (`apps/api/src/services/planner.rs`) on NEAR AI Cloud (`cloud-api.near.ai/v1`, default model `anthropic/claude-haiku-5-5`), as described above. `POST /admin/plan` runs one round on demand.

**Verified:**
- 5 faction tests (doctrines, pre-emptive strike, memory and retaliation once per grudge, grudges fade, general selling, adding a rival to an older world) and 3 planner tests (policy validation, observation contents, plan parsing). 84 Rust tests in total.
- Ashen reconciles on chain.

**Not verified:** a live model call. `NEAR_AI_API_KEY` is empty in `apps/api/.env`, so the planner logs that it is off and the deterministic policies run alone.

**Not built:** a second merchant (Halcyon). One merchant is enough for the two factions to compete through.

### Milestone 6: the War Room (2026-11-08)

`/war-room` (now enabled in the top bar) answers "what is happening and why":

- **Region map.** Dustline Depot, Blacksite, the Ashen refinery, Vex Exchange and the outer markets, with supply routes, caravans in transit (seized ones in red), contract rings on targeted sites, and sabotaged lines with the hour they come back.
- **Faction cards.** Treasury with history, stock against need (shelf against target for Vex), defense, stance from doctrine, contracts against and paid for, rivals remembered and player grudges.
- **Prices.** Ask and bid for each resource, with a sparkline from `market_history` (migration 0009: one row per tick of prices, merchant stock and every actor's holdings).
- **Why the world changed.** One card per decision or player operation: **trigger → observed state → proposal → validation → transaction → world consequence → gameplay consequence**.
  - Each link is read from a record: the decision log, the settlement row joined by op id (`trade-N`, `sale-N`, `raid:N`, `op:N`) with explorer links, and the ledger events.
  - Actions that don't move assets on chain (defense, escrowed bounties) say so rather than showing a transaction.
  - The gameplay line is a fixed rule per event type, and the page says so.
  - Only a confirmed row shows as "Settled on NEAR".
  - NEAR AI decisions carry their own badge, with a filter.
  - The default "strategic" view hides routine trades under 200 cr and counts them.
- **Faction broadcasts** from the NEAR AI planner, with an honest empty state when the planner is off.
- **Observer Mode.**
  - Sits in a dashed panel badged SIMULATION: "nothing here is live, nothing is saved, and nothing settles on NEAR".
  - Runs 3, 7 or 14 days from now or from a fresh seeded world (which now includes Ashen).
  - Shows treasuries for every faction, mid prices, accepted decisions, simulated raids and the conservation check.

API: `GET /warroom?hours=` and `GET /warroom/timeline?limit=&quiet=`. `/observer/simulate` series now carry every faction. CORS now also allows `http://127.0.0.1:*`, matching the web client's loopback rule.

**Verified:**
- `apps/web/probe-warroom.mjs` (system Chrome): map, faction cards, 16 strategic chains with all seven steps, 12 chains linked to confirmed NEAR transactions, Observer labelled and conservation holding, no failed requests, no horizontal scroll at 390 px.
- Rust (84) and web (449) tests pass.

**Not verified:** NEAR AI chains and broadcasts on the page. The planner key is not set, so they show their empty states.

### Milestone 4: narrative (2026-11-08)

The setting, cast and writing rules are in `docs/contract-zero/STORY.md`.

**Built:**
- **Mission story from verified facts** (`apps/api/src/services/story.rs`).
  - Captured at deployment: the contract's terms; the sponsor's own logged reason for posting it; the target's memory of this player; the rival paying for raids on it; the callsign; the time of day.
  - Stored with the session (migration 0010), so the briefing, the radio and the debrief all describe the same mission.
  - Authored templates always produce a complete story.
  - **The briefing:** a codename, location and time, then Kestrel's terms, the sponsor's reason in the sponsor's voice, and Kestrel's intel.
  - **The radio** fits the mission type: raid, sabotage and recovery each fire their beats from objectives. The target speaks in its own voice: Vanguard Command, or the new **Ashen Compact** speaker with its own radio signature. Its first word acknowledges the player's record against it.
  - **The debrief:** what was taken or destroyed, what was paid, when a sabotaged line returns, and how many operations the target now remembers against you.
- **Optional model voicing.** `GET /missions/{session}/story` asks NEAR AI to rewrite the lines in character, outside the world lock, with a 10 s limit.
  - Each rewrite is accepted only if it keeps exactly the same numbers, adds no names and no out-of-world words, and fits on a subtitle. A failing line keeps its authored text.
  - Proposals and verdicts are logged as `story_call`.
- **Insertion briefing** (`components/story/Briefing.tsx`): a letterboxed card with the codename, location and time, lines typed one by one with speaker colours and scanlines. Space skips, Enter deploys. It waits up to 12 s for a voiced story, then uses the authored one.
- **Debrief** on the results screen. The "what it did to…" panel now names the actual target. The deploy page's buttons now use the design system.

**Verified:**
- `scripts/story-e2e.mjs`, run with a real session against the live world:
  - an unsponsored raid on Ashen: Ashen speaks, Vex buys;
  - a Vex-sponsored sabotage on Ashen: Vex's own logged reason appears in its voice ("My fuel shelf is overstocked while Ashen Compact makes its own…");
  - the story is refused without a session;
  - the debrief follows a loss.
- `apps/web/probe-story.mjs` (system Chrome), on an Ashen-sponsored raid on Vanguard: the codename and all 3 briefing lines render; in the fight, the contract's own opening line plays as Kestrel's subtitle; Vanguard's death line plays; the results screen shows the debrief; no page errors. Runs end by death, so nothing settles on NEAR.
- Tests: 4 story tests (every kind gets a complete story with the real terms; the target's voice and memory; rewrites can't change numbers or names or break the fiction; the debrief matches the result) and 3 radio tests (server lines override per trigger; unknown speakers fall back; every operation kind fires its beats). 88 Rust and 452 web tests pass.

**Not verified:** model-voiced lines. `NEAR_AI_API_KEY` is empty, so every story is authored (`source: authored`, served in 2–3 ms).

**Not built:** recorded voice for per-mission lines (they play as radio static with a subtitle), branching dialogue, and a camera cinematic. The insertion is a briefing card.

### Milestone 9: integration and the §17 run (2026-11-08)

**Built:**
- **`apps/web/demo-run.mjs`.** The 13 steps of brief §17 in a real browser against the live API, the live world and NEAR testnet. It checks each step, screenshots it, records a video, and writes a `report.json`.
  - What is scripted is stated in its header:
    - sign-in by the player's own signed challenge (the wallet path, not the Google pop-up);
    - quick trade opened with the player's own key;
    - the fight flown by scene dev hooks (`__czObjectives`, new and read-only).
  - The server still enforces the minimum mission time.
  - The world clock is never fast-forwarded.
- **`docs/contract-zero/DEMO.md`.** The script for a hand-recorded run: what to click, what to say at each step, the setup checklist and the known gaps.
- **Polish found by the run:**
  - the Exchange moved to the design system (no more cyan and slate);
  - the in-fight header names the contract instead of a campaign "OP 1/15";
  - War Room operation chains show the player's callsign;
  - the demo retries a sale while the raid's cargo is still settling, as a player would.

**Verified** (`docs/contract-zero/demo/report-2026-11-08.json`), one run of 6.7 minutes with 0 page errors:

| § | Result |
|---|---|
| 1 | Sign-in page offers Google and wallet; signed in by wallet-style challenge |
| 2 | Operator WRAITH-6 created; Hub |
| 3 | "OPERATION GREY TALLY": Vanguard's own logged reason for its bounty on Ashen ("Ashen Compact paid for 1 raid(s) on us. Returning the favour…") |
| 4 | 6 contracts, raid and sabotage; chose a raid on Ashen's fuel, 57 units, 9 guards, 434 cr bounty from Vanguard |
| 5 | Assault Rifle (standard issue) |
| 6 | Blacksite at night; radio beats fired from objectives |
| 7 | Cargo extracted; debrief: "We have your name now, WRAITH-6. Ashen Compact remembers." |
| 8 | Player's fuel on `assets.contract-zero.testnet`: 117 → 174 |
| 9 | Sold 5 fuel to Vex for 95 cr via quick trade, settled on chain (quote FXWxx9b1…, trade 7MiAXkgU…) |
| 10 | Ashen made its next decision on the live clock (restocking med) |
| 11 | Raid settlement confirmed: Ph1yRL2cij… (`raid:513`) |
| 12 | War Room operation chain: "raid contract on Ashen Compact's fuel → Operation #513 paid out: 57 units moved, 434 cr fee · on NEAR" |
| 13 | Same depot after: Ashen fuel 96 → 51, defense 2 → 3, haul 57 → 30, guards 9 → 11, bounty withdrawn |

**Gaps:**
- **§5 owned items:** owned gear is Milestone 7, not built.
- **The recording is the automated run.** A hand-played recording with Google sign-in follows `DEMO.md`.
- **Hosting is not done.** It needs accounts for the web app, the API and Postgres; see the report.
- **The NEAR AI planner** has no credits, so no model decisions appear in the run.

### Milestone 7: progression and economy depth (2026-11-08)

**Built:**
- **Equipment tokens.** `gun:marksman`, `gun:ashfall_carbine` and `gun:seraph_lmg` are registered on `assets.contract-zero.testnet`, with a mint cap of 20 per epoch (txs 8S8TKovF…, 2aaPy8iY…, DDT918ST…).
  - In the engine they're `Asset::Gear`. Every asset list (flows, alignment, reconciliation, chain balances) comes from one `ALL_ASSETS`.
- **Vex's armory.**
  - Keeps 2 of each gun on consignment, and reviews stock every 12 hours.
  - Pays its supplier 60% of the list price when one sells, so a sale is always affordable and leaves Vex a margin.
  - Guns sell through the same firm quote as resources: Vex posts an offer, and the player signs `accept_offer`.
  - Gun sales are kept out of resource demand and pricing.
- **Owned-gear loadout.** The SMG and assault rifle are standard issue. Owned guns are selectable; unowned guns are locked and show their price. `POST /missions/start` takes the chosen gun and refuses one the player doesn't own.
- **Standing, computed from what happened** (`World::standing`):
  - **Vex:** a score from credits traded with it plus jobs done for it. Known / Trusted / Partner earn 3 / 6 / 10% better prices on every quote, buying or selling. That discount is real money in the quote the player signs.
  - **Each faction:** contracts it paid you for against operations you ran on it, shown as Hostile, Wary, Neutral, Favoured or Trusted. Today this is shown, not enforced; the target's radio lines already draw on the same memory.
- **Career record** (`GET /me/career`, on the Operator page): totals, standing, owned gear, and every operation with its NEAR settlement link.
- **Exchange:** an armory section with 3D previews, discounted prices shown against the list price, and standing. The trade list names gun purchases.
- **Settlement load:** factions sell surplus only in lots of 10 or more. Over 10 simulated days, trades fall from 157 to 93, and the 91 sales under 10 units disappear.

**Verified:**
- 6 engine tests:
  - gear assets and their token ids round-trip;
  - the armory stocks on consignment and pays its supplier on sale;
  - buying a gun is a firm quote that leaves ammo prices unchanged;
  - purchases are refused without stock or money, or above the player's limit;
  - trading volume earns Vex's 3% tier;
  - factions judge by jobs done for them and operations against them.
- All engine suites, 18 API tests and 452 web tests pass.
- `apps/web/probe-gear.mjs`, signed in as the test player: the armory shows 776 / 1,261 / 2,328 cr, 3% off because the player is Known to Vex. Standing reads Ashen Neutral and Vanguard Neutral (1 job for, 1 against each). The loadout shows all three guns locked with prices. The service record lists 9 operations, 3 extracted and 1,583 cr in fees, with NEAR links. No page errors.

**Verified on chain** (`scripts/gear-e2e.mjs`):
- Deploying with an unowned gun is refused (400, "you don't own the Dustline Carbine").
- Vex quoted a Marksman Rifle at 776 cr, 3% off because the player is Known. Vex posted the offer (FUEWcpZX…) and the player signed `accept_offer` (BqUC2EBE…).
- `gun:marksman` 0 → 1 in `player.contract-zero.testnet`; credits 1,743 → 967.
- Deploying with the Marksman is accepted.
- The loadout shows it as owned and selectable.

**Incident found and fixed during verification (2026-11-08):**
1. **Agent keys ran out of gas allowance.** The Vex, Ashen, Vanguard and server function-call keys spend their allowance on every transaction and never get it back; Vanguard's reached 0.1 NEAR. Its trades failed with `InvalidTransaction` and were reversed in the engine, so the chain drifted, and a ledger batch burning med Vanguard didn't hold on chain blocked about 140 settlements.
   - The owner approved re-issuing the four keys with no allowance cap: same public keys, same `world2` methods (Ce5EeU4M…, A2toHDKc…, 87Kgy5qK…, dvXBUTG1…).
   - Each account was topped up with 1 testnet NEAR from the relayer.
2. **Daily credit mint cap.** The realignment needed more credits than the 50,000 a day the asset contract allows. The owner raised it to 100,000.
3. **Realign target went negative under a deep backlog.** "Economy minus queued trades" can't be met once the merchant has resold goods those trades were still bringing in on chain.
   - New `POST /admin/realign?full=true` retires queued agent trades too and aligns straight to the economy, which has already applied them.
4. **Worker race.** A failed attempt wrote `pending` over a batch the realignment had just marked `superseded`, so the dead batch kept retrying.
   - The worker no longer overwrites a superseded row.

After the full realign the batch confirmed on its first attempt, and the queue drained from about 140 to 0 in under a minute.

### Physical operations: sites, conditions, objects and extraction (2026-11-09)

Before Milestone 8, a playtest found that cargo, sabotage, recovery and extraction were abstract points and timers, and that the world clock moved every contract between the Depot and the Blacksite. Full detail is in `MISSIONS.md`.

**Built:**
- **Sites** (`site.rs`).
  - Every operation is bound to a place the target holds: Dustline Depot, Blacksite, or Cinder Yard (Ashen; shares the depot map for now).
  - The site is chosen by owner, resource and purpose, and is stored on the plan and the session.
  - The world view and the board list each site with its production lines and when a sabotaged line comes back.
- **The clock sets conditions, not places.**
  - Day, dusk and night change the lighting, guard sight (30 / 26 / 20 m), guard accuracy, reinforcement pace and night-vision issue at the same site.
  - The Hub, the board and the contract intel show the hour, the phase, the next change and the accelerated rate.
- **Contract intel before the loadout.**
  - Shows the site, the conditions, a map from the level's real geometry, the objectives, the resistance the faction could arm, the rewards (with the bounty rule) and what you go in with.
  - New order: Accept → briefing → loadout.
  - The loadout is checked against the ledger again (`POST /missions/{session}/loadout`).
- **One interaction system for every object** (`fps/field.ts`, `FieldProps.tsx`):
  - E to interact, with the proximity, view-cone and line-of-sight checks, prompts, hold bars and interruptions described in `MISSIONS.md`;
  - ammunition crates, medical cases and dropped magazines;
  - cargo cases split from the manifest, the seized case, and charges on named targets;
  - the extraction call.
  - Lean right moved from E to G. Touch screens get USE and MED buttons.
- **Ammunition and dressings.**
  - Finite reserve ammunition by round type, with reloads drawing from it.
  - Field dressings: H applies one, and you can carry 3.
  - The arena modes keep unlimited ammunition.
- **Cargo.**
  - 3 cases at most. Each costs 10% movement speed; the seized case costs 20%.
  - A HUD shows what you carry.
  - Going down drops it where you fell.
- **Operation types.**
  - Raid: secure, then extract.
  - Sabotage: plant twice, a 12 s fuse, then a blast with fire, scorch, alarm, radio and reinforcements, then extract.
  - Recovery: retrieve the case, then hand it over at the owner's truck.
- **Extraction zones.**
  - What marks them: a ground ring, a countdown arc and large timer, flares, smoke, the vehicle or a painted landing zone, and radio calls.
  - How they run: E to call it, 8 s inside the zone. Leaving pauses the count and bleeds it back; going down cancels it.
  - The completion screen names what came out. Training ops end at a real zone too.
- **Economic integrity.**
  - The server stores the object list at start; the client reports ids only, and `mission::assess` checks them.
  - The minimum mission time scales with the claimed work.
  - `SettleSecured` pays exactly the carried cases, and a raid bounty needs half the manifest.
  - Death settles nothing, and replays return the first result.
  - Probe hooks and `/dev` routes are compiled out of production builds.
- **Training.**
  - Practice: any implemented site, hour, operation and defense level. Unscored, no economy.
  - Endless: the procedural room chain, now reachable.
  - Campaign: unchanged apart from the extraction zone.
  - Seasonal is documented as not built, with what it needs.

**Verified:**
- **Tests:**
  - engine: all suites, including 3 site tests, 4 manifest/assessment tests and 3 secured-settlement tests;
  - API: 18 tests;
  - web: 469 tests, including 10 field-runtime tests (placement on both maps clear of geometry, holds, refusals, carry limit, drop on death, countdown interruption, fuse, handover) and 5 reserve/dressing tests.
- **Browser** (`apps/web/probe-field.mjs`, Chrome, 1280×720). Dustline Depot raid day and night, sabotage at dusk, recovery by day; Blacksite raid night and day, sabotage and recovery at night. Every run:
  - an ammunition crate taken (rifle reserve 72 → 144, the cap) and a medical case (dressings 1 → 3);
  - a tap takes nothing, and a hold takes a case;
  - two cases carried at 80% speed;
  - nothing secured before extraction;
  - extraction called, the count bleeding outside the zone, then completing;
  - the record matching what was done, e.g. "EXTRACTED · 2 CASES · 40 AMMUNITION" or "HANDED OVER · 60 AMMUNITION";
  - both charges set and the blast fired, on each sabotage;
  - 60 fps throughout and no page errors.
- **A real fight:** 3 kills, the rifle reserve spent 72 → 48 through reloads, 2 dropped magazines, and the sidearm reserve 36 → 54 from a pistol magazine.
- **An incidental check:** a player shot down while carrying two cases dropped both, and the HUD went back to 0/3.
- **Pages** (`apps/web/probe-modes.mjs`):
  - the Hub clock ("Day 45 · 15:00 · Day · Dusk at 17:00, in about 2 min");
  - board entries at their own sites ("Blacksite · medical vault · by day");
  - contract intel before any loadout control, with a 55-shape map;
  - Practice at Blacksite, dusk, recovery, L4 (unscored);
  - Endless running on the generated chain with finite ammunition;
  - the Campaign ending at an extraction zone;
  - no page errors.
- **Live API** (`scripts/field-e2e.mjs`), 14 of 16 checks so far:
  - sites on the board, and the same contract at the same site;
  - 4 cases for 123 units;
  - an unowned gun refused at loadout;
  - a duplicate case, an unknown case, no record and a too-fast run all rejected;
  - death settling nothing;
  - a partial extraction settling exactly the carried case (31 of 123 ammunition, bounty withheld);
  - a replay settling nothing new.
  - The two on-chain checks were waiting on the settlement queue (below).

**Known limits:**
- Cinder Yard has no map of its own.
- Enemy weapons can't be picked up; guards drop magazines instead.
- A modified client can claim a case it didn't carry (but never invent, repeat or exceed one).
- No item inspection screen beyond the prompt's contents line.
- The sabotage blast is procedural (no particle system).

### Milestone 8: settings, accessibility, performance and licensing (2026-11-09)

**Built:**
- **One settings model** (`lib/settings.ts`), applied live in fights:
  - graphics: Auto, High, Medium or Low, plus field of view;
  - a five-channel volume mix, with background mute;
  - subtitles: on or off, size, backing and speaker colours;
  - look sensitivity, and toggle-to-interact;
  - reduce motion, and reduce flashes.
  - The old keys are migrated, and the pause menu writes to the same settings.
- **A new Settings page:** labelled native controls, keyboard focus rings, test buttons per volume channel and a live subtitle preview.
- **Adaptive quality that works.**
  - A tested stepwise controller (`engine/perf/autoQuality.ts`) replaces drei's `PerformanceMonitor`, which never triggered at 30–38 fps.
  - There is a new Medium tier.
  - Auto remembers where it settled.
- **Accessibility:** the dim text token was raised to WCAG AA contrast, and so were the faint HUD hints.
- **Licensing:**
  - The three unsourced gun GLBs were replaced with original procedural models, with hands and framing retuned.
  - The unsourced gunshot and impact samples were replaced with original synthesised ones (`scripts/generate-sfx.mjs`).
  - The unused melee sounds were removed, and the raw Mixamo FBX files moved out of `public/` into the git-ignored `assets-src/`.
  - Dependency audit script; `LICENSING.md` and `CREDITS.md`.

**Verified:**
- **Tests:** web 498, including settings normalisation and migration, auto-quality steps, and the quick-trade rule.
- **`probe-a11y.mjs`:** all nine pages pass with no WCAG 2.1 AA violations; before the fix there were contrast failures on three.
- **`probe-settings.mjs`:** set by keyboard and mouse, then confirmed in a fight:
  - FOV 70, the low tier (pixel ratio 1, no shadow casters), 21 px subtitles, effects at 0;
  - one-press E took a crate;
  - camera roll was 0 with reduced motion;
  - changes mid-fight applied live;
  - background mute engaged.
- **`probe-perf.mjs`:** fps, frame times, draw calls and triangles per map and tier, on GPU and with the CPU throttled 4×. Low runs at 60 fps on every map with about half the draw calls. Auto stepped Blacksite at 2× from about 30 to 60 fps.
- **`license-audit.mjs`:** npm 110 of 111 permissive and Cargo 640 of 643, with the four weak-copyleft packages used unmodified (see `LICENSING.md`).
- **`probe-field.mjs`:** a regression raid still extracts at 60 fps.

**Open:**
- No colour-blind palette or key remapping.
- The 3D fight isn't screen-reader accessible.
- No real-phone or Firefox/Safari measurements.
- `wee_alloc` should be disabled at the next contract deployment.

See `ACCESSIBILITY.md`, `PERFORMANCE.md` and `LICENSING.md`.
