// Texture memory for a fight, worked out from the real files so the budget is a measurement.
// A decoded texture costs width x height x 4 bytes (it is uploaded as RGBA), plus a third for mips.
// The list below is every PBR set a fight loads (scene shell + level art); a test fails if the
// source starts using one that is not listed.

export interface PbrSet { dir: 'dustline' | 'hangar'; base: string }

export const FIGHT_SETS: PbrSet[] = [
  { dir: 'dustline', base: 'burned_ground_01' }, { dir: 'dustline', base: 'broken_brick_wall' },
  { dir: 'dustline', base: 'damaged_plaster' }, { dir: 'dustline', base: 'black_painted_planks' },
  { dir: 'hangar', base: 'corrugated_iron_02' }, { dir: 'hangar', base: 'metal_plate' }, { dir: 'hangar', base: 'concrete_floor_worn_001' },
]

export const MAPS_FULL = ['diff', 'nor_gl', 'rough'] as const
export const MAPS_COLOUR = ['diff'] as const

/** What a texture of this size costs on the GPU, in bytes (RGBA with a full mip chain). */
export const gpuBytes = (w: number, h: number) => Math.round(w * h * 4 * (4 / 3))

/** The budgets, in megabytes: the full tier on a desktop, and the colour-only tier for touch and minimal. */
export const BUDGET_MB = { full: 128, colourOnly: 48 }
