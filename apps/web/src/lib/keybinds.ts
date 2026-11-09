// Keyboard bindings: every game action the keyboard can trigger, its default keys,
// the keys a player may not take (the browser or the game needs them), conflict
// handling and readable key names. Bindings are KeyboardEvent.code values, so they
// follow the physical key whatever the layout. Mouse buttons are fixed: left fires,
// right aims.

export type Action =
  | 'moveForward' | 'moveBack' | 'moveLeft' | 'moveRight'
  | 'lookUp' | 'lookDown' | 'lookLeft' | 'lookRight'
  | 'fire' | 'aim' | 'reload' | 'fireMode' | 'primary' | 'secondary' | 'swap'
  | 'interact' | 'inspect' | 'heal' | 'crouch' | 'leanLeft' | 'leanRight'
  | 'nvg' | 'light' | 'laser' | 'optic' | 'target' | 'opsMenu' | 'perf'

/** Two slots per action: a primary key and an optional second one. */
export type Binds = Record<Action, [string | null, string | null]>

export interface ActionInfo { id: Action; label: string; group: 'Movement' | 'Look' | 'Combat' | 'Field' | 'Equipment' | 'Interface'; required?: boolean }

export const ACTIONS: ActionInfo[] = [
  { id: 'moveForward', label: 'Move forward', group: 'Movement', required: true },
  { id: 'moveBack', label: 'Move back', group: 'Movement', required: true },
  { id: 'moveLeft', label: 'Strafe left', group: 'Movement', required: true },
  { id: 'moveRight', label: 'Strafe right', group: 'Movement', required: true },
  { id: 'crouch', label: 'Crouch', group: 'Movement' },
  { id: 'leanLeft', label: 'Lean left', group: 'Movement' },
  { id: 'leanRight', label: 'Lean right', group: 'Movement' },
  { id: 'lookUp', label: 'Look up', group: 'Look' },
  { id: 'lookDown', label: 'Look down', group: 'Look' },
  { id: 'lookLeft', label: 'Look left', group: 'Look' },
  { id: 'lookRight', label: 'Look right', group: 'Look' },
  { id: 'fire', label: 'Fire', group: 'Combat', required: true },
  { id: 'aim', label: 'Aim down sights', group: 'Combat' },
  { id: 'reload', label: 'Reload', group: 'Combat', required: true },
  { id: 'fireMode', label: 'Fire mode', group: 'Combat' },
  { id: 'primary', label: 'Primary weapon', group: 'Combat' },
  { id: 'secondary', label: 'Sidearm', group: 'Combat' },
  { id: 'swap', label: 'Swap weapon', group: 'Combat' },
  { id: 'target', label: 'Target lock', group: 'Combat' },
  { id: 'interact', label: 'Use / interact', group: 'Field', required: true },
  { id: 'inspect', label: 'Inspect item', group: 'Field' },
  { id: 'heal', label: 'Field dressing', group: 'Field' },
  { id: 'nvg', label: 'Night vision', group: 'Equipment' },
  { id: 'light', label: 'Weapon light', group: 'Equipment' },
  { id: 'laser', label: 'Laser sight', group: 'Equipment' },
  { id: 'optic', label: 'Optic', group: 'Equipment' },
  { id: 'opsMenu', label: 'Operations board', group: 'Interface' },
  { id: 'perf', label: 'Performance readout', group: 'Interface' },
]

export const DEFAULT_BINDS: Binds = {
  moveForward: ['KeyW', null], moveBack: ['KeyS', null], moveLeft: ['KeyA', null], moveRight: ['KeyD', null],
  lookUp: ['ArrowUp', null], lookDown: ['ArrowDown', null], lookLeft: ['ArrowLeft', null], lookRight: ['ArrowRight', null],
  fire: ['Space', null], aim: ['ShiftLeft', 'ShiftRight'], reload: ['KeyR', null], fireMode: ['KeyB', null],
  primary: ['Digit1', null], secondary: ['Digit2', null], swap: ['KeyX', null], target: ['KeyT', null],
  interact: ['KeyE', null], inspect: ['KeyI', null], heal: ['KeyH', null],
  crouch: ['KeyC', null], leanLeft: ['KeyQ', null], leanRight: ['KeyG', null],
  nvg: ['KeyN', null], light: ['KeyF', null], laser: ['KeyL', null], optic: ['KeyO', null],
  opsMenu: ['KeyM', null], perf: ['KeyP', null],
}

/** Keys a player can't bind, and why. */
export function reservedReason(code: string): string | null {
  if (code === 'Escape') return 'Esc pauses the game and releases the mouse.'
  if (code === 'Tab') return 'Tab moves keyboard focus between controls.'
  if (code.startsWith('Meta') || code.startsWith('OS')) return 'The system key belongs to the operating system.'
  if (code.startsWith('Control')) return 'Ctrl + W would close the browser tab while you move.'
  if (/^F\d{1,2}$/.test(code)) return 'Function keys belong to the browser (reload, full screen, developer tools).'
  if (code === 'ContextMenu' || code === 'PrintScreen' || code === 'Fn' || code === 'FnLock') return 'The system uses this key.'
  return null
}

const CODE_RE = /^[A-Za-z][A-Za-z0-9]{1,24}$/

export function validCode(c: unknown): c is string {
  return typeof c === 'string' && CODE_RE.test(c) && reservedReason(c) === null
}

/** Read stored bindings into a valid set: unknown actions dropped, bad or reserved
 *  keys cleared, and a key claimed twice kept only by its first action. */
export function normalizeBinds(raw: unknown): Binds {
  const out = structuredCloneBinds(DEFAULT_BINDS)
  if (!raw || typeof raw !== 'object') return out
  const stored = raw as Record<string, unknown>
  const taken = new Set<string>()
  // Keys the player chose come first, in action order; a key claimed twice stays with
  // the first action that claims it.
  for (const a of ACTIONS) {
    const v = stored[a.id]
    if (!Array.isArray(v)) continue
    const slots: [string | null, string | null] = [null, null]
    for (let i = 0; i < 2; i++) {
      const c = v[i]
      if (validCode(c) && !taken.has(c)) { slots[i] = c; taken.add(c) }
    }
    out[a.id] = slots
  }
  // Actions with nothing stored keep their defaults, minus any key the player moved.
  for (const a of ACTIONS) {
    if (Array.isArray(stored[a.id])) continue
    out[a.id] = out[a.id].map((c) => (c && !taken.has(c) ? (taken.add(c), c) : null)) as [string | null, string | null]
  }
  return out
}

function structuredCloneBinds(b: Binds): Binds {
  return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, [v[0], v[1]]])) as Binds
}

/** Who currently holds a key (other than `except`). */
export function holder(binds: Binds, code: string, except?: { action: Action; slot: 0 | 1 }): { action: Action; slot: 0 | 1 } | null {
  for (const a of ACTIONS) for (const slot of [0, 1] as const) {
    if (except && except.action === a.id && except.slot === slot) continue
    if (binds[a.id][slot] === code) return { action: a.id, slot }
  }
  return null
}

export interface AssignResult { binds: Binds; displaced: { action: Action; slot: 0 | 1 } | null; error: string | null }

/** Put `code` on an action's slot. A key already used elsewhere moves here, and the
 *  result names the action that lost it, so the page can say so (and offer undo). */
export function assign(binds: Binds, action: Action, slot: 0 | 1, code: string): AssignResult {
  const why = reservedReason(code)
  if (why) return { binds, displaced: null, error: why }
  if (!CODE_RE.test(code)) return { binds, displaced: null, error: 'That key can’t be bound.' }
  const next = structuredCloneBinds(binds)
  const other = holder(binds, code, { action, slot })
  if (other) next[other.action][other.slot] = null
  next[action][slot] = code
  // Two slots of one action never hold the same key.
  if (next[action][slot ^ 1] === code) next[action][slot ^ 1] = null
  return { binds: next, displaced: other && other.action !== action ? other : null, error: null }
}

export function clearSlot(binds: Binds, action: Action, slot: 0 | 1): Binds {
  const next = structuredCloneBinds(binds)
  next[action][slot] = null
  return next
}

/** Actions that need a key and have none. */
export function unboundRequired(binds: Binds): ActionInfo[] {
  return ACTIONS.filter((a) => a.required && !binds[a.id][0] && !binds[a.id][1])
}

/** Keys bound to more than one action (only possible in hand-edited storage before
 *  normalizeBinds runs; the page shows them if they ever appear). */
export function conflicts(binds: Binds): Map<string, Action[]> {
  const m = new Map<string, Action[]>()
  for (const a of ACTIONS) for (const c of binds[a.id]) if (c) m.set(c, [...(m.get(c) ?? []), a.id])
  return new Map([...m].filter(([, v]) => v.length > 1))
}

/** code → actions, for the game's key handler. */
export function actionsByCode(binds: Binds): Map<string, Action[]> {
  const m = new Map<string, Action[]>()
  for (const a of ACTIONS) for (const c of binds[a.id]) if (c) m.set(c, [...(m.get(c) ?? []), a.id])
  return m
}

const NAMED: Record<string, string> = {
  Space: 'Space', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', AltLeft: 'L-Alt', AltRight: 'R-Alt',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: 'Enter', Backspace: 'Backspace',
  CapsLock: 'Caps', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Delete: 'Del',
  Insert: 'Ins', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn', IntlBackslash: '§',
}

/** A short, readable name for a key code. */
export function keyLabel(code: string | null | undefined): string {
  if (!code) return '—'
  if (NAMED[code]) return NAMED[code]
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`
  return code
}

/** The label for an action's first bound key (for HUD prompts), or '—'. */
export function bindLabel(binds: Binds, action: Action): string {
  return keyLabel(binds[action][0] ?? binds[action][1])
}
