import { describe, expect, it } from 'vitest'
import type { AgentEvent, BoardEntry, MarketOrder, OperationRecord, WarActor, WarContract, WarConvoy } from '@/lib/api'
import { facilityIntel, type IntelInput } from '../intel'
import type { TableFacility } from '../table'

const dep: TableFacility = { id: 'dustline-depot', kind: 'site', name: 'Dustline Depot', subtitle: 'x', owner: 'vanguard', pos: { x: 0, y: 0 }, siteId: 'dustline-depot' }
const vex: TableFacility = { id: 'exchange:vex', kind: 'exchange', name: 'Vex', subtitle: 'Merchant', owner: 'vex', pos: { x: 0, y: 0 } }
const entry = (siteId: string) => ({ kind: 'raid', target: 'vanguard', resource: 'ammo', site: { id: siteId } }) as unknown as BoardEntry
const op = (target: string) => ({ consequence: { target } }) as unknown as OperationRecord
const input: IntelInput = {
  actors: [{ id: 'vanguard', name: 'Vanguard' }, { id: 'vex', name: 'Vex' }] as WarActor[],
  convoys: [{ id: 1, owner: 'vanguard' }, { id: 2, owner: 'vex' }] as WarConvoy[],
  contracts: [{ id: 1, target: 'vanguard' }, { id: 2, target: 'ashen' }] as WarContract[],
  world: {
    sites: [{ id: 'dustline-depot', name: 'Dustline Depot', owner: 'vanguard', layout: 'x', shared_layout: false, environment: 'x', lines: [{ line: 'munitions line', resource: 'ammo', down_until: 90 }] }],
    board: [entry('dustline-depot'), entry('blacksite')],
    raids: [{ id: 1, player: 'p', started_at: 1, plan: { target: 'vanguard', kind: 'raid', resource: 'ammo', site: 'dustline-depot' }, status: { state: 'active' } }, { id: 2, player: 'p', started_at: 1, plan: { target: 'vanguard', kind: 'raid', resource: 'ammo', site: 'dustline-depot' }, status: { state: 'failed' } }],
  },
  orders: [{ requester: 'vanguard', status: { status: 'open' } }, { requester: 'vanguard', status: { status: 'filled' } }] as unknown as MarketOrder[],
  operations: [op('vanguard'), op('ashen'), op('vanguard')],
  decisions: [{ seq: 3, source: 'ashen' }, { seq: 2, source: 'vanguard' }, { seq: 1, source: 'vanguard' }] as unknown as AgentEvent[],
}

describe('facility intel', () => {
  it('lists only the contracts at this site and only players actually deployed there', () => {
    const i = facilityIntel(dep, input)
    expect(i.missions).toHaveLength(1)
    expect(i.activeOperations).toBe(1)
    expect(i.lines[0].down_until).toBe(90)
  })
  it('joins the owner’s convoys, open orders and contracts against it', () => {
    const i = facilityIntel(dep, input)
    expect(i.convoys.map((c) => c.id)).toEqual([1])
    expect(i.openOrders).toHaveLength(1)
    expect(i.contractsAgainst.map((c) => c.id)).toEqual([1])
  })
  it('attacks are the owner’s recorded operations; the latest decision is the owner’s newest', () => {
    const i = facilityIntel(dep, input)
    expect(i.attacks).toHaveLength(2)
    expect(i.latestDecision?.seq).toBe(2)
  })
  it('a merchant has no site, no missions and no active operations', () => {
    const i = facilityIntel(vex, input)
    expect(i.site).toBeUndefined()
    expect(i.missions).toEqual([])
    expect(i.activeOperations).toBe(0)
    expect(i.convoys.map((c) => c.id)).toEqual([2])
  })
  it('leaves fields empty rather than inventing them when there is no record', () => {
    const i = facilityIntel(dep, { actors: [], convoys: [], contracts: [] })
    expect(i.owner).toBeUndefined()
    expect(i.missions).toEqual([])
    expect(i.attacks).toEqual([])
    expect(i.latestDecision).toBeUndefined()
  })
})
