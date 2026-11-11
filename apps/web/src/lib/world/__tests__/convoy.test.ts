import { describe, expect, it } from 'vitest'
import { convoyState } from '../convoy'

// The exact JSON the live API returned for these (found when the table showed every
// convoy parked at its destination).
describe('convoy status as the server serialises it', () => {
  it('reads the bare-string variants', () => {
    expect(convoyState('in_transit')).toEqual({ state: 'in_transit' })
    expect(convoyState('arrived')).toEqual({ state: 'arrived' })
  })
  it('reads a seizure and who took it', () => {
    expect(convoyState({ seized: { by: 'ashen' } })).toEqual({ state: 'seized', by: 'ashen' })
  })
  it('never throws on something unexpected', () => {
    for (const v of [undefined, null, 7, {}, 'lost', { seized: null }]) expect(convoyState(v).state === 'other' || convoyState(v).state === 'seized').toBe(true)
  })
})
