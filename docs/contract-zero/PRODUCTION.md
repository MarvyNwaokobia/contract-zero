# Production plan: from prototype to game

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
