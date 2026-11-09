import { describe, it, expect } from 'vitest'
import { sessionDead } from '../auth'

const live = { credit_budget: '500', unit_budget: '10', expires_at_ns: (Date.now() + 3_600_000) * 1e6, revoked: false }

describe('quick-trade revocation is judged from the chain record', () => {
  it('a live session is not dead', () => expect(sessionDead(live)).toBe(false))
  it('revoked, expired, spent or missing sessions are dead', () => {
    expect(sessionDead({ ...live, revoked: true })).toBe(true)
    expect(sessionDead({ ...live, expires_at_ns: (Date.now() - 1000) * 1e6 })).toBe(true)
    expect(sessionDead({ ...live, credit_budget: '0', unit_budget: '0' })).toBe(true)
    expect(sessionDead(null)).toBe(true)
  })
  it('a session with budget left on either side can still trade', () => {
    expect(sessionDead({ ...live, credit_budget: '0' })).toBe(false)
  })
})
