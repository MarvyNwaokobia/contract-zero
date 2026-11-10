import { describe, expect, it } from 'vitest'
import type { Consequence, FactionSnapshot, GuardPlan } from '@/lib/api'
import { describeConsequence } from '../consequence'

const snap = (ammo: number, over: Partial<FactionSnapshot> = {}): FactionSnapshot => ({
  tick: 100, id: 'vanguard', name: 'Vanguard', holdings: { credits: 1000, ammo, med: 30, fuel: 100 },
  requirement: { ammo: 100, med: 24, fuel: 96 }, defense: 2, credit_reserve: 300, disrupted: [], ...over,
})
const guards = (rifles: number, sidearms: number, drop = 2): GuardPlan => ({
  planned: 9, ammo_available: 0, hall: { rifles: Math.ceil(rifles / 2), sidearms: 0 }, yard: { rifles: Math.floor(rifles / 2), sidearms },
  guard_hp: 100, sidearm_damage_bp: 4500, reinforce_per_drop: drop, reinforce_every_secs_x100: 400,
})
const raid = (over: Partial<Consequence> = {}): Consequence => ({
  kind: 'raid', target: 'vanguard', resource: 'ammo', before: snap(100),
  faced: { available: true, reason: null, manifest: 60, defense: 2, guards: guards(9, 0) },
  after: snap(40), next: { available: true, reason: null, manifest: 24, defense: 2, guards: guards(5, 0) }, settled_tick: 100, ...over,
})
const res = { outcome: 'extracted' as const, kind: 'raid' as const, extracted_units: 60, resource: 'ammo' as const, bounty: 900, reason: null }

describe('consequence story', () => {
  it('tells all five parts of a settled raid from the recorded numbers', () => {
    const s = describeConsequence(res, raid())
    expect(s.recorded).toBe(true)
    expect(s.steps.map((x) => x.key)).toEqual(['accomplished', 'moved', 'lost', 'decided', 'next'])
    expect(s.steps[0].lines[0]).toBe('Carried out 60 ammunition.')
    expect(s.steps[1].lines[0]).toContain('60 ammunition moved from Vanguard')
    expect(s.steps[2].lines.join(' ')).toContain('100 → 40 (−60)')
    expect(s.steps[4].lines.join(' ')).toContain('→')
  })
  it('a killed run moves nothing and shows no change', () => {
    const s = describeConsequence({ ...res, outcome: 'killed', extracted_units: 0, bounty: 0 }, raid({ after: snap(100) }))
    expect(s.steps[1].lines).toEqual(['Nothing moved.'])
    expect(s.steps[2].lines[0]).toBe('Its stock did not change.')
  })
  it('does not invent an after for an unsettled operation', () => {
    const s = describeConsequence(res, raid({ after: null, next: null, settled_tick: null }))
    expect(s.steps[2].state).toBe('pending')
    expect(s.steps[3].state).toBe('pending')
    expect(s.steps[4].state).toBe('pending')
  })
  it('says nothing was recorded when the session has no snapshot', () => {
    const s = describeConsequence(res, null)
    expect(s.recorded).toBe(false)
    expect(s.steps[1].state).toBe('none')
    expect(s.steps[1].lines[0]).toContain('No before-and-after snapshot')
  })
  it('the commander’s reaction is only its real logged decisions', () => {
    const waiting = describeConsequence(res, raid(), { recorded: true, settled: true, decisions: [] })
    expect(waiting.steps[3].state).toBe('pending')
    const acted = describeConsequence(res, raid(), { recorded: true, settled: true, decisions: [{ seq: 1, tick: 101, payload: { rationale: 'Ammo below target: buying 40.', action: { action: 'place_order' }, validation: 'accepted' } }] })
    expect(acted.steps[3].state).toBe('done')
    expect(acted.steps[3].lines[0]).toContain('Ammo below target')
    const quiet = describeConsequence(res, raid(), { recorded: true, settled: true, decisions: [{ seq: 2, tick: 101, payload: { rationale: 'Quiet period.', action: null, validation: 'no_action' } }] })
    expect(quiet.steps[3].lines[0]).toContain('took no action')
  })
  it('sabotage reports the production line down and its real duration', () => {
    const c = raid({ kind: 'sabotage', after: snap(60, { disrupted: [{ resource: 'ammo', until: 136 }] }) })
    const s = describeConsequence({ ...res, kind: 'sabotage' }, c)
    expect(s.steps[1].lines[0]).toContain('destroyed')
    expect(s.steps[2].lines.join(' ')).toContain('(36 in-game hours)')
  })
  it('an unavailable next operation carries the engine’s reason', () => {
    const c = raid({ next: { available: false, reason: 'Vanguard holds less than 20 fuel, so it cannot stage a depot', manifest: 0, defense: 2, guards: null } })
    expect(describeConsequence(res, c).steps[4].lines[0]).toContain('cannot stage a depot')
  })
  it('flags a readiness change from before to after', () => {
    const c = raid({ before: snap(200), after: snap(0) })
    expect(describeConsequence(res, c).steps[2].lines.join(' ')).toMatch(/Readiness: Operational → /)
  })
})
