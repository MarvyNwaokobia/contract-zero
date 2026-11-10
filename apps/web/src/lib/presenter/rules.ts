// The economy's battlefield rules, mirrored from the Rust engine so the UI can explain
// them without inventing thresholds. Every constant and function here has a source:
//
//   apps/api/crates/economy/src/mission.rs  (guards, arming, reinforcements, depot staging)
//   apps/api/crates/economy/src/lib.rs      (LOGISTICS_FUEL, DEFENSE_COST)
//   apps/api/crates/economy/src/policy.rs   (spendable = credits above the reserve)
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

/** Credits a faction may spend: anything above its reserve (policy.rs spendable). */
export const spendable = (credits: number, reserve: number) => Math.max(0, credits - reserve)
