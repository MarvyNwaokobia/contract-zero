// Comparing weapons honestly: each stat is drawn against the best value in the real catalog,
// so a bar is "how this gun compares with the best gun that exists", never an invented score.

import { GUN_CATALOG, gunDps, type GunStats } from '@/engine/combat/GunStats'

export interface StatRow { key: string; label: string; value: string; /** 0..1 against the best in the catalog. */ ratio: number; note?: string }

const all = Object.values(GUN_CATALOG)
const max = (f: (g: GunStats) => number) => Math.max(...all.map(f))
const min = (f: (g: GunStats) => number) => Math.min(...all.map(f))

const MAXES = { damage: max((g) => g.damage), rate: max((g) => g.fireRate), mag: max((g) => g.magazine), range: max((g) => g.range), dps: max(gunDps) }
const FASTEST_RELOAD = min((g) => g.reloadTime), SLOWEST_RELOAD = max((g) => g.reloadTime)

const clamp = (x: number) => Math.max(0, Math.min(1, x))

export function statRows(g: GunStats): StatRow[] {
  return [
    { key: 'dps', label: 'Sustained damage', value: `${Math.round(gunDps(g))} dps`, ratio: clamp(gunDps(g) / MAXES.dps), note: 'Includes reloads, accuracy and crits' },
    { key: 'damage', label: 'Damage per shot', value: String(g.damage), ratio: clamp(g.damage / MAXES.damage) },
    { key: 'rate', label: 'Fire rate', value: `${g.fireRate} rpm`, ratio: clamp(g.fireRate / MAXES.rate) },
    { key: 'mag', label: 'Magazine', value: String(g.magazine), ratio: clamp(g.magazine / MAXES.mag) },
    { key: 'range', label: 'Full-damage range', value: `${g.range} m`, ratio: clamp(g.range / MAXES.range) },
    { key: 'reload', label: 'Reload', value: `${g.reloadTime}s`, ratio: SLOWEST_RELOAD === FASTEST_RELOAD ? 1 : clamp(1 - (g.reloadTime - FASTEST_RELOAD) / (SLOWEST_RELOAD - FASTEST_RELOAD)), note: 'A longer bar is a faster reload' },
  ]
}
