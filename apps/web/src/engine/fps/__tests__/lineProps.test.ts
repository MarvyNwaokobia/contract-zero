import { describe, expect, it } from 'vitest'
import { idleProps, isDelivering, LINE_MAP, NO_IDLE, worldClock, type WorldCues } from '../lineProps'
import { LEVELS } from '../levels'

const down = (resource: 'ammo' | 'med' | 'fuel', line: string, until = 100): WorldCues => ({ tick: 64, lines_down: [{ resource, line, until }], deliveries: [] })
const inBounds = (l: (typeof LEVELS)[keyof typeof LEVELS], [x, z]: [number, number]) => x >= l.bounds.minX - 1 && x <= l.bounds.maxX + 1 && z >= l.bounds.minZ - 1 && z <= l.bounds.maxZ + 1

describe('a line that is down idles the things that run it', () => {
  it('Cinder Yard: the fractionation unit stops its stack, steam vents and pumps', () => {
    const l = LEVELS.cinder_yard
    const idle = idleProps(l, down('fuel', 'fractionation unit'))
    expect([...idle.art].every((a) => a.kind === 'steam' || a.kind === 'stack')).toBe(true)
    expect([...idle.art].some((a) => a.kind === 'stack')).toBe(true)
    expect([...idle.art].some((a) => a.kind === 'steam')).toBe(true)
    expect([...idle.boxes].every((b) => b.kind === 'pump')).toBe(true)
    expect(idle.boxes.size).toBeGreaterThan(0)
    expect(idle.lines).toHaveLength(1)
    expect(idle.lines[0].line).toBe('fractionation unit')
    expect(idle.lines[0].until).toBe(100)
  })
  it('Dustline: the fuel depot idles the motor pool’s trucks; the munitions line is marked where its work is done', () => {
    const l = LEVELS.dustline_depot
    const fuel = idleProps(l, down('fuel', 'fuel depot'))
    expect(fuel.boxes.size).toBeGreaterThan(0)
    expect([...fuel.boxes].every((b) => b.kind === 'truck')).toBe(true)
    const ammo = idleProps(l, down('ammo', 'munitions line'))
    expect(ammo.boxes.size).toBe(0)                     // no machinery of its own
    expect(ammo.lines[0].anchor).toEqual(l.points.cargo) // but it is marked at the munitions warehouse
  })
  it('the Blacksite: the server room idles its servers; the APC bay its trucks', () => {
    const l = LEVELS.blacksite
    expect([...idleProps(l, down('ammo', 'server room')).boxes].every((b) => b.kind === 'server')).toBe(true)
    expect([...idleProps(l, down('fuel', 'APC motor bay')).boxes].every((b) => b.kind === 'truck')).toBe(true)
  })
  it('markers stand inside the level, near what they mark', () => {
    for (const l of Object.values(LEVELS)) for (const r of ['ammo', 'fuel'] as const) {
      const m = LINE_MAP[l.id][r]
      if (!m) continue
      const idle = idleProps(l, down(r, 'x'))
      expect(inBounds(l, idle.lines[0].anchor), `${l.id} ${r}`).toBe(true)
    }
  })
  it('nothing is invented: a quiet site, a line this map does not have, or no cues at all idle nothing', () => {
    const l = LEVELS.cinder_yard
    expect(idleProps(l, undefined)).toBe(NO_IDLE)
    expect(idleProps(l, null)).toBe(NO_IDLE)
    expect(idleProps(l, { tick: 1, lines_down: [], deliveries: [] })).toBe(NO_IDLE)
    const ammoAtCinder = idleProps(l, down('ammo', 'something'))        // Cinder Yard has no ammunition line
    expect(ammoAtCinder.boxes.size + ammoAtCinder.art.size + ammoAtCinder.lines.length).toBe(0)
  })
  it('only the down line’s props idle: the other line keeps running', () => {
    const l = LEVELS.blacksite
    const idle = idleProps(l, down('ammo', 'server room'))
    const trucks = [...l.walls, ...l.cover].filter((b) => b.kind === 'truck')
    for (const t of trucks) expect(idle.boxes.has(t)).toBe(false)
  })
  it('two lines down at once both show', () => {
    const l = LEVELS.dustline_depot
    const cues: WorldCues = { tick: 1, lines_down: [{ resource: 'ammo', line: 'munitions line', until: 50 }, { resource: 'fuel', line: 'fuel depot', until: 60 }], deliveries: [] }
    expect(idleProps(l, cues).lines.map((x) => x.resource)).toEqual(['ammo', 'fuel'])
  })
})

describe('deliveries and the clock', () => {
  it('a delivery is only "delivering" when the server reported one', () => {
    expect(isDelivering(undefined)).toBe(false)
    expect(isDelivering({ tick: 1, lines_down: [], deliveries: [] })).toBe(false)
    expect(isDelivering({ tick: 1, lines_down: [], deliveries: [{ resource: 'fuel', units: 60, arrives_at: 5, state: 'arriving' }] })).toBe(true)
  })
  it('writes the world clock like the war room', () => {
    expect(worldClock(82)).toBe('D3 10:00')
  })
})
