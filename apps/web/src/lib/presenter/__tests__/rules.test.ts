import { describe, expect, it } from 'vitest'
import type { WarActor } from '@/lib/api'
import { ammoTarget, armGuards, merchantCommit, merchantRoom, plannedGuards, reinforcements, scarcityBp, spendable } from '../rules'
import { ammoStatement, describeFaction, describeGuardPlan, fuelStatement, medStatement } from '../economy'

// Vectors copied from apps/api/crates/economy/src/mission.rs tests.
describe('mirrored engine rules', () => {
  it('arms rifles first, then sidearms; the rest stay home', () => {
    expect(armGuards(9, 72)).toEqual({ rifles: 9, sidearms: 0 })
    expect(armGuards(9, 40)).toEqual({ rifles: 5, sidearms: 0 })
    expect(armGuards(9, 44)).toEqual({ rifles: 5, sidearms: 2 })
    expect(armGuards(9, 0)).toEqual({ rifles: 0, sidearms: 0 })
    expect(armGuards(9, -5)).toEqual({ rifles: 0, sidearms: 0 })
  })
  it('plans 7..15 guards across defense 1..5', () => {
    expect([1, 2, 3, 4, 5].map(plannedGuards)).toEqual([7, 9, 11, 13, 15])
  })
  it('reinforcements follow medicine against requirement', () => {
    expect(reinforcements(0, 10, 3)).toBe(0)
    expect(reinforcements(5, 10, 3)).toBe(1)
    expect(reinforcements(10, 10, 3)).toBe(2)
    expect(reinforcements(10, 10, 4)).toBe(3)
  })
  it('ammo target is two days of need plus half a rifle-load per planned guard', () => {
    expect(ammoTarget(100, 4)).toBe(100 + (8 * 13) / 2) // 152
    expect(ammoTarget(88, 1)).toBe(88 + 28)             // 7 guards -> 28
  })
  it('mirrors merchant commit, room and scarcity', () => {
    expect(merchantCommit(100, 8_000)).toBe(80) // Vex-style 80% of the shelf
    expect(merchantCommit(50, 6_000)).toBe(30)  // Halcyon's 60%
    expect(merchantCommit(1, 6_000)).toBe(0)
    expect(merchantRoom(80, 30)).toBe(130)
    expect(merchantRoom(80, 200)).toBe(0)
    expect(scarcityBp(80, 80)).toBe(10_000)
    expect(scarcityBp(1, 80)).toBe(30_000) // clamped at ×3.0
    expect(scarcityBp(400, 80)).toBe(5_000) // clamped at ×0.5
    expect(scarcityBp(0, 80)).toBe(30_000)
  })
  it('spendable is credits above the reserve', () => {
    expect(spendable(500, 300)).toBe(200)
    expect(spendable(100, 300)).toBe(0)
  })
})

const actor = (over: Partial<WarActor> = {}): WarActor => ({
  id: 'vanguard', name: 'Vanguard', kind: 'faction',
  holdings: { credits: 2000, ammo: 200, med: 100, fuel: 100 },
  production: { ammo: 0, med: 0, fuel: 0 }, requirement: { ammo: 100, med: 50, fuel: 50 },
  credit_reserve: 500, income_per_day: 100, defense: 2,
  doctrine: { base_defense: 2, max_price_mult: 2, aggression: 10 },
  disrupted: [], recent_raids: 0, grudges: [], rivals: [], ...over,
})

describe('statements', () => {
  it('only claims what the engine does', () => {
    // 9 guards at defense 2, 44 ammo -> 5 rifles + 2 sidearms, 2 stay home.
    const s = ammoStatement(2, 44)
    expect(s.severity).toBe('warn')
    expect(s.effect).toContain('5 rifle guards and 2 sidearm guards')
    expect(s.effect).toContain('2 guards stay home')
    expect(ammoStatement(2, 0).severity).toBe('critical')
    expect(ammoStatement(2, 72).severity).toBe('ok')
  })
  it('fuel has exactly the engine thresholds (10 grounded, 20 no depot)', () => {
    expect(fuelStatement(9).severity).toBe('critical')
    expect(fuelStatement(10).severity).toBe('warn')
    expect(fuelStatement(19).severity).toBe('warn')
    expect(fuelStatement(20).severity).toBe('ok')
  })
  it('medicine tiers', () => {
    expect(medStatement(3, 0, 50).severity).toBe('critical')
    expect(medStatement(3, 10, 50).severity).toBe('warn')
    expect(medStatement(3, 50, 50).severity).toBe('ok')
  })
})

describe('faction readiness', () => {
  it('operational when nothing is short', () => {
    expect(describeFaction(actor()).readiness).toBe('operational')
  })
  it('supply critical when ammunition cannot arm any guard', () => {
    expect(describeFaction(actor({ holdings: { credits: 2000, ammo: 0, med: 100, fuel: 100 } })).readiness).toBe('supply_critical')
  })
  it('rebuilding only when a real inbound order covers the shortage', () => {
    const short = actor({ holdings: { credits: 2000, ammo: 0, med: 100, fuel: 100 } })
    expect(describeFaction(short, [{ resource: 'ammo', kind: 'order' }]).readiness).toBe('rebuilding')
    expect(describeFaction(short, [{ resource: 'fuel', kind: 'order' }]).readiness).toBe('supply_critical')
  })
  it('under pressure for a sabotaged line or a partial shortage', () => {
    expect(describeFaction(actor({ disrupted: [{ resource: 'fuel', until: 99 }] })).readiness).toBe('under_pressure')
    expect(describeFaction(actor({ holdings: { credits: 2000, ammo: 44, med: 100, fuel: 100 } })).readiness).toBe('under_pressure')
  })
  it('a strained treasury is critical only when something is short', () => {
    const broke = { credits: 300, ammo: 200, med: 100, fuel: 100 }
    expect(describeFaction(actor({ holdings: broke })).statements.find((s) => s.topic === 'credits')!.severity).not.toBe('critical')
    const shortAndBroke = describeFaction(actor({ holdings: { ...broke, med: 10 } }))
    expect(shortAndBroke.statements.find((s) => s.topic === 'credits')!.severity).toBe('critical')
  })
  it('judges ammunition against the commander\'s target, not bare requirement', () => {
    // defense 2: requirement 100, target 100 + 36 = 136. 120 ammo is under the target.
    const a = actor({ holdings: { credits: 300, ammo: 120, med: 100, fuel: 100 } })
    const credits = describeFaction(a).statements.find((s) => s.topic === 'credits')!
    expect(credits.severity).toBe('critical') // short on ammo (vs target) and at its reserve
  })
  it('uses the operation own ammunition when given (depot stock excluded)', () => {
    const a = actor({ holdings: { credits: 2000, ammo: 200, med: 100, fuel: 100 } })
    expect(describeFaction(a).statements[0].severity).toBe('ok')
    const raid = describeFaction(a, [], { ammoForGuards: 44 }).statements[0]
    expect(raid.severity).toBe('warn')
    expect(raid.factors.some((f) => f.value.includes('depot'))).toBe(true)
  })
  it('works from a view with no disruption list', () => {
    const { disrupted: _d, ...bare } = actor()
    void _d
    expect(describeFaction(bare).readiness).toBe('operational')
  })
  it('every statement exposes its exact factors', () => {
    for (const s of describeFaction(actor()).statements) expect(s.factors.length).toBeGreaterThan(0)
  })
})

describe('guard plan wording', () => {
  it('names the real target, not a hard-coded faction', () => {
    const g = { planned: 9, ammo_available: 0, hall: { rifles: 2, sidearms: 1 }, yard: { rifles: 2, sidearms: 1 }, guard_hp: 100, sidearm_damage_bp: 4500, reinforce_per_drop: 0, reinforce_every_secs_x100: 400 }
    const d = describeGuardPlan(g, 'Ashen Compact')
    expect(d.medical).toContain('Ashen Compact')
    expect(d.stayedHome).toBe(3)
    expect(d.arms).toBe('6 guards: 4 rifles, 2 sidearms')
  })
})
