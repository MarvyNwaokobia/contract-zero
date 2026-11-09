import { describe, it, expect } from 'vitest'
import { ACTIONS, DEFAULT_BINDS, actionsByCode, assign, clearSlot, conflicts, keyLabel, normalizeBinds, reservedReason, unboundRequired } from '../keybinds'

describe('key bindings', () => {
  it('defaults are complete and conflict-free', () => {
    expect(Object.keys(DEFAULT_BINDS).sort()).toEqual(ACTIONS.map((a) => a.id).sort())
    expect(conflicts(DEFAULT_BINDS).size).toBe(0)
    expect(unboundRequired(DEFAULT_BINDS)).toEqual([])
    for (const a of ACTIONS) for (const c of DEFAULT_BINDS[a.id]) if (c) expect(reservedReason(c)).toBeNull()
  })
  it('refuses reserved keys with a reason', () => {
    for (const k of ['Escape', 'Tab', 'MetaLeft', 'ControlLeft', 'F5', 'F11', 'F12', 'ContextMenu']) {
      const r = assign(DEFAULT_BINDS, 'reload', 0, k)
      expect(r.error, k).toBeTruthy()
      expect(r.binds).toBe(DEFAULT_BINDS)
    }
  })
  it('moving a key off another action names the action that lost it', () => {
    const r = assign(DEFAULT_BINDS, 'reload', 0, 'KeyE')
    expect(r.error).toBeNull()
    expect(r.binds.reload[0]).toBe('KeyE')
    expect(r.binds.interact[0]).toBeNull()
    expect(r.displaced).toEqual({ action: 'interact', slot: 0 })
    expect(conflicts(r.binds).size).toBe(0)
    expect(unboundRequired(r.binds).map((a) => a.id)).toEqual(['interact'])
  })
  it('the two slots of one action never hold the same key', () => {
    const r = assign(DEFAULT_BINDS, 'aim', 1, 'ShiftLeft')
    expect(r.binds.aim).toEqual([null, 'ShiftLeft'])
    expect(r.displaced).toBeNull()
  })
  it('clearing a slot leaves the rest alone', () => {
    const b = clearSlot(DEFAULT_BINDS, 'aim', 1)
    expect(b.aim).toEqual(['ShiftLeft', null])
    expect(b.fire).toEqual(DEFAULT_BINDS.fire)
  })
  it('normalizes hand-edited or corrupt storage', () => {
    expect(normalizeBinds('junk')).toEqual(DEFAULT_BINDS)
    // A stored key claimed by two actions stays with the first; a stolen default is cleared.
    const b = normalizeBinds({ moveForward: ['KeyR', null], reload: ['KeyR', 'Escape'], fire: ['<script>', 42] })
    expect(b.moveForward).toEqual(['KeyR', null])
    expect(b.reload).toEqual([null, null])
    expect(b.fire).toEqual([null, null])
    expect(conflicts(b).size).toBe(0)
    // Remapping W elsewhere frees nothing silently: the default W on moveForward is gone.
    const c = normalizeBinds({ crouch: ['KeyW', null] })
    expect(c.crouch[0]).toBe('KeyW')
    expect(c.moveForward[0]).toBeNull()
  })
  it('the game reads code → action', () => {
    const m = actionsByCode(assign(DEFAULT_BINDS, 'reload', 1, 'KeyK').binds)
    expect(m.get('KeyK')).toEqual(['reload'])
    expect(m.get('KeyR')).toEqual(['reload'])
    expect(m.get('ShiftRight')).toEqual(['aim'])
  })
  it('labels keys readably', () => {
    expect([keyLabel('KeyW'), keyLabel('Digit1'), keyLabel('ShiftLeft'), keyLabel('ArrowUp'), keyLabel('Numpad5'), keyLabel(null)]).toEqual(['W', '1', 'L-Shift', '↑', 'Num 5', '—'])
  })
})
