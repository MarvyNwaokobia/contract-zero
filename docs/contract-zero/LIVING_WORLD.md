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
| Audio | `engine/audio/AudioDirector.ts`, `FpsAudio.ts`, `MusicLayers.ts`, `spatial.ts` | Director, layered music and spatial helpers already exist; channel set, per-site beds and radio are **not** audited yet. |
| Settings / a11y | `lib/settings.ts`, `app/settings`, `docs/contract-zero/ACCESSIBILITY.md` | Infrastructure exists, including key rebinding and toggles. |
| NEAR settlement | `apps/api/src/services/settlement.rs`, `contracts-near/*` | Not touched by this work. |

**Technically functional, visually underdeveloped:** the War Room map and actor cards; procurement chains; the Exchange.
**Technically present, disconnected from state:** the hangar scene; level environments (no depletion, idle machinery or alarms from real data).
**Where players must read technical text:** War Room cards (raw `stock/need` bars), procurement steps (JSON-ish rationale strings), faction defense as an unexplained 1-5 pips.

### Screenshot and demo review

Reviewed from `docs/media/*.jpg` and `docs/contract-zero/demo/report-2026-11-09.json`. **No gameplay recording is in the repo** (video output is git-ignored), so this is a review of stills and the run report. The 2026-11-09 run: 16 steps, 7.6 minutes, 0 page errors.

| Finding | Evidence | Belongs to |
|---|---|---|
| The Hub's "Next operation" card is clipped by the status panels below it at 1280x720 | `hub.jpg` | Phase 5, Hub |
| Hub and Exchange show raw `stock/target` bars and rationale strings ("Treasury strong (11127 cr): extra patrols") instead of meaning | `hub.jpg`, `warroom-causal.jpg` | Phase 2 (War Room done; Hub next) |
| War Room decision cards are a 7-row text table; the "gameplay" row is the only one a player cares about | `warroom-causal.jpg` | Phase 3/4 |
| Exchange order history is a text ledger; winner and losing bidders are not visible as a contest | `exchange-orders.jpg` | Phase 4 |
| Contract Intel is thorough but entirely text; the site map is the only visual | `intel.jpg` | Phase 5 |
| Cinder Yard reads as beige cylinders and rails; no steam, machinery or catwalk life; tanks are plain flat-shaded | `fight-cinder-yard.jpg` | Phase 6 |
| Blacksite at night has good mood (NVG, corridor light) but rooms are boxes with little set dressing | `fight-blacksite-night.jpg` | Phase 6 |
| In-fight HUD: control hints top-right are tiny and low contrast; weapon name overlaps the NVG/light chips bottom-right | both fight shots | Phase 5/10 |
| The fallback radio line "Contract's live. The cargo is in the yard... Load it, walk it out" is shown on sabotage and recovery missions; `vanguard-*` lines name Vanguard regardless of the site's owner | `fight-*.jpg`; `engine/story/presence.ts:71` | Phase 7 (radio from real state) |

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
| 0. Audit | Done (this document), except the audio engine deep-dive. |
| 1. Creative direction | Written (above). Faction insignia, tokens and portraits **not built**. |
| 2A. Plain-language presenter | **Built**: `lib/presenter/{rules,economy}.ts`, 14 tests, vectors from the Rust tests. |
| 2B. Faction readiness | **Built** in the War Room (`components/world/Readiness.tsx`): Operational / Under Pressure / Supply Critical / Rebuilding from real stock, with an "Exact figures" disclosure. "Rebuilding" requires a real open buy order or in-transit convoy. |
| 2C. Consequence pipeline | Not built. Needs a before/after snapshot source; `history` only carries holdings and defense. |
| 3. 3D War Table | Not built. Existing SVG map unchanged. |
| 4. Faction/merchant presentation, agent sequence | Not built (procurement chain unchanged). |
| 5. Screen redesigns | Contract Board guard wording fixed only. |
| 6. Environment differentiation | Not started. |
| 7. Audio identity | Not started; existing audio engine unaudited in depth. |
| 8. Physical consequences in levels | Not started. Depends on exposing faction state to the mission builder. |
| 9. Onboarding | Existing Field Manual untouched. |
| 10. Standards | Typecheck, 529 tests and production build green. No screenshots, recordings or mobile/perf measurements were taken for this slice (the API and database were not run). |
