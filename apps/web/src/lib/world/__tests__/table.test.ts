import { describe, expect, it } from 'vitest'
import type { SiteStatus, WarActor, WarConvoy } from '@/lib/api'
import { buildTable, OFF_MAP, pointAlong, supplySlots } from '../table'

const site = (id: string, owner: string): SiteStatus => ({ id, name: id, owner, layout: id, shared_layout: false, environment: 'x', lines: [] })
const actor = (id: string, kind: 'faction' | 'merchant'): WarActor => ({
  id, name: id, kind, holdings: { credits: 1, ammo: 1, med: 1, fuel: 1 }, production: { ammo: 0, med: 0, fuel: 0 }, requirement: { ammo: 1, med: 1, fuel: 1 },
  credit_reserve: 0, income_per_day: 0, defense: 1, doctrine: { base_defense: 1, max_price_mult: 1, aggression: 0 }, disrupted: [], recent_raids: 0, grudges: [], rivals: [],
})
const convoy = (over: Partial<WarConvoy> = {}): WarConvoy => ({ id: 1, owner: 'vanguard', owner_name: 'Vanguard', resource: 'fuel', units: 60, defense: 1, dispatched_at: 10, arrives_at: 20, progress: 0.5, status: 'in_transit', ...over })
const base = {
  sites: [site('dustline-depot', 'vanguard'), site('blacksite', 'vanguard'), site('cinder-yard', 'ashen')],
  war: { actors: [actor('vanguard', 'faction'), actor('ashen', 'faction'), actor('vex', 'merchant'), actor('halcyon', 'merchant')], convoys: [convoy()] },
}

describe('war table model', () => {
  it('places the server’s sites and one facility per merchant; nothing else', () => {
    const t = buildTable(base)
    expect(t.facilities.map((f) => f.id)).toEqual(['dustline-depot', 'blacksite', 'cinder-yard', 'exchange:vex', 'exchange:halcyon'])
  })
  it('a territory groups a faction’s sites around their centroid', () => {
    const t = buildTable(base)
    const vg = t.territories.find((x) => x.owner === 'vanguard')!
    expect(vg.facilityIds).toEqual(['dustline-depot', 'blacksite'])
    const [a, b] = vg.facilityIds.map((id) => t.facilities.find((f) => f.id === id)!.pos)
    expect(vg.anchor).toEqual({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  })
  it('a convoy sits at the server’s own progress between the edge and its owner', () => {
    const t = buildTable(base)
    const c = t.convoys[0]
    const to = t.territories.find((x) => x.owner === 'vanguard')!.anchor
    expect(c.from).toEqual(OFF_MAP)
    expect(c.path).toEqual([OFF_MAP, { x: to.x, y: OFF_MAP.y }, to]) // a multi-site territory: the route ends at its anchor
    expect(c.pos).toEqual(pointAlong(c.path, 0.5))
    const early = buildTable({ ...base, war: { ...base.war, convoys: [convoy({ progress: 0 })] } }).convoys[0]
    expect(early.pos).toEqual(OFF_MAP)
  })
  it('a route to a lone merchant node stops short of its icon', () => {
    const c = buildTable({ ...base, war: { ...base.war, convoys: [convoy({ owner: 'vex', owner_name: 'vex', progress: 1 })] } }).convoys[0]
    const vexNode = buildTable(base).facilities.find((f) => f.id === 'exchange:vex')!.pos
    expect(c.pos.x).toBe(vexNode.x)
    expect(c.pos.y).toBe(vexNode.y + 40)
  })
  it('progress is clamped, never extrapolated', () => {
    const c = buildTable({ ...base, war: { ...base.war, convoys: [convoy({ progress: 1.7 })] } }).convoys[0]
    expect(c.progress).toBe(1)
  })
  it('a seized convoy stops travelling and sits with its captor', () => {
    const t = buildTable({ ...base, war: { ...base.war, convoys: [convoy({ owner: 'vex', owner_name: 'vex', status: { seized: { by: 'ashen' } } })] } })
    const c = t.convoys[0]
    expect(c.state).toBe('seized')
    expect(c.pos).toEqual(t.territories.find((x) => x.owner === 'ashen')!.anchor)
  })
  it('does not draw a convoy for an owner that is not on the table', () => {
    expect(buildTable({ ...base, war: { ...base.war, convoys: [convoy({ owner: 'ghost' })] } }).convoys).toEqual([])
  })
  it('an unknown site still gets a slot', () => {
    const t = buildTable({ ...base, sites: [...base.sites, site('new_site', 'ashen')] })
    expect(t.facilities.find((f) => f.id === 'new_site')!.pos).toBeTruthy()
  })
})

describe('route geometry', () => {
  const path = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]
  it('walks the polyline by length', () => {
    expect(pointAlong(path, 0)).toEqual({ x: 0, y: 0 })
    expect(pointAlong(path, 0.5)).toEqual({ x: 10, y: 0 })
    expect(pointAlong(path, 0.75)).toEqual({ x: 10, y: 5 })
    expect(pointAlong(path, 1)).toEqual({ x: 10, y: 10 })
  })
  it('clamps outside 0..1 and survives a zero-length path', () => {
    expect(pointAlong(path, -3)).toEqual({ x: 0, y: 0 })
    expect(pointAlong(path, 9)).toEqual({ x: 10, y: 10 })
    expect(pointAlong([{ x: 4, y: 4 }, { x: 4, y: 4 }], 0.5)).toEqual({ x: 4, y: 4 })
  })
  it('a convoy never crosses another faction\u2019s facility on its way (the trunk road runs below them all)', () => {
    const t = buildTable(base)
    const lowest = Math.max(...t.facilities.map((f) => f.pos.y))
    for (const c of t.convoys) for (const p of c.path.slice(0, 2)) expect(p.y).toBeGreaterThan(lowest + 40)
  })
})

describe('supply gauge', () => {
  it('fills slots in proportion to stock over target and never one object per unit', () => {
    expect(supplySlots(50, 100).filled).toBe(3)
    expect(supplySlots(0, 100).filled).toBe(0)
    expect(supplySlots(100000, 100).filled).toBe(6)
    expect(supplySlots(100000, 100).overflow).toBe(true)
    expect(supplySlots(100, 100).overflow).toBe(false)
  })
  it('handles a zero target', () => {
    expect(supplySlots(0, 0).filled).toBe(0)
    expect(supplySlots(5, 0).filled).toBe(6)
  })
})
