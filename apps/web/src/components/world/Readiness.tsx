'use client'

// Faction readiness in plain language, with the exact figures one click away.
// Everything shown is computed by lib/presenter from the faction's real holdings.

import type { WarActor, MarketOrder, WarConvoy } from '@/lib/api'
import { describeFaction, READINESS_LABEL, type Inbound, type Readiness, type Severity } from '@/lib/presenter/economy'

const BADGE: Record<Readiness, string> = {
  operational: 'border-friendly/60 bg-friendly/10 text-friendly',
  under_pressure: 'border-amber/60 bg-amber/10 text-amber-hi',
  supply_critical: 'border-hostile/70 bg-hostile/10 text-hostile',
  rebuilding: 'border-steel/60 bg-steel/10 text-steel',
}
const DOT: Record<Severity, string> = { ok: 'bg-friendly', warn: 'bg-amber', critical: 'bg-hostile' }
const SEV_WORD: Record<Severity, string> = { ok: 'OK', warn: 'Warning', critical: 'Critical' }

/** Resupply a faction really has under way: an open buy order, or a convoy on the road. */
export function inboundFor(actor: string, orders: MarketOrder[] | undefined, convoys: WarConvoy[]): Inbound[] {
  const out: Inbound[] = []
  for (const o of orders ?? []) if (o.requester === actor && o.side === 'buy' && o.status.status === 'open') out.push({ resource: o.resource, kind: 'order' })
  for (const c of convoys) if (c.owner === actor && c.status.state === 'in_transit') out.push({ resource: c.resource, kind: 'convoy' })
  return out
}

export function ReadinessSummary({ a, inbound }: { a: WarActor; inbound: Inbound[] }) {
  if (a.kind !== 'faction') return null
  const p = describeFaction(a, inbound)
  return (
    <div data-testid={`readiness-${a.id}`} className="grid gap-2">
      <div className="flex items-center gap-2">
        <span className={`border px-2 py-0.5 font-display text-[11px] font-bold uppercase tracking-[0.18em] ${BADGE[p.readiness]}`}>{READINESS_LABEL[p.readiness]}</span>
        <span className="text-xs text-muted">{p.summary}</span>
      </div>
      <ul className="grid gap-1">
        {p.statements.filter((s) => s.severity !== 'ok').map((s) => (
          <li key={s.topic} className="flex items-start gap-2 text-xs">
            <span className={`mt-1 h-2 w-2 shrink-0 ${DOT[s.severity]}`} aria-label={SEV_WORD[s.severity]} />
            <span><span className="font-display font-bold tracking-wider text-fog">{s.headline}</span> <span className="text-muted">· {s.effect}</span></span>
          </li>
        ))}
        {inbound.length > 0 && <li className="text-xs text-steel">Resupply under way: {[...new Set(inbound.map((i) => `${i.resource} (${i.kind})`))].join(', ')}</li>}
      </ul>
      <details className="text-xs text-muted">
        <summary className="cursor-pointer text-steel hover:text-fog">Exact figures</summary>
        <dl className="mt-1 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
          {p.statements.flatMap((s) => s.factors.map((f) => (
            <div key={`${s.topic}-${f.label}`} className="flex justify-between gap-2 border-b border-line/50 py-0.5"><dt>{f.label}</dt><dd className="cz-num text-fog">{f.value}</dd></div>
          )))}
        </dl>
      </details>
    </div>
  )
}
