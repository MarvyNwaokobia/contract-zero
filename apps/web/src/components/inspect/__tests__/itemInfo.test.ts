import { describe, it, expect } from 'vitest'
import { inspectInfo } from '../itemInfo'
import { GUN_CATALOG, gunDps } from '@/engine/combat/GunStats'

describe('the inspector reports only what the game models', () => {
  it('weapon stats come straight from the catalog', () => {
    const g = GUN_CATALOG.marksman
    const info = inspectInfo({ type: 'weapon', gun: 'marksman', status: 'owned', owned: 1, price: 776 })
    const v = Object.fromEntries(info.stats.map((s) => [s.label, s.value]))
    expect(info.title).toBe(g.name)
    expect(v['Damage']).toBe(`${g.damage} per hit`)
    expect(v['Magazine']).toBe(`${g.magazine} rounds`)
    expect(v['Sustained DPS']).toBe(`${Math.round(gunDps(g))}`)
    expect(v['Market value']).toBe('776 cr at Vex’s armory')
    expect(info.status.label).toContain('gun:marksman')
    // nothing the game doesn't model
    expect(info.stats.some((s) => /weight|condition|durability/i.test(s.label))).toBe(false)
  })
  it('a battlefield pickup is temporary and has no market value', () => {
    const info = inspectInfo({ type: 'weapon', gun: 'assault_rifle', status: 'battlefield', mag: 17, reserve: 24 })
    expect(info.status.tone).toBe('temporary')
    expect(info.stats.find((s) => s.label === 'Market value')!.value).toMatch(/can’t be extracted/)
    expect(info.stats.find((s) => s.label === 'Loaded')!.value).toBe('17 in the magazine · 24 spare')
  })
  it('cargo shows its movement cost and a value only when the server priced it', () => {
    const priced = inspectInfo({ type: 'cargo', resource: 'ammunition', units: 20, unitBid: 14 })
    expect(priced.stats.find((s) => s.label === 'Market value')!.value).toMatch(/280 cr/)
    expect(priced.stats.find((s) => s.label === 'Carrying it')!.value).toMatch(/−10%/)
    const unpriced = inspectInfo({ type: 'cargo', resource: 'fuel', units: 60, seized: true })
    expect(unpriced.stats.some((s) => s.label === 'Market value')).toBe(false)
    expect(unpriced.stats.find((s) => s.label === 'Carrying it')!.value).toMatch(/−20%/)
  })
  it('ammunition lists the weapons it fits', () => {
    const info = inspectInfo({ type: 'ammo', cls: 'pistol', rounds: 90 })
    expect(info.stats.find((s) => s.label === 'Fits')!.value).toContain(GUN_CATALOG.smg.name)
    expect(info.stats.find((s) => s.label === 'Fits')!.value).not.toContain(GUN_CATALOG.assault_rifle.name)
  })
})
