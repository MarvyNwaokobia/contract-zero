# Difficulty Tiers — spec

> **Status:** specced, not built (2026-07-20). Companion to the progressive rank ladder
> shipped the same day. Build order and open questions at the bottom.

## Why

The campaign is finite; the rank ladder is not. Fifteen ops played once pay ~2,610 XP,
which the progressive ladder converts into Gold. Everything above Gold has to come from
replaying content the player has already beaten.

Today a replay is *identical* to the first clear: same enemies, same XP, no reason to
prefer one op over another beyond XP-per-minute. That makes the optimal strategy "grind
the single best-paying op over and over", which is repetition without mastery. Op-replay
paying XP is deliberate (Finding 8) and stays; the problem is that it asks for tolerance
rather than skill.

Difficulty tiers reframe the same fifteen ops as a mastery ladder. You do not replay THE
WELL for the twentieth time, you beat THE WELL on Elite. Zero new art, zero new levels,
and the existing enemy AI already exposes every knob required.

## The calibration

| tier | XP multiplier | full campaign | running total |
|---|---|---|---|
| Recruit | 1.0x | 2,610 | 2,610 |
| Veteran | 1.5x | 3,915 | 6,525 |
| Elite | 2.0x | 5,220 | 11,745 |
| Legend | 3.0x | 7,830 | 19,575 |

Cumulative XP to Diamond is 17,600. **Clearing every op on every tier lands Diamond**
with ~2,000 to spare. Mastering the game and topping the ladder become the same act,
which is the property the flat ladder never had.

## What actually changes per tier

Every knob below already exists in `FPS_TUNING.ENEMY` (`apps/web/src/engine/fps/FpsSim.ts`).
No new AI, only a tuning profile selected at op start.

| knob | Recruit | Veteran | Elite | Legend | effect |
|---|---|---|---|---|---|
| `AIM_MS` | 0.60 | 0.45 | 0.35 | 0.28 | telegraph before a shot — your reaction window |
| `BASE_ACC` | 0.45 | 0.55 | 0.65 | 0.72 | point-blank hit chance |
| `MAX_ATTACKERS` | 3 | 4 | 4 | 5 | how many may fire at once |
| `DMG` | 10 | 12 | 14 | 16 | damage per hit |
| `MERCY_MS` | 0.60 | 0.55 | 0.45 | 0.35 | post-hit invulnerability |
| hitmarkers | on | on | on | **off** | you confirm your own hits |

`DEFAULT_ENEMY_HP` deliberately does **not** move. Bullet-sponge enemies make a fight
longer, not harder, and they would break the kill-cap XP math. Difficulty comes from the
enemies being faster and deadlier, never spongier.

`MAX_ATTACKERS` is the aggression-token budget that makes fights feel fair. Raising it to
5 on Legend is the single biggest difficulty jump in the table; tune it last.

## Unlock rules

- Every op starts on Recruit.
- Clearing op N on tier T unlocks op N on tier T+1. Per-op, not global: Legend on op 1
  does not unlock Legend on op 9.
- Tier selection appears on the op's briefing screen, defaulting to the **highest tier the
  player has cleared** so returning players are not re-grinding Recruit by accident.
- Tiers are not gated behind campaign completion. A player who wants Veteran op 1 on day
  one should have it.

## Server authority (the part that must not be got wrong)

The XP multiplier makes tier a money lever, so tier must never be client-reported at
completion. The current `complete_live_fight` already takes `wallet` and `level` from the
server's session record rather than the request body, precisely because the client cannot
be trusted with reward inputs. Tier joins them.

1. `POST /battles/fight/start` accepts a requested `tier`.
2. The server validates the player has actually unlocked it (see data model) and **stores
   the tier on the session**. An unvalidated request is rejected, not silently downgraded,
   so a UI bug cannot quietly rob someone of their multiplier.
3. `complete_live_fight` reads the tier from `session.tier`. `LiveFightRequest` gains no
   tier field at all. The sessionless (Endless) path is unaffected and stays 1.0x.
4. `campaign_xp(level, tier, won, kills, headshots)` applies the multiplier **after** the
   existing `max_rewardable_kills` clamp, so the anti-faucet cap still binds. A forged
   kill count is clamped first and multiplied second.

The multiplier is a small integer ratio in a labelled constant table, mirrored in
`apps/web/src/lib/constants.ts` the same way `RANK_STEP_XP` is, so client preview and
server truth cannot drift.

## Data model

```sql
-- Highest tier each player has cleared per op. Monotonic; never demote.
CREATE TABLE op_tier_clears (
  wallet_address TEXT NOT NULL,
  level          INT  NOT NULL,
  tier           INT  NOT NULL,  -- 0 Recruit … 3 Legend
  cleared_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_address, level)
);
```

One row per (wallet, op), `tier` bumped with `GREATEST` on a clear. Unlock check is
`requested_tier <= stored_tier + 1`, mirroring how `pve_level` gates op unlocks today.

## Money

**Tiers pay XP only.** No new G$ faucet.

First-clear bounties stay strictly first-clear-at-any-tier: beating op 3 on Elite does not
re-pay op 3's 1,000 G$. The rank ladder is the conversion path, tier XP climbs it, and
rank-ups pay. Keeping one money faucet means tier tuning can be adjusted freely later
without touching emission, which matters given the payout cap already sits near what a
player can earn.

## UI

- Tier selector on the briefing screen: four chips, locked ones dimmed with the unlock
  condition as the tooltip.
- The multiplier shown on the chip (`ELITE · 2x XP`) so the trade is explicit before
  committing.
- Tier badge in the HUD corner during the op, and on the debrief line
  (`+420 XP · ELITE 2x`).
- Per-op tier shown in the campaign list, so the map doubles as a mastery display. This is
  most of the long-term motivation and is cheap to render from `op_tier_clears`.

## Build order

1. `FPS_TUNING` profile table + tier plumbed through `FpsSim` construction. Pure client,
   testable headlessly, no reward impact. Ship and playtest the *feel* first.
2. `op_tier_clears` migration + unlock read/write.
3. Session-carried tier and the server multiplier (the authority work above).
4. Briefing selector + debrief/HUD surfacing.
5. Campaign-list mastery display.

Steps 1 and 2 are independently shippable. Do not do 3 before 2; a multiplier without a
persisted unlock check is an XP faucet.

## Open questions

- **Does Legend deserve one life?** A no-respawn modifier is the classic top-tier framing
  and needs no new systems, but it interacts badly with a mid-op disconnect on a free-tier
  host. Probably wants the run to be resumable before it is safe.
- **Should Endless get tiers too?** It already self-scales by wave, so a tier on top may be
  redundant. Leaning no.
- **Retro-credit for existing clears?** Everyone who cleared ops pre-tier gets Recruit
  credit from `pve_level` for free. That is the right default and needs one backfill
  statement.
- **Boss ops (5/10/15) on Legend** may need per-boss review; the boss phase logic already
  shortens telegraphs as health falls, so Legend's `AIM_MS` cut could stack into something
  untested.
