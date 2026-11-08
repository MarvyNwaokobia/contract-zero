import { describe, expect, it } from 'vitest'
import { LEVELS, levelForZone, type LevelDef } from '../levels'
import { NavGrid } from '../nav'
import { buildConvoyMission, type ConvoyContract } from '../convoy'
import { FPS_TUNING } from '../FpsSim'

const R = FPS_TUNING.ENEMY.BODY_R + 0.05

function navOf(lv: LevelDef) {
  return new NavGrid(lv.bounds, [...lv.walls, ...lv.cover], R, 0.5)
}

const contract = (zone: 'DUSTLINE' | 'BLACKSITE', seed: number, defense = 5): ConvoyContract => ({
  id: `t-${zone}-${seed}`, target: 'vanguard', cargo: { resource: 'ammo', units: 60 }, defense, seed, zone,
})

describe.each(Object.values(LEVELS))('$name', (lv) => {
  const nav = navOf(lv)
  const pts = { start: lv.start, ...lv.points }

  it('has every objective point on open floor', () => {
    for (const [name, [x, z]] of Object.entries(pts)) expect(nav.isFree(x, z), name).toBe(true)
  })

  it('can reach every objective point from the start, in order', () => {
    const order = [lv.start, lv.points.entry, lv.points.push, lv.points.cargo, lv.points.extract]
    for (let i = 1; i < order.length; i++) {
      const [a, b] = [order[i - 1], order[i]]
      expect(nav.findPath(a[0], a[1], b[0], b[1]), `${a} → ${b}`).not.toBeNull()
    }
  })

  it('keeps every room zone inside the level bounds', () => {
    for (const zones of Object.values(lv.rooms)) {
      for (const r of zones) {
        expect(r.x[0]).toBeGreaterThanOrEqual(lv.bounds.minX)
        expect(r.x[1]).toBeLessThanOrEqual(lv.bounds.maxX)
        expect(r.z[0]).toBeGreaterThanOrEqual(lv.bounds.minZ)
        expect(r.z[1]).toBeLessThanOrEqual(lv.bounds.maxZ)
      }
    }
  })

  it('is big enough to be a different place: more than one route between rooms', () => {
    // Block the primary threshold and the inner objective must still be reachable.
    const [px, pz] = lv.points.push
    const plug = new NavGrid(lv.bounds, [...lv.walls, ...lv.cover, { x: px, z: pz, w: 5, d: 3, h: 3 }], R, 0.5)
    expect(plug.findPath(lv.start[0], lv.start[1], lv.points.cargo[0], lv.points.cargo[1])).not.toBeNull()
  })
})

describe('raids on levels', () => {
  it('picks the level from the time of day', () => {
    expect(levelForZone('DUSTLINE')).toBe('dustline_depot')
    expect(levelForZone('REDYARD')).toBe('dustline_depot')
    expect(levelForZone('BLACKSITE')).toBe('blacksite')
    expect(buildConvoyMission(contract('BLACKSITE', 1)).level).toBe('blacksite')
    expect(buildConvoyMission(contract('DUSTLINE', 1)).level).toBe('dustline_depot')
  })

  it('places the full fortified guard on both levels, every guard able to reach the start', () => {
    for (const zone of ['DUSTLINE', 'BLACKSITE'] as const) {
      for (let seed = 1; seed <= 20; seed++) {
        const m = buildConvoyMission(contract(zone, seed, 5))
        const lv = LEVELS[m.level!]
        const nav = navOf(lv)
        expect(m.enemies.filter((e) => e.room === 1)).toHaveLength(7)
        expect(m.enemies.filter((e) => e.room === 2)).toHaveLength(8)
        for (const e of m.enemies) {
          expect(nav.isFree(e.pos[0], e.pos[1]), `${zone} seed ${seed} guard at ${e.pos}`).toBe(true)
          expect(nav.findPath(e.pos[0], e.pos[1], lv.start[0], lv.start[1]), `${zone} seed ${seed} guard at ${e.pos}`).not.toBeNull()
        }
      }
    }
  })

  it('the two levels are geometrically distinct', () => {
    const a = LEVELS.dustline_depot, b = LEVELS.blacksite
    expect(a.walls.length).toBeGreaterThan(20)
    expect(b.walls.length).toBeGreaterThan(20)
    const area = (l: LevelDef) => (l.bounds.maxX - l.bounds.minX) * (l.bounds.maxZ - l.bounds.minZ)
    expect(Math.abs(area(a) - area(b))).toBeGreaterThan(500)
    expect(a.points.cargo).not.toEqual(b.points.cargo)
  })
})
