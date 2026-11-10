// The economy's battlefield rules, mirrored from the Rust engine so the UI can explain
// them without inventing thresholds. Every constant and function here has a source:
//
//   apps/api/crates/economy/src/mission.rs  (guards, arming, reinforcements, depot staging)
//   apps/api/crates/economy/src/lib.rs      (LOGISTICS_FUEL, DEFENSE_COST)
//   apps/api/crates/economy/src/policy.rs   (spendable = credits above the reserve; merchant_proposals)
//   apps/api/crates/economy/src/pricing.rs  (scarcity from stock against target)
//
// If the engine changes one of these, the pinned vectors in __tests__/rules.test.ts
// (copied from the Rust tests) fail and this file must follow. Where the server already
// sends the computed answer (BoardEntry.guards), prefer that over recomputing.

export const AMMO_PER_RIFLE = 8
export const AMMO_PER_SIDEARM = 2
/** Fuel a faction must hold to stage a forward depot (mission.rs STAGING_FUEL). */
export const STAGING_FUEL = 20
/** Fuel burned to run one supply shipment; below it logistics are grounded (lib.rs). */
export const LOGISTICS_FUEL = 10
export const DEFENSE_COST = [0, 0, 80, 200, 360, 560] as const

export interface SquadCount { rifles: number; sidearms: number }

/** Guards the defense posture calls for (mission.rs planned_guards): 7 … 15. */
export const plannedGuards = (defense: number) => 5 + 2 * defense

/** Arm as many guards as the ammunition allows, rifles first, then sidearms. A guard that
 *  cannot be armed stays home (mission.rs arm_guards, minus the hall/yard split). */
export function armGuards(planned: number, ammo: number): SquadCount {
  const a = Math.max(0, ammo)
  const rifles = Math.min(planned, Math.floor(a / AMMO_PER_RIFLE))
  const sidearms = Math.min(planned - rifles, Math.floor((a - rifles * AMMO_PER_RIFLE) / AMMO_PER_SIDEARM))
  return { rifles, sidearms }
}

/** Guards per reinforcement drop (mission.rs reinforcements). */
export function reinforcements(med: number, medRequirement: number, defense: number): number {
  if (med <= 0) return 0
  if (med < medRequirement) return 1
  return defense >= 4 ? 3 : 2
}

/** Ammunition a faction tries to hold: two days of need plus half a rifle-load for
 *  every guard its defense plans (policy.rs ammo_target). This, not `requirement`, is
 *  what its commander restocks toward. */
export const ammoTarget = (ammoRequirement: number, defense: number) =>
  ammoRequirement + Math.floor((AMMO_PER_RIFLE * plannedGuards(defense)) / 2)

/** Credits a faction may spend: anything above its reserve (policy.rs spendable). */
export const spendable = (credits: number, reserve: number) => Math.max(0, credits - reserve)

// ── merchants ──

const BP = 10_000
export const SCARCITY_MIN_BP = 5_000
export const SCARCITY_MAX_BP = 30_000

/** Units a merchant will commit to one supply order it answers: its per-order share of the
 *  shelf (policy.rs merchant_proposals, buy side). */
export const merchantCommit = (stock: number, maxCommitBp: number) => Math.floor((stock * maxCommitBp) / BP)

/** Shelf room it will fill by buying: up to twice its target (policy.rs, sell side). */
export const merchantRoom = (target: number, stock: number) => Math.max(0, target * 2 - stock)

/** How far stock below (or above) target moves its prices, in basis points (pricing.rs). */
export const scarcityBp = (stock: number, target: number) =>
  Math.min(SCARCITY_MAX_BP, Math.max(SCARCITY_MIN_BP, Math.floor((BP * Math.max(1, target)) / Math.max(1, stock))))
