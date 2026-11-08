# Recovery audit

**Purpose.** This audit checks that trimming the inherited code didn't throw away anything that would speed up CONTRACT ZERO. It compares the current tree with the team's earlier project at upstream commit `b118eac`.

**Status of restored files.** Everything marked RESTORE below was part of the `pre-hackathon` import commit and was later deleted as unreferenced. Restored files are prior work, not hackathon work.

**Classes:**
- **RESTORE:** brought back now.
- **ADAPT:** port the pattern into new code when that system is built.
- **REFERENCE ONLY:** worth reading, not worth carrying.
- **DISCARD:** no value here.

## Restored now

| File | What it does | Changes | Why |
|---|---|---|---|
| `apps/web/src/engine/scene/ItemMesh.ts` | Procedural 3D props: ammo crates, canister, optic, barrel, grip, magazine, shield. Depends only on `three` | none | Cargo crates in the convoy yard; Exchange and Asset Wallet art. New test `__tests__/ItemMesh.test.ts` |
| `apps/web/src/engine/scene/arenas/IndustrialArena.tsx` | A large industrial hangar environment. Depends only on `react` and `three` | none, not wired yet | The obvious backdrop for a convoy depot. See ADAPT below |
| `apps/web/src/components/armory/GunIcons.tsx` | One SVG icon per gun | removed the item-ID lookup | Armory and loadout weapon icons |
| `apps/web/src/components/armory/GunTurntable.tsx` | Rotating 3D preview of a gun (GLB or procedural) | import path only | Armory weapon preview |
| `apps/web/src/app/dev/guns`, `dev/grip`, `dev/impacts` | Tuning benches: every gun model, viewmodel grip framing, impact VFX on each surface | price label reads CR | Fast visual QA while polishing weapons and impacts |

**Also fixed:** `fps/__tests__/breakContact.test.ts` was flaky. It built the sim without a seed, and the AI's random search wander occasionally failed an assertion. It is now seeded.

## Recover later

| Upstream file | What it does | Class | When and how |
|---|---|---|---|
| `apps/api/src/handlers/battles.rs` (`start_live_fight`, `complete_live_fight`) | Single-use server session per run, TTL, minimum-duration floor, unlock gate, capped kill stats | **ADAPT** | Now, as mission sessions. Persist them in Postgres instead of memory |
| `apps/api/src/handlers/gauntlet.rs` (`validate_run`) | Pure, unit-tested plausibility check of a run against server-measured time | **ADAPT** | Now: the same shape validates an extraction (elapsed ≥ load time + traversal) |
| `apps/api/src/auth.rs` | Player JWT session: separate secret, fail-closed, wallet must match the path | **ADAPT** | With login: keep the JWT half, replace the EVM signature check with NEAR NEP-413 |
| `apps/api/src/services/chain.rs` (`tx_lock`) | Serializes all signer transactions behind one lock so nonces never collide | **ADAPT** | With NEAR settlement: one signer queue per account |
| `apps/api/src/handlers/consistency.rs` | Periodic check that the DB ledger matches on-chain state | **ADAPT** | P1: reconcile settlements against NEAR |
| `apps/api/src/handlers/endless.rs` | The server owns the wave counter, with a minimum time per wave | REFERENCE ONLY | Our server already owns contract state |
| `apps/api/src/services/earn_cap.rs` | Soft weekly cap on grindable earnings | REFERENCE ONLY | Bounties are already bounded and escrowed; revisit if farming appears |
| `apps/api/migrations/add_first_clear_bounties.sql` | Primary-key idempotency for payouts | REFERENCE ONLY | The economy rejects replayed settlements; a settlements PK will mirror it |
| `IndustrialArena.tsx` (restored) and `arenas/AshfallArena.tsx`, `StylizedArena.tsx`, `CoverProps.tsx` | Large environment backdrops built for the old arena stage, not the FPS collision model | **ADAPT** | P1: as a visual shell outside the mission's walls, with no colliders. Recover the other three only if a second map is needed |
| `components/battle/OperationsSelect.tsx`, `LoadoutModal.tsx` | Old mission list and loadout picker | REFERENCE ONLY | Layout ideas for the Contract Board and Armory. Coupled to the old wallet, store and framer-motion |
| `lib/guns.ts` | Maps old marketplace item IDs to gun, ammo and attachment IDs | REFERENCE ONLY | The Armory will map NEP-245 token IDs instead |
| `app/dev/bake-gun`, `app/dev/bake-items` | Bake gun and item art to PNG | REFERENCE ONLY | `bake-gun` broke static export; only needed if live previews prove too slow |
| `engine/scene/GunMesh.ts` | Older procedural gun set | DISCARD | Superseded by `gunModels.ts` and `proceduralGuns.ts` |
| `engine/vfx/{TracerFX,DamageNumbers,ScreenEffects,CombatFeel,KnockbackPhysics,ParticleSystem}.ts` | Melee-arena feedback | DISCARD | The FPS has its own impacts, tracers, hit markers and vignette |
| `engine/performance/*`, `engine/ui/*`, `engine/multiplayer/*`, `engine/verb/*`, `engine/story/{StoryMode,Progression,WaveSystem}.ts` | Unreferenced even upstream, or legacy melee and PvP | DISCARD | |
| Wallet, identity, token, PvP, social and admin code (web and API) | | DISCARD | Out of scope by design |

**Audio:** nothing was lost. All of `engine/audio` was kept.

## Verification

| Check | Result |
|---|---|
| Web tests (`npx vitest run`) | 425 passed, 3 runs in a row |
| Typecheck (`npx tsc --noEmit`) | clean |
| Production build (`npx next build`) | passes; routes `/`, `/training`, `/dev/guns`, `/dev/grip`, `/dev/impacts` |
