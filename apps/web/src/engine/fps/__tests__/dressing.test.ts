import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { LEVELS, type Box, type LevelDef } from '../levels'
import { NavGrid } from '../nav'
import { FPS_TUNING } from '../FpsSim'

const R = FPS_TUNING.ENEMY.BODY_R + 0.05
const navOf = (lv: LevelDef) => new NavGrid(lv.bounds, [...lv.walls, ...lv.cover], R, 0.5)
const art = readFileSync(resolve(process.cwd(), 'src/engine/scene/LevelArt.tsx'), 'utf8')

/** Every place a player must be able to stand and use: the start, each objective, each pickup, each zone. */
function keyPoints(lv: LevelDef): [string, [number, number]][] {
  const { charges, ...single } = lv.points
  return [
    ['start', lv.start], ...Object.entries(single), ['charge1', charges[0]], ['charge2', charges[1]],
    ...lv.field.cases.map((c, i) => [`case${i}`, c] as [string, [number, number]]),
    ['seized', lv.field.seized],
    ...lv.field.ammo.map((c, i) => [`ammo${i}`, c] as [string, [number, number]]),
    ...lv.field.med.map((c, i) => [`med${i}`, c] as [string, [number, number]]),
    ['exfil', lv.field.exfil.pos], ['handover zone', lv.field.handover.pos],
  ] as [string, [number, number]][]
}

describe.each(Object.values(LEVELS))('$name set dressing', (lv) => {
  const nav = navOf(lv)
  it('leaves every objective and zone on open floor, and reachable from the start', () => {
    for (const [name, [x, z]] of keyPoints(lv).filter(([n]) => !/^(ammo|med|case)\d/.test(n) && n !== 'seized')) {
      expect(nav.isFree(x, z), `${name} is blocked`).toBe(true)
      expect(nav.findPath(lv.start[0], lv.start[1], x, z), `${name} is unreachable`).not.toBeNull()
    }
  })
  it('leaves somewhere to stand within reach of every pickup, reachable from the start', () => {
    // A crate or case may sit against cover, as the vault's does; what matters is that you can stand beside it.
    const REACH = 1.6
    for (const [name, [x, z]] of keyPoints(lv).filter(([n]) => /^(ammo|med|case)\d/.test(n) || n === 'seized')) {
      let ok = false
      for (let a = 0; a < 16 && !ok; a++) for (const r of [0, 0.8, 1.2, REACH]) {
        const px = x + r * Math.cos((a / 16) * Math.PI * 2), pz = z + r * Math.sin((a / 16) * Math.PI * 2)
        if (nav.isFree(px, pz) && nav.findPath(lv.start[0], lv.start[1], px, pz)) { ok = true; break }
      }
      expect(ok, `${name} has nowhere to stand within ${REACH} m`).toBe(true)
    }
  })
  it('keeps every prop inside the level bounds', () => {
    const b = lv.bounds
    for (const o of [...lv.walls, ...lv.cover] as Box[]) {
      expect(o.x - o.w / 2, `${o.kind} at ${o.x},${o.z}`).toBeGreaterThanOrEqual(b.minX - 0.5)
      expect(o.x + o.w / 2, `${o.kind} at ${o.x},${o.z}`).toBeLessThanOrEqual(b.maxX + 0.5)
      expect(o.z - o.d / 2, `${o.kind} at ${o.x},${o.z}`).toBeGreaterThanOrEqual(b.minZ - 0.5)
      expect(o.z + o.d / 2, `${o.kind} at ${o.x},${o.z}`).toBeLessThanOrEqual(b.maxZ + 0.5)
    }
  })
  it('keeps the gate lane open: walking straight in from the start is clear', () => {
    const [ex, ez] = lv.points.entry
    expect(nav.findPath(lv.start[0], lv.start[1], ex, ez)).not.toBeNull()
  })
  it('puts no prop on top of another solid piece of the same site (no duplicates)', () => {
    const seen = new Set<string>()
    for (const o of [...lv.walls, ...lv.cover]) {
      const key = `${o.kind}:${o.x}:${o.z}:${o.w}:${o.d}`
      expect(seen.has(key), `duplicate ${key}`).toBe(false)
      seen.add(key)
    }
  })
})

describe('the renderer draws every prop kind the levels use', () => {
  const used = new Set<string>()
  const usedArt = new Set<string>()
  for (const lv of Object.values(LEVELS)) { for (const b of [...lv.walls, ...lv.cover]) used.add(b.kind); for (const a of lv.art) usedArt.add(a.kind) }
  it.each([...used])('has a mesh for the %s prop', (kind) => {
    // Anything without a `case` falls back to a plain concrete box, which is never what a bed or a drum should be.
    expect(art, kind).toContain(`case '${kind}'`)
  })
  it.each([...usedArt].filter((k) => !['beacon', 'floodlight', 'radar', 'stack', 'steam'].includes(k)))('has a mesh for the %s set piece', (kind) => {
    expect(art, kind).toContain(`case '${kind}'`)
  })
})

describe('the new sites have what the brief calls for', () => {
  const kinds = (lv: LevelDef) => new Set([...lv.walls, ...lv.cover].map((b) => b.kind))
  it('Blacksite has a medical bay, a checkpoint, a control room and labs', () => {
    const k = kinds(LEVELS.blacksite)
    for (const need of ['bed', 'cabinet', 'console', 'locker', 'booth', 'barrier', 'server', 'desk']) expect(k.has(need as never), need).toBe(true)
    expect(LEVELS.blacksite.cover.filter((b) => b.kind === 'booth').length + LEVELS.blacksite.walls.filter((b) => b.kind === 'booth').length).toBeGreaterThanOrEqual(2)
  })
  it('Cinder Yard has tanks, drums and consoles, with steam and valves on the pipework', () => {
    const k = kinds(LEVELS.cinder_yard)
    for (const need of ['tank', 'drum', 'console', 'column', 'pipe_rack']) expect(k.has(need as never), need).toBe(true)
    expect(LEVELS.cinder_yard.art.filter((a) => a.kind === 'steam').length).toBeGreaterThanOrEqual(5)
    expect(LEVELS.cinder_yard.art.some((a) => a.kind === 'valve')).toBe(true)
  })
  it('Dustline Depot has a gate with pillars, containers, towers and drums', () => {
    const k = kinds(LEVELS.dustline_depot)
    for (const need of ['container', 'drum', 'booth']) expect(k.has(need as never), need).toBe(true)
    expect(LEVELS.dustline_depot.art.filter((a) => a.kind === 'tower').length).toBeGreaterThanOrEqual(2)
    expect(LEVELS.dustline_depot.walls.some((b) => b.kind === 'concrete' && b.z === 16.5)).toBe(true)
  })
})
