import { describe, expect, it } from 'vitest'
import { buildOperationMission, conditionsFor, PRACTICE_SITES, type ConvoyContract, type OpKind } from '../convoy'
import { LEVELS } from '../levels'
import { NavGrid } from '../nav'
import { FPS_TUNING } from '../FpsSim'

const R = FPS_TUNING.ENEMY.BODY_R + 0.05
const KINDS: OpKind[] = ['raid', 'sabotage', 'recovery']
const PHASES = ['day', 'dusk', 'night'] as const

describe.each(PRACTICE_SITES)('$name: every operation kind, at every hour', (site) => {
  const lv = LEVELS[site.layout as keyof typeof LEVELS]
  const nav = new NavGrid(lv.bounds, [...lv.walls, ...lv.cover], R, 0.5)
  for (const kind of KINDS) for (const phase of PHASES) {
    it(`${kind} at ${phase}: objectives in order are reachable, guards stand on open floor and can reach the start, and it ends where it should`, () => {
      for (let seed = 1; seed <= 8; seed++) {
        const c: ConvoyContract = { id: `t-${site.id}-${seed}`, kind, issuer: 'Vex Exchange', target: 'vanguard', cargo: { resource: 'ammo', units: 60 }, defense: 3, seed, site, conditions: conditionsFor(phase) }
        const m = buildOperationMission(c)
        expect(m.level, 'the mission plays on this site\'s own level').toBe(lv.id)
        expect(m.objectives.length).toBeGreaterThan(1)
        // Walk the objectives in order from the start.
        let from = lv.start
        for (const o of m.objectives) {
          expect(nav.findPath(from[0], from[1], o.pos[0], o.pos[1]), `${kind} seed ${seed}: ${from} → ${o.kind}@${o.pos}`).not.toBeNull()
          from = o.pos
        }
        for (const e of m.enemies) {
          expect(nav.isFree(e.pos[0], e.pos[1]), `${kind} seed ${seed}: guard at ${e.pos}`).toBe(true)
          expect(nav.findPath(e.pos[0], e.pos[1], lv.start[0], lv.start[1]), `${kind} seed ${seed}: guard at ${e.pos} cannot reach the start`).not.toBeNull()
        }
        const last = m.objectives[m.objectives.length - 1].pos
        expect(last).toEqual(kind === 'raid' || kind === 'sabotage' ? lv.field.exfil.pos : lv.field.handover.pos)
        if (kind === 'sabotage') expect(m.objectives.filter((o) => o.kind === 'plant').map((o) => o.pos)).toEqual(lv.points.charges)
        if (kind === 'recovery') expect(m.objectives.find((o) => o.kind === 'retrieve')!.pos).toEqual(lv.field.seized)
        if (kind === 'raid') expect(m.field!.items.filter((i) => i.kind === 'cargo_case').length).toBeGreaterThan(0)
      }
    })
  }
})
