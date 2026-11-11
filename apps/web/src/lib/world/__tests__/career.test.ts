import { describe, expect, it } from 'vitest'
import type { Career } from '@/lib/api'
import { extractionRate, missionLine } from '../career'

const m = (o: Partial<Career['missions'][number]>) => ({ at: '2026-11-11T00:00:00Z', codename: 'X', outcome: 'extracted', kind: 'raid', target: 'vanguard', resource: 'ammo', units: 20, fee: null, settlement: null, ...o }) as Career['missions'][number]

describe('service record', () => {
  it('rates extractions against finished runs only, and gives no rate before there is one', () => {
    expect(extractionRate({ operations: 4, extracted: 3, lost: 1, units_moved: 0, fees_earned: 0 })).toBe(75)
    expect(extractionRate({ operations: 2, extracted: 0, lost: 0, units_moved: 0, fees_earned: 0 })).toBeNull()
  })
  it('describes a finished operation in plain words', () => {
    expect(missionLine(m({}))).toBe("Raid on Vanguard's ammo · 20 units")
    expect(missionLine(m({ kind: 'sabotage', target: 'ashen', resource: 'fuel', units: null, fee: 300 }))).toBe("Sabotage on Ashen Compact's fuel · 300 cr")
  })
  it('never prints a dangling "on \'s" for an operation still in the field', () => {
    const line = missionLine(m({ kind: null, target: null, resource: null, units: null }))
    expect(line).toBe('')
    expect(missionLine(m({ target: null, resource: null, units: null }))).toBe('Raid')
  })
})
