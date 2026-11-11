# Living World: audit, direction and delivery status

Working document for the "make the economy tangible" effort. Section 1 is the audit that precedes any change. Section 3 says exactly what is built and what is not.

## 1. Audit (2026-11-10)

Baseline: 515 web tests passing; production build was **failing at HEAD** on a test-setup typing error (fixed, see commit). ESLint does not run in a fresh checkout (`eslint-config-next` patch failure); not addressed here.

| Area | Where | State |
|---|---|---|
| Hub, 3D hangar | `components/hub/HangarScene.tsx` (418 lines), `app/page.tsx` | Real R3F scene. Not driven by economy state. |
| Contract Board | `app/contracts/page.tsx` | Text cards. Guard/medicine wording was hard-coded to "Vanguard" (**bug**, fixed). |
| Contract Intel / Briefing | `components/world/OperationIntel.tsx`, `SiteMap.tsx`, `story/Briefing.tsx` | Strong: built from the same mission data the fight uses. Resistance text derives from real enemy list. |
| FPS levels | `engine/fps/levels.ts`, `serverLayouts.ts`, `cinderYard.ts`, `scene/LevelArt.tsx`, `arenas/IndustrialArena.tsx` | Three site layouts exist and are tested (`levels.test.ts`, `serverLayouts.test.ts`). `ContractZeroScene.tsx` is a 5,164-line monolith. |
| Armory | `components/armory/*`, `inspect/*` | Turntable and inspector exist. |
| Exchange / Supply Orders | `app/exchange`, `components/market/*` | Functional; procurement is a numbered text list. |
| War Room | `app/war-room/page.tsx` (411 lines) | Hard-coded SVG map (`SITES` coordinates, fixed `ROUTES`), actor cards with raw stock bars, causal timeline, simulation. Convoy dots animate from the server's real `progress`. |
| Audio | `engine/audio/FpsAudio.ts` (live), `MusicLayers.ts`, `spatial.ts`; `AudioDirector.ts` was dead code (deleted) | Fully synthesised, six buses, adaptive 0-3 score. See the Audio audit below for gaps (ambience keyed to time of day not site, no voice budget, no recorded voice). |
| Settings / a11y | `lib/settings.ts`, `app/settings`, `docs/contract-zero/ACCESSIBILITY.md` | Infrastructure exists, including key rebinding and toggles. |
| NEAR settlement | `apps/api/src/services/settlement.rs`, `contracts-near/*` | Not touched by this work. |

**Technically functional, visually underdeveloped:** the War Room map and actor cards; procurement chains; the Exchange.
**Technically present, disconnected from state:** the hangar scene; level environments (no depletion, idle machinery or alarms from real data).
**Where players must read technical text:** War Room cards (raw `stock/need` bars), procurement steps (JSON-ish rationale strings), faction defense as an unexplained 1-5 pips.

### Screenshot and demo review

Reviewed from `docs/media/*.jpg` and `docs/contract-zero/demo/report-2026-11-09.json`. **No gameplay recording is in the repo** (video output is git-ignored), so this is a review of stills and the run report. The 2026-11-09 run: 16 steps, 7.6 minutes, 0 page errors.

| Finding | Evidence | Belongs to |
|---|---|---|
| The Hub's "Next operation" card is clipped by the status panels below it at 1280x720 | `hub.jpg` | Phase 5, Hub. Eased by the compact readiness strip (card fully visible at 1280x720 with mocked data); the underlying fixed-height layout is unchanged. |
| Hub and Exchange show raw `stock/target` bars and rationale strings ("Treasury strong (11127 cr): extra patrols") instead of meaning | `hub.jpg`, `warroom-causal.jpg` | Phase 2 (War Room done; Hub next) |
| War Room decision cards are a 7-row text table; the "gameplay" row is the only one a player cares about | `warroom-causal.jpg` | Phase 3/4 |
| Exchange order history is a text ledger; winner and losing bidders are not visible as a contest | `exchange-orders.jpg` | Phase 4 |
| Contract Intel is thorough but entirely text; the site map is the only visual | `intel.jpg` | Phase 5 |
| Cinder Yard reads as beige cylinders and rails; no steam, machinery or catwalk life; tanks are plain flat-shaded | `fight-cinder-yard.jpg` | Phase 6 |
| Blacksite at night has good mood (NVG, corridor light) but rooms are boxes with little set dressing | `fight-blacksite-night.jpg` | Phase 6 |
| In-fight HUD: control hints top-right are tiny and low contrast; weapon name overlaps the NVG/light chips bottom-right | both fight shots | Phase 5/10 |
| The fallback radio line "Contract's live. The cargo is in the yard... Load it, walk it out" is shown on sabotage and recovery missions; `vanguard-*` lines name Vanguard regardless of the site's owner | `fight-*.jpg`; `engine/story/presence.ts:71` | Phase 7 (radio from real state) |

### Audio audit

Read in full: `engine/audio/{FpsAudio,AudioDirector,MusicLayers,spatial}.ts`, the call sites in `ContractZeroScene.tsx`, `lib/settings.ts`, `scripts/generate-{sfx,vo}.mjs`, `CREDITS.md`. Nothing was run or listened to; this is a code audit.

**Architecture today.** `FpsAudio` is the only live audio system: one WebAudio graph created on first user gesture, six buses (gun, impact, ui, ambience, voice, music) into a master and a limiter. Almost everything is synthesised at runtime; the only files are 4 generated mp3s (3 rifle shots, 1 wall impact). `MusicLayers` is a synthesised 3-layer D-minor score (drone, pulse, plucked motif) driven by an intensity 0-3. `spatialize()` gives pan, distance gain and a "behind you" low-pass.

**Brief vs reality**

| Requirement | Today |
|---|---|
| Channels: master, music, environment, combat, radio, UI, interactions | Settings has 6 sliders: master, music, **effects** (gun and impacts together), voice, ambience, ui. No separate combat vs interactions; the radio static sits on the voice bus, but recorded voice does not (see below). |
| Per-site soundscapes | **Fixed (`ambienceKey`).** Was: wrong key. Live contracts pick the ambience bed from `mission.zone = PHASE_THEME[phase]`, i.e. time of day (day=DUSTLINE, dusk=REDYARD, night=BLACKSITE), not the site. A night raid on Dustline plays the Blacksite 44 Hz drone; Cinder Yard by day plays the Dustline bed. Only the refinery machinery follows the site (`mission.level === 'cinder_yard'`). |
| Positional ambient sources | None. The bed is one global brown-noise loop plus a drone; machinery is global, not placed at tanks. Steam vents pan randomly, not at vent positions. |
| Occlusion and indoor/outdoor | None. `spatialize()` has distance and behind-you only. No reverb or indoor/outdoor difference for any weapon. |
| Distinct weapon signatures | Partly: one rifle sample reshaped per gun (pitch, tone, sub) by `shotShape()`. |
| Distant gunfire, ricochets, near-miss | Not present. Enemy shots are the same rifle sample spatialised and dropped below 0.001 gain; no distant variant. |
| Impacts | Flesh (synth) and wall (sample) only. No per-material set. |
| Reload, damage, heartbeat, explosions, alarm, extraction | Present as synth (`reloadStart/Done/End`, `hurt`, `heartbeat`, `explosion`, `alarm`). Alarm is a fixed pattern, not an escalation. Extraction beeps exist. |
| Radio events from game state | `PRESENCE_LINES` (authored) plus per-mission lines from the server. Triggers cover start, breach, cargo, charge, detonation, extraction, low HP. Missing: low ammunition, reinforcements, faction shortage, merchant procurement, retaliation. Fallback lines are raid-worded and name Vanguard regardless of the site owner (see screenshot review). |
| Recorded voice | **Not shipped.** `vo()` looks for `/vo/{id}.mp3` but `public/vo/` does not exist, so every line is radio static plus subtitle. `dyn-` lines are never recorded by design. `scripts/generate-vo.mjs` needs an ElevenLabs key and has no voice for Ashen or Halcyon. |
| Subtitles | Present (speaker names, colours, held for the recording length when known). |
| Radio over combat | The line ducks only the ambience bus (0.8 for 1.8 s). Music and gunfire are not ducked for radio. |
| Adaptive music states | One state machine: intensity 0-3 from enemy AI state. No Hub, preparation, results, War Table or Exchange music: `FpsAudio` exists only in the fight scene and the Settings preview. Extraction and detection have no state of their own. One fixed loop, no per-site or per-faction variation. |
| Priority, cooldowns, voice concurrency | **None.** Every call builds new nodes immediately; there is no cap on simultaneous voices. Radio is serialised by a queue in the scene. Heavy fire plus enemies can allocate many nodes per frame. |
| Pause and resume | Muted when the tab is hidden if the player chose it (gain to 0); the context is never suspended. In-game pause menu does not suspend audio (to verify at runtime). |
| Autoplay | Correct: the graph is created on the first gesture and the story is held until then. |
| Disposal | `dispose()` stops music and closes the context. `stop()` of the ambience loop and drone nodes is not called explicitly (closing the context frees them). Machinery interval is cleared on unmount. |
| Licensing | `CREDITS.md`: shots and impact are original, generated by `generate-sfx.mjs`; everything else is runtime synthesis. The stale "Pixabay recordings" comment in `FpsAudio.ts` is fixed. |

**Dead code (removed).** `AudioDirector.ts` (596 lines) was used by nothing but its own export: the earlier melee game's director (blade throw, catch, recall whistle, round clear). Deleted; it stays in git history. Its ideas worth reusing (verb > impacts > score > ambience hierarchy, `gap()` silences) are noted for the new voice-budget layer.

**Tests.** 5 tests on `FpsAudio` (shot shaping, zone config) and 11 on spatialisation math. Nothing exercises the graph, buses, mix or music.

**What this means for Phase 7**
1. ~~Fix the zone key~~ Done: `ambienceKey(zone, level)` picks the bed from the site level; Cinder Yard has its own `CINDER_YARD` bed. Time of day does not yet modulate it.
2. Introduce a thin `AudioBus` / voice-budget layer (priority, per-sound cooldown, max concurrent voices, radio ducking of music and combat) inside `FpsAudio` rather than a second system (`AudioDirector` is already deleted).
3. Split the `effects` slider into combat and interactions only if the new buses need it; keep saved settings compatible (`lib/settings.ts` normalises on load).
4. Radio: add triggers fed by real state (low ammo from the HUD count, reinforcement from the sim event, faction shortage from the presenter) and make fallbacks speak the real target and operation type.
5. Music for non-fight screens needs a lightweight shared context (a provider mounted in the app layout), because audio currently lives only inside the scene.

### The authoritative rules the UI may speak about

Verified in the Rust engine; the presenter mirrors these and nothing else.

| Resource | Real effect | Source |
|---|---|---|
| Ammunition | Arms guards: 8 per rifle guard, 2 per sidearm guard, rifles first; unarmed guards stay home. Planned guards = 5 + 2 x defense. | `mission.rs` |
| Medicine | Reinforcement drops: none at 0; 1 below requirement; 2 at/above (3 at defense 4+). | `mission.rs` |
| Fuel | Below 20 no forward depot can be staged (no raids on offer). Below 10 supply shipments are grounded. | `mission.rs`, `lib.rs` |
| Credits | A faction spends only credits above its reserve. If credits < reserve + escort cost, escorts drop to minimum. | `policy.rs` |

Deliberately **not** claimed: that fuel idles factory machinery, that low credits slow reinforcements, or any effect not in the table. If a new effect is wanted it must first exist in the engine.

## 2. Creative direction

**Principle: the economy is the game world.** Every visual reaction is a function of an authoritative record or is labelled a forecast.

- **Palette** (kept): graphite `--color-ink/panel`, amber `--color-amber` for action and warning, steel `--color-steel` for intel, `--color-friendly` / `--color-hostile` for status. Readiness colours map: Operational green, Under Pressure amber, Supply Critical red, Rebuilding steel. Never colour alone: every badge also has text.
- **Type**: Rajdhani for headings and caps labels, Barlow for body (already loaded).
- **Motion**: functional only; honour reduced motion; no ambient loops on data screens.
- **Banned**: bloom, neon, glassmorphism, holographic clutter, text under 11px.

### Factions (identity brief; assets not yet drawn)

| | Voice | Material and colour | Equipment |
|---|---|---|---|
| **Vanguard** | Clipped, procedural, professional command | Olive-drab and steel, stencilled numerals | Standardised crates, tracked vehicles |
| **Ashen Compact** | Blunt, improvised, aggressive | Rust, soot, welded plate | Jury-rigged rigs, hand-painted markings |
| **Vex Exchange** | Informal, opportunistic, wartime-market banter | Tarp, chalk-marked crates, amber lamps | Mixed salvage, handwritten tags |
| **Halcyon Logistics** | Polished procurement language | Clean white-grey, thin blue accent | Uniform palletised freight |

Character names and portraits are **not yet created**. When added they must be recorded here and reused; dialogue may explain a decision but never make one (the engine's validated action is the decision).

## 3. Delivery status

| Phase | Status |
|---|---|
| 0. Audit | Done (this document). |
| 1. Creative direction | Written (above). Faction insignia, tokens and portraits **not built**. |
| 2A. Plain-language presenter | **Built**: `lib/presenter/{rules,economy}.ts`, 14 tests, vectors from the Rust tests. |
| 2B. Faction readiness | **Built** on the War Room, the Hub (compact) and Contract Intel (`components/world/Readiness.tsx`): Operational / Under Pressure / Supply Critical / Rebuilding from real stock, with an "Exact figures" disclosure. "Rebuilding" requires a real open buy order or in-transit convoy. Shortage is judged against the commander's `ammo_target`, and Contract Intel uses the server's own `guards.ammo_available` so it cannot contradict the guard plan. Checked in a browser with mocked API data (desktop and 390 px wide); not yet against the live API. |
| 2B+. Merchant readiness | **Built** (`lib/presenter/merchant.ts`, shown on War Room merchant cards and the Exchange's trading partners): Trading / Stretched / Constrained / Insolvent. Mirrors only what the engine does: a merchant commits `max_commit_bp` of a shelf to one order (none if the shelf is empty), fills a shelf by buying only up to twice its target, bids only with credits above its reserve, prices rise with scarcity (target over stock, clamped x0.5 to x3.0), and only the instant-market merchant is called insolvent. Verified on the live API (genesis world: Vex and Halcyon both Stretched, multipliers x1.20 and x1.60 matching target/stock) with no page errors. |
| 2C. Consequence pipeline | **Built** for Extraction Results. The engine records the target faction before an operation (`cz_economy::consequence`, stored in `mission_sessions.consequence`, migration 0018) and again once it settles, with the engine's own plan for the next operation. `GET /missions/{id}/aftermath` returns the target's real logged decisions after the settle tick. The Results page tells the five parts (accomplished, moved or destroyed, target lost, decided next, next operation) from those records; the commander's reaction reads "waiting" until it is logged. Sessions from before recording show "not recorded" instead of an invented story. Verified: 4 engine tests, the full Rust suite, and a live run on a fresh database (migration, start, complete, replay, aftermath); the extracted path is covered by engine tests and by `scripts/consequence-e2e.mjs`, which plays a real raid through the event protocol on a fresh off-chain database (11 checks: case taken, extraction seen, paid, snapshots closed, stock fell by the carried units give or take the clock, next plan no stronger, stable replay, the commander's real decision in the aftermath, War Room listing). It found that net stock change includes production and consumption over the in-game hours the run lasted, so the story now separates "the operation took N" from what the clock did. The War Room lists recent completed operations (`GET /warroom/operations`, `components/world/Operations.tsx`), each opening to the same story, with the payout's NEAR status shown as recorded (only `confirmed` reads "settled"). Checked against the live API on a fresh database (two real killed runs, desktop and 390 px); an extracted operation was listed live by the e2e script. **NEAR payout, what was and was not verified:** the real on-chain settlement was **not** run, because it needs the deployed testnet accounts' private keys (`~/.contract-zero/keys`, absent here). What was run: with settlement rows seeded by hand into a scratch database (not chain data), the live `GET /warroom/operations` reported `submitted` as `settled_on_chain: false`, `confirmed` as `true` with an explorer link, and `failed` as `false` with its error; and the real War Room rendered the `submitted` row as "NEAR payout: submitted", never "settled". The queue, worker and chain calls are untouched by this work and keep their own tests (`scripts/field-e2e.mjs` covers them on testnet). |
| 3. War Table | **Partly built**: a layered 2D map replaces the old SVG region map (`components/world/table/`, `lib/world/`). Facilities are the server's three sites plus one node per merchant, on fixed schematic slots (the map says so); territories group a faction's sites; production lines down, contracts on offer and deployed operators are marked on each node; readiness is the shared presenter's (text plus colour). Selecting a facility (map, keyboard or the button list) opens its intel: readiness, holdings as scalable crate/case/tank gauges, production lines, contracts there with the server's guard plan, shipments and open orders, recent recorded attacks with their consequence, and its owner's latest logged decision. Convoys are drawn only while in transit, along an off-map trunk road at the server's own progress, labelled as strategic markers (the server stores only owner, resource, units, dispatch and arrival ticks and "from off-map"; it has no per-depot destination, so none is drawn). Checked on the live API (genesis world, real recorded operation, 6 convoys): desktop and 390 px, keyboard selection, no page errors. Screenshot: `docs/media/war-table.png` (local development world). **Agent timeline (built):** each supply order is a seven-stage timeline in the War Room (`components/market/Procurement.tsx`, rules in `lib/presenter/procurement.ts`): shortage, order, bids, winner, settlement, supply arrives, readiness. Every stage is recorded, waiting, failed, did-not-happen or not-recorded. A lone offer is never called competition, settlement is done only when every recorded step is confirmed (a partial or pending one reads "not settled yet"), readiness is the engine's plan now, not a claimed change, and the footer no longer says "settled on NEAR" for an order with no on-chain record. Checked on the live API (competing offers, an expired surplus order where both merchants declined, off-chain settlement) on desktop and 390 px with no page errors; `docs/media/supply-order-timeline.png`. **Before/after (built):** `Compare before and after` opens a table from the two recorded snapshots plus the engine's plan for the next operation (`lib/presenter/compare.ts`, `components/world/BeforeAfter.tsx`): inventory, defense, armed guards, rifles and sidearms, reinforcements, depot size, production lines, readiness and whether an operation is on offer. A missing value reads "not recorded" or "pending" and is never interpolated or marked changed; bounty is listed as not recorded because the snapshot does not carry it. Verified on the live API with a real extracted operation. **Not yet:** a 3D variant, faction-specific map art. Two real bugs found by this run and fixed: the frontend's convoy status type did not match the server (so the old map never drew a convoy and "Rebuilding" could never fire from a convoy), and site ids use hyphens. |
| 4. Faction/merchant presentation, agent sequence | Not built (procurement chain unchanged). |
| 5. Screen redesigns | Contract Board guard wording fixed only. |
| 6. Environment differentiation | Not started. |
| 7. Audio identity | Not started; existing audio engine unaudited in depth. |
| 8. Physical consequences in levels | Not started. Depends on exposing faction state to the mission builder. |
| 9. Onboarding | Existing Field Manual untouched. |
| 10. Standards | Typecheck, 529 tests and production build green. No screenshots, recordings or mobile/perf measurements were taken for this slice (the API and database were not run). |
