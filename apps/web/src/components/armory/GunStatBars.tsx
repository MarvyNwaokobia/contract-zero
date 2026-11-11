'use client'

import { GUN_CATALOG, type GunId } from '@/engine/combat/GunStats'
import { statRows } from '@/lib/armory'

/** Stat bars for one weapon, each against the best gun in the catalog. The numbers are always printed beside the bars. */
export function GunStatBars({ gun, compact = false }: { gun: GunId; compact?: boolean }) {
  const g = GUN_CATALOG[gun]
  if (!g) return null
  const rows = compact ? statRows(g).filter((r) => ['dps', 'damage', 'mag'].includes(r.key)) : statRows(g)
  return (
    <dl className="grid gap-1.5" data-testid={`stats-${gun}`}>
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[8.5rem_1fr_4.5rem] items-center gap-2 text-xs" title={r.note}>
          <dt className="text-muted">{r.label}</dt>
          <dd className="m-0 h-1.5 bg-line" role="meter" aria-label={r.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(r.ratio * 100)}><div className="h-full bg-amber" style={{ width: `${Math.max(4, r.ratio * 100)}%` }} /></dd>
          <dd className="cz-num m-0 text-right text-fog">{r.value}</dd>
        </div>
      ))}
    </dl>
  )
}
