import { describe, expect, it } from 'vitest'
import { NavGrid } from '../nav'
import type { CoverBox } from '../FpsSim'

const B = { minX: -10, maxX: 10, minZ: -10, maxZ: 10 }
// A wall across the map at z=0 with a 2 m doorway at x = 6..8.
const WALL: CoverBox[] = [
  { x: -2, z: 0, w: 16, d: 0.6, h: 3 },  // x -10..6
  { x: 9, z: 0, w: 2, d: 0.6, h: 3 },    // x 8..10
]

describe('NavGrid', () => {
  const nav = new NavGrid(B, WALL, 0.35, 0.5)

  it('marks inflated colliders as blocked and open floor as free', () => {
    expect(nav.isFree(0, 0)).toBe(false)
    expect(nav.isFree(0, 0.3)).toBe(false) // within the body radius of the wall face
    expect(nav.isFree(0, 3)).toBe(true)
    expect(nav.isFree(7, 0)).toBe(true) // the doorway
    expect(nav.isFree(20, 0)).toBe(false) // out of bounds
  })

  it('knows a straight walk through a wall is not clear', () => {
    expect(nav.segmentClear(0, 5, 0, -5)).toBe(false)
    expect(nav.segmentClear(7, 5, 7, -5)).toBe(true)
  })

  it('routes through the doorway instead of into the wall', () => {
    const path = nav.findPath(0, 5, 0, -5)!
    expect(path).not.toBeNull()
    // Some waypoint is in the doorway, and the route ends at the goal.
    expect(path.some(([x, z]) => x > 6 && x < 8 && Math.abs(z) < 1)).toBe(true)
    expect(path[path.length - 1]).toEqual([0, -5])
    // Every leg is walkable.
    let [px, pz] = [0, 5]
    for (const [x, z] of path) {
      expect(nav.segmentClear(px, pz, x, z)).toBe(true)
      ;[px, pz] = [x, z]
    }
  })

  it('string-pulls an open walk to a single straight leg', () => {
    expect(nav.findPath(-5, 5, 5, 8)).toEqual([[5, 8]])
  })

  it('returns null when the goal is sealed off', () => {
    const sealed = new NavGrid(B, [...WALL, { x: 7, z: 0, w: 2, d: 0.6, h: 3 }], 0.35, 0.5)
    expect(sealed.findPath(0, 5, 0, -5)).toBeNull()
  })

  it('starts from the nearest free cell when the body is pressed into a wall', () => {
    const path = nav.findPath(0, 0.4, 0, 5)
    expect(path).not.toBeNull()
    expect(path![path!.length - 1]).toEqual([0, 5])
  })
})
