'use client'

// Visual control layouts for the Field Manual: a keyboard with each bound key labelled
// by its action (from the player's own bindings), and the touch HUD's layout as it
// sits on a phone held landscape (positions from engine/scene/ContractZeroScene).

import { ACTIONS, keyLabel, type Action, type Binds } from '@/lib/keybinds'

const GROUP_COLOR: Record<string, string> = {
  Movement: '#f0a03c', Look: '#6fa3c7', Combat: '#e5484d', Field: '#46c37b', Equipment: '#b48cf0', Interface: '#8d929a',
}

const ROWS: string[][] = [
  ['Escape', 'Digit1', 'Digit2', 'Digit3', 'Digit4'],
  ['Tab', 'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP'],
  ['CapsLock', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL'],
  ['ShiftLeft', 'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'ShiftRight'],
  ['Space', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight'],
]
const WIDE: Record<string, number> = { Tab: 1.4, CapsLock: 1.7, ShiftLeft: 2.2, ShiftRight: 2.2, Space: 6, Escape: 1.2 }
const SHORT: Partial<Record<Action, string>> = {
  moveForward: 'fwd', moveBack: 'back', moveLeft: 'left', moveRight: 'right', lookUp: 'look', lookDown: 'look', lookLeft: 'look', lookRight: 'look',
  fire: 'fire', aim: 'aim', reload: 'reload', fireMode: 'mode', primary: 'gun 1', secondary: 'gun 2', swap: 'swap', target: 'lock',
  interact: 'use', inspect: 'inspect', heal: 'heal', crouch: 'crouch', leanLeft: 'lean', leanRight: 'lean',
  nvg: 'NVG', light: 'light', laser: 'laser', optic: 'optic', opsMenu: 'ops', perf: 'fps',
}

export function KeyboardDiagram({ binds }: { binds: Binds }) {
  const byCode = new Map<string, Action>()
  for (const a of ACTIONS) for (const c of binds[a.id]) if (c) byCode.set(c, a.id)
  const group = (a: Action) => ACTIONS.find((x) => x.id === a)!.group
  return (
    <figure className="my-2" aria-label="Keyboard layout with each key's action" data-testid="keyboard-diagram">
      <div className="overflow-x-auto">
        <div className="inline-grid min-w-[560px] gap-1">
          {ROWS.map((row, i) => (
            <div key={i} className="flex gap-1" style={{ paddingLeft: i === 0 ? 0 : i * 6 }}>
              {row.map((code) => {
                const a = code === 'Escape' ? null : byCode.get(code)
                const color = code === 'Escape' ? '#e8e4dc' : a ? GROUP_COLOR[group(a)] : undefined
                return (
                  <div key={code} title={a ? ACTIONS.find((x) => x.id === a)!.label : code === 'Escape' ? 'Pause, release the mouse' : undefined}
                    className="flex h-11 flex-col items-center justify-center rounded border text-center"
                    style={{ width: 40 * (WIDE[code] ?? 1), borderColor: color ?? '#262b32', background: color ? `${color}1f` : 'transparent' }}>
                    <span className={`font-mono text-[11px] font-bold ${color ? 'text-fog' : 'text-dim'}`}>{keyLabel(code)}</span>
                    {(a || code === 'Escape') && <span className="text-[9px] uppercase leading-none tracking-wider" style={{ color }}>{code === 'Escape' ? 'pause' : SHORT[a!]}</span>}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
      <figcaption className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-dim">
        {Object.entries(GROUP_COLOR).map(([g, c]) => <span key={g} className="inline-flex items-center gap-1"><span className="h-2 w-2" style={{ background: c }} aria-hidden />{g}</span>)}
        <span>· Mouse: look; left fires, right aims</span>
      </figcaption>
    </figure>
  )
}

/** The touch HUD, schematic: a phone held landscape. */
export function TouchDiagram() {
  const btn = (label: string, style: React.CSSProperties, color = '#e9edf2', round = true) => (
    <div className="absolute grid place-items-center text-center text-[9px] font-bold uppercase leading-tight tracking-wider" style={{ border: `1px solid ${color}`, color, borderRadius: round ? '50%' : 4, background: `${color}14`, ...style }}>{label}</div>
  )
  return (
    <figure className="my-2" aria-label="Touch control layout on a phone held landscape" data-testid="touch-diagram">
      <div className="relative mx-auto aspect-[2.16/1] w-full max-w-[560px] rounded-[18px] border-2 border-line-strong bg-[radial-gradient(circle_at_50%_40%,#2b3036,#121418)]">
        <div className="absolute left-[30%] right-[30%] top-[40%] text-center text-[10px] uppercase tracking-[0.2em] text-dim">drag anywhere to look</div>
        {btn('pause · exit', { left: '3%', top: '6%', width: '15%', height: '10%' }, '#8d929a', false)}
        {btn('NVG · light · laser · optic', { left: '3%', top: '19%', width: '26%', height: '9%' }, '#b48cf0', false)}
        {btn('move stick', { left: '4%', bottom: '7%', width: '20%', aspectRatio: '1' }, '#eab308')}
        {btn('fire', { right: '3%', bottom: '7%', width: '14%', aspectRatio: '1' }, '#ff6a4d')}
        {btn('lock', { right: '18%', bottom: '32%', width: '9%', aspectRatio: '1' }, '#eab308')}
        {btn('ADS', { right: '19%', bottom: '8%', width: '9%', aspectRatio: '1' }, '#cfe0ea')}
        {btn('crouch', { right: '30%', bottom: '8%', width: '9%', aspectRatio: '1' }, '#8fb8d0')}
        {btn('USE', { right: '41%', bottom: '8%', width: '9%', aspectRatio: '1' }, '#e9edf2')}
        {btn('MED', { right: '3%', top: '7%', width: '8%', aspectRatio: '1' }, '#5fe0a8')}
        {btn('swap · reload · mode', { right: '2%', top: '27%', width: '10%', height: '26%' }, '#9fb4c8', false)}
      </div>
      <figcaption className="mt-2 text-center text-[11px] text-dim">ADS and crouch toggle. Hold USE until the bar fills. Play in landscape.</figcaption>
    </figure>
  )
}
