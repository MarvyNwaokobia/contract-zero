// Authored portraits for the five voices. Original stylised busts: the gear tells you who it is
// (a headset, a ledger, a welder's mask, a lamp, a tablet) and there are deliberately no faces,
// so nothing here decides what these people look like. Drawn with currentColor on a 96 grid;
// each carries its power's accent. The visual direction is in docs/contract-zero/PERSONAS.md.

import { PERSONAS } from '@/lib/personas'

const ACCENT: Record<string, string> = {
  handler: '#8fd6e8',
  vanguard: 'var(--color-steel)',
  ashen: 'var(--color-hostile)',
  vex: 'var(--color-amber)',
  halcyon: '#9fc3e0',
}

export function Portrait({ id, size = 64, title }: { id: string; size?: number; title?: string }) {
  const accent = ACCENT[id] ?? 'var(--color-muted)'
  const p = PERSONAS[id]
  const label = title ?? (p ? `${p.name}, ${p.title}` : undefined)
  const strk = { stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  const line = { fill: 'none' as const, ...strk }
  return (
    <svg viewBox="0 0 96 96" width={size} height={size} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} data-portrait={id}
      style={{ color: accent, background: 'var(--color-panel-2)', border: '1px solid var(--color-line-strong)' }}>
      {label && <title>{label}</title>}
      {/* shoulders and a head: the same frame for everyone, so the gear is what differs */}
      <path d="M10 96c2-20 14-28 38-28s36 8 38 28z" fill="currentColor" fillOpacity="0.16" {...strk} />
      <ellipse cx="48" cy="40" rx="15" ry="18" fill="var(--color-ink-2)" {...strk} />
      {id === 'handler' && (<>
        {/* a headset with a boom mic, and a raised hood line */}
        <path d="M31 38a17 17 0 0 1 34 0" {...line} strokeWidth="3.4" />
        <rect x="27" y="36" width="6" height="12" rx="2.5" fill="currentColor" stroke="none" /><rect x="63" y="36" width="6" height="12" rx="2.5" fill="currentColor" stroke="none" />
        <path d="M30 48c0 8 8 11 14 11" {...line} /><circle cx="46" cy="59" r="2.3" fill="currentColor" stroke="none" />
      </>)}
      {id === 'vanguard' && (<>
        {/* a peaked cap, reading glasses pushed up on the brow, a high stencilled collar and a ledger */}
        <path d="M30 28c2-10 10-14 18-14s16 4 18 14z" fill="currentColor" fillOpacity="0.3" {...strk} /><path d="M28 28h40" {...line} strokeWidth="3" />
        <path d="M37 33h8M51 33h8M45 33h6" {...line} strokeWidth="1.6" />
        <path d="M34 66l6 8 8-6 8 6 6-8" {...line} /><path d="M40 78h4M52 78h4M46 83h4" {...line} strokeWidth="1.6" />
        <rect x="58" y="78" width="22" height="16" fill="var(--color-ink)" {...strk} /><path d="M62 83h14M62 87h14" {...line} strokeWidth="1.4" />
      </>)}
      {id === 'ashen' && (<>
        {/* a welder's mask pushed up on the head, soot on the cheek, a scorched collar */}
        <path d="M30 30c0-14 9-20 18-20s18 6 18 20z" fill="var(--color-ink)" {...strk} /><rect x="35" y="21" width="26" height="9" rx="2" fill="currentColor" fillOpacity="0.55" stroke="none" />
        <path d="M39 49l4 3M44 52l3 3M54 50l-3 3" {...line} strokeWidth="1.8" />
        <path d="M32 68l8 10M64 68l-8 10M44 74l4 8 4-8" {...line} /><path d="M20 90l8-6M70 84l6 6" {...line} strokeWidth="1.6" />
      </>)}
      {id === 'vex' && (<>
        {/* a soft cap with an amber lamp pinned to it, chalk tallies on the shoulder */}
        <path d="M31 30c1-11 8-16 17-16s16 5 17 16z" fill="currentColor" fillOpacity="0.28" {...strk} /><path d="M27 30h46" {...line} strokeWidth="3" />
        <circle cx="62" cy="24" r="4.5" fill="currentColor" stroke="none" /><path d="M62 17v-3M68 19l2-2M56 19l-2-2" {...line} strokeWidth="1.5" />
        <path d="M24 82l0 8M28 82l0 8M32 82l0 8M23 86l11-3" {...line} strokeWidth="1.7" />
        <path d="M38 54c3 3 17 3 20 0" {...line} strokeWidth="1.8" />
      </>)}
      {id === 'halcyon' && (<>
        {/* neat, close-cropped, a pale collar with a thin blue edge, a tablet */}
        <path d="M33 33c0-12 7-17 15-17s15 5 15 17c-3-6-9-9-15-9s-12 3-15 9z" fill="var(--color-ink)" {...strk} />
        <path d="M34 68l14 14 14-14" {...line} /><path d="M34 68l14 14 14-14" {...line} stroke="#9fc3e0" strokeWidth="1.2" transform="translate(0 2.6)" />
        <rect x="58" y="76" width="24" height="17" rx="2" fill="var(--color-ink)" {...strk} /><circle cx="70" cy="84.5" r="2" fill="currentColor" stroke="none" />
      </>)}
    </svg>
  )
}
