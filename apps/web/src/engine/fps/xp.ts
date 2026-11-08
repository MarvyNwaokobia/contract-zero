/**
 * @module fps/xp
 * @description The earn loop (the plan slice 5), Marvy's spec: XP per kill, the
 * kills in a level sum to the level's XP, and filling the rank bar ranks you up
 * and pays G$. The bar is PROGRESSIVE: each rank costs more than the last.
 *
 * Pure + headlessly testable. It deliberately reuses the LIVE game's ladder
 * (RANKS / RANK_STEP_XP / RANK_G_REWARD from lib/constants) so the sandbox and
 * production agree on the numbers, and attaching this to /fight later is a
 * wiring change rather than a re-tune.
 *
 * Reward policy lives here, not in FpsSim: the sim just reports that a hit on a
 * given body part killed someone. Headshots are worth more because they're the
 * skill shot.
 */

import {
  RANKS, RANK_STEP_XP, PRESTIGE_STEP_XP, RANK_G_REWARD, xpForNextRank, type Rank,
} from '../../lib/constants';
import type { HitPart } from './FpsSim';

/** Feel levers for the earn rate. ~9 kills/mission + bonus ≈ 3 missions per rank. */
// These MUST match the server (apps/api/src/handlers/battles.rs): what you see pop up
// per kill is exactly what the server credits (capped per op). Kills drive your XP.
export const XP_REWARD = {
  KILL: 10,
  HEADSHOT_BONUS: 5,  // a headshot kill is worth 15
  MISSION_COMPLETE: 50,
} as const;

/** XP for a kill, by the body part the killing blow landed on. */
export function xpForKill(part: HitPart): number {
  return XP_REWARD.KILL + (part === 'head' ? XP_REWARD.HEADSHOT_BONUS : 0);
}

const LAST = RANKS.length - 1;

/**
 * Career XP at which each rank is REACHED, cumulative down the progressive curve.
 * CUM[0] = 0 (Iron, the floor). Because the ladder is no longer flat, none of the
 * rank maths below can divide or modulo — they all walk this table.
 */
const CUM: readonly number[] = RANKS.reduce<number[]>((acc, r, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1] + RANK_STEP_XP[r]);
  return acc;
}, []);

/** Rank index for a career XP total (capped at the top rank). */
export function rankIndexForXp(totalXp: number): number {
  const xp = Math.max(0, totalXp);
  let i = 0;
  while (i < LAST && xp >= CUM[i + 1]) i++;
  return i;
}

export function rankForXp(totalXp: number): Rank {
  return RANKS[rankIndexForXp(totalXp)];
}

/**
 * Progress into the current rank, 0..the size of that rank's bar. At the top rank the
 * bar is the prestige step and keeps counting rather than pinning full, so a Diamond
 * player still sees live progress toward their next prestige.
 */
export function xpIntoRank(totalXp: number): number {
  const i = rankIndexForXp(totalXp);
  const into = Math.max(0, totalXp) - CUM[i];
  return i >= LAST ? into % PRESTIGE_STEP_XP : into;
}

/** Size of the bar the given career total is currently filling. */
export function xpBarSize(totalXp: number): number {
  return xpForNextRank(RANKS[rankIndexForXp(totalXp)]);
}

/**
 * Every rank newly reached by going from `oldXp` to `newXp` (usually 0 or 1).
 * Returns them in order so a big XP drop can announce each one it crossed.
 */
export function rankUpsBetween(oldXp: number, newXp: number): Rank[] {
  const from = rankIndexForXp(oldXp);
  const to = rankIndexForXp(newXp);
  const out: Rank[] = [];
  for (let i = from + 1; i <= to; i++) out.push(RANKS[i]);
  return out;
}

/** The G$ paid out for reaching a rank. */
export function gReward(rank: Rank): number {
  return RANK_G_REWARD[rank];
}

/**
 * The career-XP total that reproduces a given ACCOUNT standing (server rank +
 * progress into that rank). The HUD seeds its live per-kill bar from this so it
 * always shows the player's real rank/progress — not a separate local number —
 * and `rankForXp`/`xpIntoRank` of the result round-trip back to (rank, intoRank).
 */
export function careerXpFor(rank: Rank, intoRank: number): number {
  const idx = Math.max(0, RANKS.indexOf(rank));
  const bar = xpForNextRank(RANKS[idx]);
  const into = Math.max(0, Math.min(bar, Math.floor(intoRank || 0)));
  return CUM[idx] + into;
}

export { RANKS, RANK_STEP_XP, PRESTIGE_STEP_XP, xpForNextRank };
export type { Rank };
