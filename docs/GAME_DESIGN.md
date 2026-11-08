# VALOR — Game Design Document

> ⚠️ **SUPERSEDED (July 2026).** This describes the earlier *1v1 stat-duel shooter*
> direction. The live game is now a **first-person tactical shooter** (solo campaign of
> tactical operations + Survival + a ranked Gauntlet). See the **root `README.md`** for
> the current design. The stat-duel game below is preserved and playable at
> `/fight-legacy`; this doc is kept for history + reusable ideas (classes, ranks,
> economy principles, PvP netcode notes).

> **One sentence (legacy):** Valor is a real-time 1v1 stat-duel shooter, playable in the browser,
> where verified humans stand at range, trade shots, dodge bullets, climb ranked seasons,
> and earn real value (G$) on GoodDollar + Celo.

---

## 1. The Core Fantasy

Two fighters. One arena. Guns drawn. Real-time stat-duel shooting — you stand your
ground, fire at cadence, and dodge the bullets coming your way. Better gun = more
power. The skill is dodge timing. The strategy is loadout selection.

The crypto is invisible. You connect with a social login, you fight, you earn. The
blockchain is under the hood. The gun economy drives the marketplace.

---

## 2. Combat Model — STAT-DUEL SHOOTER

This is the central design commitment. Combat is **real-time ranged shooting**, not
melee or menu-driven.

- Two fighters stand at range in a 3D arena and trade shots automatically at their
  gun's fire cadence.
- The player's only active input is **dodge timing** — trigger a dodge to gain
  i-frames and avoid incoming projectiles.
- Damage is determined by gun stats (fireRate, damage, accuracy) modified by ammo
  type and attachments.

### Animation States (6)
- **Idle** — standing, weapon ready
- **Fire** — shooting at cadence (driven by gun `fireRate`)
- **Stagger** — hit reaction on taking damage
- **Dodge** — player-triggered evasion with i-frames
- **Death** — defeat animation
- **Victory** — winner celebration

### CombatSim (the engine)
- `CombatSim.ts` runs the simulation tick-by-tick.
- Each tick: fire cadence check → accuracy roll → dodge i-frame check → damage
  application → crit roll.
- **Projectile-based** (not hitscan) — bullets travel and can be dodged.
- Gun stats come from `GunStats.ts`; loadout resolution (gun + ammo + attachments)
  is in `Loadout.ts` via `resolveGunStats()`.

### Match structure
- Single round. First fighter to 0 HP loses.
- Campaign fights award XP scaled by level (§4).
- Post-fight: Retry (same level), Next Level (on win), Return Home.

---

## 3. Classes (3 — matches the code)

Three fighters, each a distinct silhouette + color + base stats. In the shooter model,
class determines base HP, dodge speed, and crit modifier — but the **gun** is the
primary power driver.

| Class | Color | Stats (atk/def/spd) | Special | Playstyle |
|-------|-------|---------------------|---------|-----------|
| **Berserker** | Red `#ef4444` | 16 / 7 / 9 | **Berserker Rage** — 3x base damage burst | Aggressive — raw damage output |
| **Sentinel** | Blue `#3b82f6` | 9 / 16 / 7 | **Iron Fortress** — absorbs next hit, reflects 50% | Defensive — outlast and punish |
| **Phantom** | Purple `#8b5cf6` | 12 / 7 / 15 | **Shadow Strike** — always first, bypasses defence | Evasive — speed is your armor |

One character per wallet. Class is permanent. Username is editable at any time.

---

## 4. Game Modes

1. **Campaign (PvE)** — 15 levels across 3 zones, bosses every 5th level. The core
   progression path.
   - **Zone 1 — Ashfall** (levels 1-5): introductory enemies, Ashfall Boss at level 5
   - **Zone 2 — Proving Ground** (levels 6-10): mid-tier enemies, Proving Ground Boss at level 10
   - **Zone 3 — The Rift** (levels 11-15): hardest enemies, Final Boss at level 15
   - Win XP scales per level: 50 (level 1) to 104 (level 15)
   - Loss XP scales per level: 15 (level 1) to 34 (level 15)
   - 15 wins at max level = exactly 1,000 XP = one rank-up
2. **Endless Mode** — unlocks after level 15. Survive as long as possible; weekly
   leaderboards track high scores.
3. **Challenge a Player** — direct PvP challenge against another verified human.
4. **Live PvP** — real-time matchmaking queue.

PvP netcode model is the key open decision (§8).

---

## 5. Progression & Ranked

- **Player Level / XP** — earned every fight, win or lose (no wasted sessions).
- **Ranked tiers** — Bronze → … → Valor, seasonal soft resets. (Existing rank pool
  logic in `useRankPool` / API carries over.)
- **Decay** — inactivity decay already exists; recovery on return.
- **Achievements** — milestone rewards.

---

## 6. Web3 / Economy (GoodDollar + Celo)

- **Identity:** wallet = permanent identity (Magic: email/Google → deterministic wallet, or
  connect existing). GoodDollar verification gates ranked + G$ (one human, one account;
  no bots/multi-accounting).
- **Rewards:** G$ on Celo for wins, ranked placement, challenges. Server-authoritative
  reward resolution (anti-cheat).
- **Gun economy:** Guns are the primary power driver. Better guns cost more G$. The
  marketplace is the economic engine — players earn G$ from fights and spend it on
  guns, ammo, and attachments to increase their combat power.

### Gun Marketplace

| Gun | Price |
|-----|-------|
| Standard Sidearm | Free (starter) |
| Compact SMG | 150 G$ |
| Assault Rifle | 400 G$ |
| Marksman Rifle | 900 G$ |
| Valor Prototype | 2,000 G$ |

Ammo types (Hollow Point, Armor Piercing, Tracer, Incendiary) and attachments
(4 slots x 2 options = 8 total) further modify gun stats. All 25 items registered
on-chain (`on_chain_id` 1-25).

`G$ on Celo: 0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A (18 decimals)`

---

## 7. Game Feel — the Shooter Bar

Feel is ~70% code, and it's the priority. For a stat-duel shooter:

1. **Fire cadence.** Gun `fireRate` drives the shooting rhythm. Each shot has a
   muzzle flash, recoil animation, and projectile spawn. The rhythm must feel
   satisfying and distinct per gun tier.
2. **Projectile travel.** Bullets are visible travelling projectiles, not hitscan.
   The player can see them coming and time dodges. Projectile speed varies by gun.
3. **Dodge i-frames.** The dodge must feel responsive and rewarding. Clear visual
   feedback when a dodge successfully avoids a bullet. This is the core skill
   expression.
4. **Impact layer (procedural juice):** stagger animation on hit, screen shake,
   damage numbers, muzzle flash VFX, bullet trail VFX, impact sparks on hit.
5. **Readability:** distinct silhouettes + accent colors; camera framing that shows
   both fighters and the bullet trajectories; arena lighting that doesn't obscure
   the action.
6. **Death/victory.** Dramatic death animation + winner celebration. Camera pulls in
   for the final shot.

**Animation sourcing:** 6 states (idle, fire, stagger, dodge, death, victory) per
class. Keep distinct per class — Berserker fires aggressively, Phantom dodges
fluidly, Sentinel absorbs hits stoically.

---

## 8. Open Decisions / Next Steps

1. **PvP netcode** — real-time authoritative netcode is hard *and* there's real money at
   stake. Decide: rollback/lockstep real-time, or "real-time play, server-validated
   result." This gates real Ranked PvP. (Campaign fights work today regardless.)
2. **Ammo/attachment integration** — `Loadout.ts` has `resolveGunStats()` but CombatSim
   doesn't call it yet. Wire loadout resolution into the sim so ammo and attachment
   bonuses actually affect combat.
3. **Per-level arenas** — campaign levels should have distinct arenas per zone (Ashfall =
   volcanic, Proving Ground = industrial, The Rift = sci-fi). Currently all fights use
   the same stylized arena.
4. **Campaign level UX** — show zone/level context during fights so the player knows
   where they are in the campaign.

---

## 9. Existing Foundation (what we keep)

- **Next.js 15** web app (`apps/web`) + **Three.js / R3F** engine (`apps/web/src/engine/`):
  `combat/` (GunStats, Loadout, RangedAI, DamageSystem, ComboSystem),
  `campaign/` (levels — 15-level campaign definition),
  `sim/` (CombatSim, Cover, GameRoom, reportMatch),
  `animation/` (AnimationStateMachine, MixamoLoader, CLASS_ANIMATIONS),
  `camera/` (BattleCamera), `vfx/` (CombatFeel, KnockbackPhysics, TrailRenderer,
  ParticleSystem, ScreenEffects), `audio/` (CombatAudio), `world/` (ArenaManager,
  StageLighting, Crowd), `input/`, `scene/` (GameScene, FighterModel, ArenaStage).
- **Magic** auth, **GoodDollar** SDK, **Railway Postgres** (Railway API), **API** (`apps/api`),
  **contracts/** (Foundry), **packages/shared**.
- Entry point for the shooter: `/fight?level=N` → `GameScene` (via CampaignSelect).
