import { describe, expect, it } from 'vitest'
import { groundHeight, railedMove, stairFoot, stairHeight, type Stair } from '../decks'
import { LEVELS } from '../levels'
import { NavGrid } from '../nav'
import { FPS_TUNING } from '../FpsSim'

const S: Stair = { x: 3, z: -24, w: 2, d: 8, h: 4.8, rise: '-z' }

describe('stairs', () => {
  it('rise evenly from the foot to the deck along the climb direction', () => {
    expect(stairHeight(S, 3, -20)).toBeCloseTo(0, 5)
    expect(stairHeight(S, 3, -24)).toBeCloseTo(2.4, 5)
    expect(stairHeight(S, 3, -28)).toBeCloseTo(4.8, 5)
    expect(stairHeight(S, 5.5, -24)).toBeNull() // beside the stair
  })
  it('work in every direction', () => {
    for (const rise of ['+x', '-x', '+z', '-z'] as const) {
      const s: Stair = { x: 0, z: 0, w: 8, d: 8, h: 4, rise }
      const [fx, fz] = stairFoot(s)
      expect(stairHeight(s, fx, fz), rise).toBeCloseTo(0, 5)
      const top: [number, number] = rise === '+x' ? [3.99, 0] : rise === '-x' ? [-3.99, 0] : rise === '+z' ? [0, 3.99] : [0, -3.99]
      expect(stairHeight(s, top[0], top[1]), rise).toBeCloseTo(4, 1)
    }
  })
})

describe('groundHeight', () => {
  const lv = { decks: [{ x: 0, z: -28.5, w: 11, d: 1.2, h: 4.8 }], stairs: [S] }
  it('is the ground off any deck or stair, the deck height on a deck, the highest where they overlap', () => {
    expect(groundHeight(lv, 20, 0)).toBe(0)
    expect(groundHeight(lv, 0, -28.5)).toBe(4.8)
    expect(groundHeight(lv, 3, -28)).toBeCloseTo(4.8, 5)
    expect(groundHeight(undefined, 1, 1)).toBe(0)
  })
})

describe('Cinder Yard catwalk', () => {
  const lv = LEVELS.cinder_yard
  const R = FPS_TUNING.ENEMY.BODY_R + 0.05
  const nav = new NavGrid(lv.bounds, [...lv.walls, ...lv.cover], R, 0.5)
  it('has a deck and a stair that meets it', () => {
    expect(lv.decks?.length).toBeGreaterThan(0)
    expect(lv.stairs?.length).toBeGreaterThan(0)
    const s = lv.stairs![0], d = lv.decks![0]
    expect(Math.abs(s.h - d.h)).toBeLessThan(0.01)
    const top = groundHeight(lv, s.x, d.z)
    expect(top).toBeCloseTo(d.h, 5)
  })
  it('can be reached on foot: the foot of the stair is open ground a player can walk to from the start', () => {
    const [fx, fz] = stairFoot(lv.stairs![0])
    expect(groundHeight(lv, fx, fz)).toBeCloseTo(0, 5)
    expect(nav.isFree(fx, fz + (fz < 0 ? 0.6 : -0.6))).toBe(true)
    expect(nav.findPath(lv.start[0], lv.start[1], fx, fz + 0.6)).not.toBeNull()
  })
  it('has nothing solid under or across it that would silently block you while you walk it', () => {
    const d = lv.decks![0], s = lv.stairs![0]
    const rects = [d, s]
    for (const r of rects) for (const b of [...lv.walls, ...lv.cover]) {
      const overlapX = Math.abs(b.x - r.x) < b.w / 2 + r.w / 2 - 0.05, overlapZ = Math.abs(b.z - r.z) < b.d / 2 + r.d / 2 - 0.05
      expect(overlapX && overlapZ, `${b.kind} at ${b.x},${b.z} sits under the walkway`).toBe(false)
    }
  })
  it('keeps the whole walkway inside the level', () => {
    for (const r of [...lv.decks!, ...lv.stairs!]) {
      expect(r.x - r.w / 2).toBeGreaterThan(lv.bounds.minX)
      expect(r.x + r.w / 2).toBeLessThan(lv.bounds.maxX)
      expect(r.z - r.d / 2).toBeGreaterThan(lv.bounds.minZ)
      expect(r.z + r.d / 2).toBeLessThan(lv.bounds.maxZ)
    }
  })
})

describe('railings', () => {
  const lv = { decks: [{ x: 0, z: 0, w: 10, d: 1.2, h: 4.8 }], stairs: [{ x: 7, z: 0, w: 4, d: 1.2, h: 4.8, rise: '-x' as const }] }
  it('do nothing on the ground', () => {
    expect(railedMove(lv, 0, 0, 5, 0, 9)).toEqual([0, 9])
  })
  it('keep you on the deck: a step off its side is slid along it, or refused', () => {
    expect(railedMove(lv, 4.8, 0, 0, 0, 3)).toEqual([0, 0]) // straight off the side: refused
    expect(railedMove(lv, 4.8, 0, 0, 2, 3)).toEqual([2, 0]) // diagonal: slides along
    expect(railedMove(lv, 4.8, 0, 0, 1, 0.3)).toEqual([1, 0.3]) // along the deck: free
  })
  it('still let you walk down the stair, however steeply it falls away', () => {
    const [x] = railedMove(lv, 4.8, 5.1, 0, 5.4, 0) // off the deck onto the stair
    expect(x).toBeCloseTo(5.4, 5)
    // Descending, the smoothed floor lags the ground by up to ~0.5 m on this slope: still allowed.
    const down = railedMove(lv, 3.4, 6.5, 0, 6.8, 0)
    expect(down[0]).toBeCloseTo(6.8, 5)
  })
  it('cannot be used to walk off the end of the walkway', () => {
    expect(railedMove(lv, 4.8, -4.8, 0, -6, 0)).toEqual([-4.8, 0])
  })
})
