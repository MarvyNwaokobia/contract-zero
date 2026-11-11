import { describe, expect, it } from 'vitest'
import { alarmPattern, closestApproach, distanceClass, FAR_M, NEAR_M, NEAR_MISS_M, nearMissStrength, propagationDelay, stepInterval, type Vec3 } from '../combat'
import { impulseResponse, INDOOR_IR, isIndoors, OUTDOOR_IR, spaceMix } from '../acoustics'
import { LEVELS } from '../../fps/levels'

describe('near miss', () => {
  const player: Vec3 = [0, 1.6, 0]
  it('finds the closest point of a real round to the head', () => {
    // a round flying along +x, passing 1 m to the side of the listener
    const c = closestApproach([-20, 1.6, 1], [20, 1.6, 1], player)
    expect(c.dist).toBeCloseTo(1)
    expect(c.t).toBeCloseTo(0.5)
    expect(c.point[0]).toBeCloseTo(0)
  })
  it('a round that stops short of you is measured to where it stopped, not to its line', () => {
    const c = closestApproach([-20, 1.6, 1], [-8, 1.6, 1], player)
    expect(c.t).toBe(1)
    expect(c.dist).toBeGreaterThan(8)
  })
  it('is louder the closer it passes and silent outside the band', () => {
    expect(nearMissStrength(0)).toBe(1)
    expect(nearMissStrength(NEAR_MISS_M / 2)).toBeCloseTo(0.5)
    expect(nearMissStrength(NEAR_MISS_M)).toBe(0)
    expect(nearMissStrength(10)).toBe(0)
  })
  it('a zero-length round is handled', () => {
    expect(closestApproach([1, 1, 1], [1, 1, 1], player).t).toBe(0)
  })
})

describe('distance', () => {
  it('sound takes real time to arrive, capped', () => {
    expect(propagationDelay(0)).toBe(0)
    expect(propagationDelay(34.3)).toBeCloseTo(0.1)
    expect(propagationDelay(400)).toBe(0.35)
  })
  it('classifies near, mid and far', () => {
    expect(distanceClass(NEAR_M - 1)).toBe('near')
    expect(distanceClass(NEAR_M)).toBe('mid')
    expect(distanceClass(FAR_M)).toBe('far')
  })
})

describe('alarm escalation', () => {
  it('each level is faster, higher and louder than the last, and only the last is doubled', () => {
    const [a, b, c] = ([1, 2, 3] as const).map(alarmPattern)
    expect(b.periodS).toBeLessThan(a.periodS)
    expect(c.periodS).toBeLessThan(b.periodS)
    expect(b.hiHz).toBeGreaterThan(a.hiHz)
    expect(c.hiHz).toBeGreaterThan(b.hiHz)
    expect(c.gain).toBeGreaterThan(a.gain)
    expect([a.second, b.second, c.second]).toEqual([false, false, true])
  })
})

describe('footstep cadence', () => {
  it('quickens with speed inside a believable range', () => {
    expect(stepInterval(1)).toBeGreaterThan(stepInterval(5))
    expect(stepInterval(0)).toBeLessThanOrEqual(0.7)
    expect(stepInterval(99)).toBeGreaterThanOrEqual(0.22)
  })
})

describe('indoors and outdoors follow the level’s own roofs', () => {
  it('the Blacksite’s interior is indoors; its gate is not', () => {
    const l = LEVELS.blacksite
    expect(isIndoors(l.art, 0, -20)).toBe(true)
    expect(isIndoors(l.art, l.start[0], l.start[1])).toBe(false)
  })
  it('every site has some roofed space and some open ground', () => {
    for (const l of Object.values(LEVELS)) {
      expect(l.art.some((a) => a.kind === 'roof'), l.id).toBe(true)
      expect(isIndoors(l.art, l.start[0], l.start[1]), `${l.id} start is outside`).toBe(false)
    }
  })
  it('a margin counts the doorway as inside; no level means outside', () => {
    const roof = { kind: 'roof' as const, x: 0, z: 0, w: 10, d: 10 }
    expect(isIndoors([roof], 5.5, 0)).toBe(false)
    expect(isIndoors([roof], 5.5, 0, 1)).toBe(true)
    expect(isIndoors(null, 0, 0)).toBe(false)
  })
  it('indoors is wet and short; outdoors is faint', () => {
    expect(spaceMix(true).indoorWet).toBeGreaterThan(spaceMix(false).outdoorWet)
    expect(spaceMix(true).outdoorWet).toBe(0)
    expect(spaceMix(false).indoorWet).toBe(0)
  })
})

describe('impulse responses', () => {
  it('are deterministic and the right length', () => {
    const a = impulseResponse(48000, INDOOR_IR), b = impulseResponse(48000, INDOOR_IR)
    expect(a.length).toBe(Math.floor(48000 * 0.7))
    expect(Array.from(a.slice(0, 50))).toEqual(Array.from(b.slice(0, 50)))
  })
  it('a room tail decays; open ground is sparse (mostly silence between echoes)', () => {
    const room = impulseResponse(48000, INDOOR_IR)
    const energy = (arr: Float32Array, from: number, to: number) => arr.slice(from, to).reduce((s, v) => s + v * v, 0)
    expect(energy(room, 0, 4000)).toBeGreaterThan(energy(room, room.length - 4000, room.length) * 20)
    const open = impulseResponse(48000, OUTDOOR_IR)
    const quiet = Array.from(open).filter((v) => Math.abs(v) < 1e-6).length / open.length
    expect(quiet).toBeGreaterThan(0.6)
  })
  it('left and right channels differ so it widens the image', () => {
    const l = impulseResponse(48000, INDOOR_IR, 0), r = impulseResponse(48000, INDOOR_IR, 1)
    expect(Array.from(l.slice(0, 20))).not.toEqual(Array.from(r.slice(0, 20)))
  })
})
