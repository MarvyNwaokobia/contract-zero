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
