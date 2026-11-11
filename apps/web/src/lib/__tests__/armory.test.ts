import { describe, expect, it } from 'vitest'
import { GUN_CATALOG, gunDps, type GunId } from '@/engine/combat/GunStats'
import { statRows } from '../armory'

describe('weapon comparison', () => {
  it('draws every stat against the best real gun, so some gun is full on each bar and none exceeds it', () => {
    const guns = Object.keys(GUN_CATALOG) as GunId[]
    for (const key of ['dps', 'damage', 'rate', 'mag', 'range', 'reload']) {
      const ratios = guns.map((id) => statRows(GUN_CATALOG[id]).find((r) => r.key === key)!.ratio)
      expect(Math.max(...ratios), key).toBeCloseTo(1, 5)
      expect(Math.min(...ratios), key).toBeGreaterThanOrEqual(0)
    }
  })
  it('prints the real numbers, including the catalog\'s own sustained dps', () => {
    for (const g of Object.values(GUN_CATALOG)) {
      const rows = statRows(g)
      expect(rows.find((r) => r.key === 'dps')!.value).toBe(`${Math.round(gunDps(g))} dps`)
      expect(rows.find((r) => r.key === 'damage')!.value).toBe(String(g.damage))
    }
  })
  it('rates a faster reload as the longer bar', () => {
    const sorted = Object.values(GUN_CATALOG).sort((a, b) => a.reloadTime - b.reloadTime)
    const fast = sorted[0], slow = sorted[sorted.length - 1]
    if (fast.reloadTime === slow.reloadTime) return
    expect(statRows(fast).find((r) => r.key === 'reload')!.ratio).toBeGreaterThan(statRows(slow).find((r) => r.key === 'reload')!.ratio)
  })
})
