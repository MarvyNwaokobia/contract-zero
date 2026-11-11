// A supply gauge drawn as a fixed row of glyphs (crates, cases, tanks), filled in
// proportion to stock over target. Never one object per unit, so 5 and 5,000 draw alike.

import type { ResourceName } from '@/lib/api'
import { supplySlots } from '@/lib/world/table'

const COLOR: Record<ResourceName, string> = { ammo: 'var(--color-amber)', med: 'var(--color-friendly)', fuel: 'var(--color-steel)' }
const LABEL: Record<ResourceName, string> = { ammo: 'Ammunition', med: 'Medicine', fuel: 'Fuel' }

function Glyph({ r, on }: { r: ResourceName; on: boolean }) {
  const fill = on ? COLOR[r] : 'transparent'
  const stroke = on ? COLOR[r] : 'var(--color-line-strong)'
  if (r === 'fuel') return <svg viewBox="0 0 14 18" className="h-[18px] w-[14px]" aria-hidden><rect x="1.5" y="3" width="11" height="13" rx="3" fill={fill} stroke={stroke} strokeWidth="1.3" fillOpacity="0.85" /><rect x="5" y="0.5" width="4" height="2.5" fill={stroke} /></svg>
  if (r === 'med') return <svg viewBox="0 0 16 14" className="h-[14px] w-4" aria-hidden><rect x="1" y="2" width="14" height="10" fill={fill} stroke={stroke} strokeWidth="1.3" fillOpacity="0.85" /><path d="M8 4.5v5M5.5 7h5" stroke={on ? 'var(--color-ink)' : stroke} strokeWidth="1.4" /></svg>
  return <svg viewBox="0 0 16 14" className="h-[14px] w-4" aria-hidden><rect x="1" y="2" width="14" height="10" fill={fill} stroke={stroke} strokeWidth="1.3" fillOpacity="0.85" /><path d="M1 6h14" stroke={on ? 'var(--color-ink)' : stroke} strokeWidth="1" /></svg>
}

export function SupplyGauge({ resource, stock, target, compact = false }: { resource: ResourceName; stock: number; target: number; compact?: boolean }) {
  const s = supplySlots(stock, target)
  const short = target > 0 && stock < target
  return (
    <div className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-2 text-xs" data-testid={`gauge-${resource}`}>
      <span className="text-muted">{LABEL[resource]}</span>
      <span className="flex items-center gap-0.5" role="img" aria-label={`${LABEL[resource]}: ${stock} held, target ${target}`}>
        {Array.from({ length: s.slots }, (_, i) => <Glyph key={i} r={resource} on={i < s.filled} />)}
        {s.overflow && <span className="ml-1 text-[10px] text-dim">+</span>}
      </span>
      {!compact && <span className={`cz-num text-right ${short ? 'text-hostile' : 'text-fog'}`}>{stock.toLocaleString()}<span className="text-dim">/{target.toLocaleString()}</span></span>}
    </div>
  )
}
