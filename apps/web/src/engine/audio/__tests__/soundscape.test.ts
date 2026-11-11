import { describe, expect, it } from 'vitest'
import { emittersFor, MAX_CONTINUOUS, mixFor, nearestContinuous, nextDelay, occlusion, segmentHitsBox, SPEC, type EmitterKind } from '../soundscape'
import { LEVELS } from '../../fps/levels'
import { idleProps, type WorldCues } from '../../fps/lineProps'

const kinds = (id: keyof typeof LEVELS) => new Set(emittersFor(LEVELS[id]).map((e) => e.kind))

describe('a site sounds like what is in it', () => {
  it('Dustline has idling trucks, storage tanks, the hum of its floodlights and distant artillery', () => {
    const k = kinds('dustline_depot')
    for (const x of ['engine', 'tank', 'lamp', 'boom'] as EmitterKind[]) expect(k.has(x), x).toBe(true)
  })
  it('the Blacksite has server hum, lamp buzz, camera servos, a radar and a PA', () => {
    const k = kinds('blacksite')
    for (const x of ['server', 'lamp', 'camera', 'radar', 'chime'] as EmitterKind[]) expect(k.has(x), x).toBe(true)
  })
  it('Cinder Yard has pumps, steam vents, a stack and heavy machinery far off', () => {
    const k = kinds('cinder_yard')
    for (const x of ['pump', 'steam', 'stack', 'tank', 'clank'] as EmitterKind[]) expect(k.has(x), x).toBe(true)
  })
  it('the three sites do not sound alike', () => {
    const sig = (id: keyof typeof LEVELS) => [...kinds(id)].sort().join(',')
    expect(new Set([sig('dustline_depot'), sig('blacksite'), sig('cinder_yard')]).size).toBe(3)
  })
  it('emitters stand where things are, inside the level, with unique ids and a per-kind cap', () => {
    for (const l of Object.values(LEVELS)) {
      const es = emittersFor(l)
      expect(new Set(es.map((e) => e.id)).size).toBe(es.length)
      for (const e of es.filter((e) => e.kind !== 'boom')) {
        expect(e.x, `${l.id} ${e.id}`).toBeGreaterThanOrEqual(l.bounds.minX - 10)
        expect(e.x).toBeLessThanOrEqual(l.bounds.maxX + 10)
      }
      for (const kind of new Set(es.map((e) => e.kind))) expect(es.filter((e) => e.kind === kind).length).toBeLessThanOrEqual(6)
    }
  })
})

describe('what is voiced', () => {
  const l = LEVELS.cinder_yard
  const es = emittersFor(l)
  it('only the nearest few continuous emitters, nearest first, and only within their range', () => {
    const near = nearestContinuous(es, l.start[0], l.start[1])
    expect(near.length).toBeLessThanOrEqual(MAX_CONTINUOUS)
    const d = near.map((e) => Math.hypot(e.x - l.start[0], e.z - l.start[1]))
    expect([...d].sort((a, b) => a - b)).toEqual(d)
    for (const e of near) expect(Math.hypot(e.x - l.start[0], e.z - l.start[1])).toBeLessThanOrEqual(SPEC[e.kind].range)
    expect(near.every((e) => SPEC[e.kind].continuous)).toBe(true)
  })
  it('nothing is voiced when you are far from everything', () => {
    expect(nearestContinuous(es, 9999, 9999)).toEqual([])
  })
})

describe('occlusion uses the level’s real walls and roofs', () => {
  it('a clear line is not muffled', () => {
    const o = occlusion({ walls: [], art: [] }, 0, 0, 10, 0)
    expect(o).toEqual({ blocked: 0, gain: 1, lowpass: 18000 })
  })
  it('a wall in the way costs loudness and the highs, and more walls cost more', () => {
    const wall = (x: number) => ({ x, z: 0, w: 1, d: 8, h: 3, kind: 'concrete' as const })
    const one = occlusion({ walls: [wall(5)], art: [] }, 0, 0, 10, 0)
    const two = occlusion({ walls: [wall(3), wall(7)], art: [] }, 0, 0, 10, 0)
    expect(one.blocked).toBe(1)
    expect(one.gain).toBeLessThan(1)
    expect(one.lowpass).toBeLessThan(18000)
    expect(two.gain).toBeLessThan(one.gain)
    expect(two.lowpass).toBeLessThan(one.lowpass)
  })
  it('a low barrier does not block sound; a wall beside the line does not either', () => {
    expect(occlusion({ walls: [{ x: 5, z: 0, w: 1, d: 8, h: 1, kind: 'barrier' }], art: [] }, 0, 0, 10, 0).blocked).toBe(0)
    expect(occlusion({ walls: [{ x: 5, z: 20, w: 1, d: 8, h: 3, kind: 'concrete' }], art: [] }, 0, 0, 10, 0).blocked).toBe(0)
  })
  it('a roof edge between you and a source counts as a wall', () => {
    const art = [{ kind: 'roof' as const, x: 0, z: 0, w: 10, d: 10 }]
    expect(occlusion({ walls: [], art }, 0, 0, 30, 0).blocked).toBe(1)   // you inside, it outside
    expect(occlusion({ walls: [], art }, 20, 0, 30, 0).blocked).toBe(0)  // both outside
    expect(occlusion({ walls: [], art }, -2, 0, 2, 0).blocked).toBe(0)   // both inside
  })
  it('segment-box intersection handles the edges', () => {
    const box = { x: 0, z: 0, w: 2, d: 2 }
    expect(segmentHitsBox(-5, 0, 5, 0, box)).toBe(true)
    expect(segmentHitsBox(-5, 3, 5, 3, box)).toBe(false)
    expect(segmentHitsBox(-5, 0, -2, 0, box)).toBe(false)   // stops short
    expect(segmentHitsBox(0, -5, 0, 5, box)).toBe(true)     // vertical
  })
  it('on the real levels, the same distance from a source is quieter and duller where a wall is in the way', () => {
    let checked = 0
    for (const l of [LEVELS.blacksite, LEVELS.cinder_yard]) {
      for (const e of emittersFor(l).filter((x) => SPEC[x.kind].continuous)) {
        // samples all round the source at the same distance: some lines cross walls, some do not
        const ring = Array.from({ length: 24 }, (_, i) => { const a = (i / 24) * Math.PI * 2; return mixFor(l, e, e.x + Math.cos(a) * 8, e.z + Math.sin(a) * 8, 0) })
        const blocked = ring.filter((m) => m.blocked > 0), clear = ring.filter((m) => m.blocked === 0)
        if (!blocked.length || !clear.length) continue
        // pan and distance differ round the ring, so compare the occlusion terms themselves
        expect(Math.max(...blocked.map((m) => m.lowpass))).toBeLessThan(Math.min(...clear.map((m) => m.lowpass)))
        checked++
      }
    }
    expect(checked).toBeGreaterThan(0) // the real walls do muffle things somewhere on these sites
  })
})

describe('fading and scheduling', () => {
  it('an emitter fades to nothing at the edge of its range rather than cutting off', () => {
    const l = LEVELS.cinder_yard
    const e = { id: 'p', kind: 'pump' as const, x: 0, z: 0 }
    const at = (d: number) => mixFor({ ...l, walls: [], art: [] }, e, d, 0, 0).gain
    expect(at(2)).toBeGreaterThan(at(15))
    expect(at(15)).toBeGreaterThan(at(SPEC.pump.range - 1))
    expect(at(SPEC.pump.range)).toBe(0)
  })
  it('periodic sounds are spaced inside their stated interval', () => {
    for (const k of ['steam', 'camera', 'radar', 'clank', 'chime', 'boom'] as EmitterKind[]) {
      const [lo, hi] = SPEC[k].every!
      expect(nextDelay(k, 0)).toBe(lo)
      expect(nextDelay(k, 0.999)).toBeLessThanOrEqual(hi)
    }
  })
  it('a bed is quiet: no emitter is louder at the source than a combat sound', () => {
    for (const s of Object.values(SPEC)) expect(s.gain).toBeLessThanOrEqual(0.6)
  })
})

describe('the economy changes what a site sounds like', () => {
  const fuelDown: WorldCues = { tick: 1, lines_down: [{ resource: 'fuel', line: 'fractionation unit', until: 50 }], deliveries: [] }
  const cinder = LEVELS.cinder_yard
  const kindsOf = (es: { kind: string }[]) => new Set(es.map((e) => e.kind))

  it('a line that is down goes silent: no pumps, steam vents or stack roar', () => {
    const running = emittersFor(cinder)
    const down = emittersFor(cinder, { idle: idleProps(cinder, fuelDown) })
    for (const k of ['pump', 'steam', 'stack']) { expect(kindsOf(running).has(k), k).toBe(true); expect(kindsOf(down).has(k), k).toBe(false) }
    // what is not part of that line keeps running
    for (const k of ['tank', 'lamp', 'clank']) expect(kindsOf(down).has(k), k).toBe(true)
  })
  it('with no cues a site sounds exactly as it always did', () => {
    expect(emittersFor(cinder, { idle: idleProps(cinder, null) })).toEqual(emittersFor(cinder))
    expect(emittersFor(cinder, { delivering: false })).toEqual(emittersFor(cinder))
  })
  it('a landing delivery runs the engines louder, and only the engines', () => {
    const l = LEVELS.dustline_depot
    const quiet = emittersFor(l), busy = emittersFor(l, { delivering: true })
    expect(busy.filter((e) => e.kind === 'engine').every((e) => (e.boost ?? 1) > 1)).toBe(true)
    expect(busy.filter((e) => e.kind !== 'engine').every((e) => e.boost === undefined)).toBe(true)
    const e = busy.find((x) => x.kind === 'engine')!, q = quiet.find((x) => x.kind === 'engine')!
    expect(mixFor(l, e, e.x + 1, e.z, 0).gain).toBeGreaterThan(mixFor(l, q, q.x + 1, q.z, 0).gain)
  })
  it('an idle truck is silent even while a delivery is landing (it is not running)', () => {
    const l = LEVELS.dustline_depot
    const idle = idleProps(l, { tick: 1, lines_down: [{ resource: 'fuel', line: 'fuel depot', until: 9 }], deliveries: [] })
    expect(emittersFor(l, { idle, delivering: true }).some((e) => e.kind === 'engine')).toBe(false)
  })
})
