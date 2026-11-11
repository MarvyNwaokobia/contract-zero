'use client'

// Faction readiness in plain language, with the exact figures one click away.
// Everything shown is computed by lib/presenter from the faction's real holdings.

import { useQuery } from '@tanstack/react-query'
import { api, type MarketMerchant, type WarActor, type MarketOrder, type WarConvoy } from '@/lib/api'
import { convoyState } from '@/lib/world/convoy'
import { describeMerchant, MERCHANT_LABEL, type MerchantState } from '@/lib/presenter/merchant'
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
  for (const c of convoys) if (c.owner === actor && convoyState(c.status).state === 'in_transit') out.push({ resource: c.resource, kind: 'convoy' })
  return out
}

/** `compact` is for crowded screens (the Hub): the badge and one headline per faction, with
 *  the detail behind a disclosure. */
export function ReadinessSummary({ a, inbound, compact = false, ammoForGuards }: { a: WarActor; inbound: Inbound[]; compact?: boolean; ammoForGuards?: number }) {
  if (a.kind !== 'faction') return null
  const p = describeFaction(a, inbound, { ammoForGuards })
  // The summary only adds something when no warning line below says the same thing.
  const showSummary = p.readiness === 'operational' || p.readiness === 'rebuilding'
  const issues = p.statements.filter((s) => s.severity !== 'ok')
  if (compact) {
    return (
      <div data-testid={`readiness-${a.id}`} className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`border px-2 py-0.5 font-display text-[11px] font-bold uppercase tracking-[0.18em] ${BADGE[p.readiness]}`}>{READINESS_LABEL[p.readiness]}</span>
          <span className="text-xs text-muted">{showSummary ? p.summary : issues.map((s) => s.headline.toLowerCase()).join(' · ')}</span>
        </div>
        <details className="text-xs text-muted">
          <summary className="cursor-pointer text-steel hover:text-fog">What it means</summary>
          <ul className="mt-1 grid gap-1">
            {issues.map((s) => <li key={s.topic}><span className="font-display font-bold tracking-wider text-fog">{s.headline}</span> · {s.effect}</li>)}
            {inbound.length > 0 && <li className="text-steel">Resupply under way: {[...new Set(inbound.map((i) => `${i.resource} (${i.kind})`))].join(', ')}</li>}
          </ul>
          <dl className="mt-2 grid gap-x-4 gap-y-0.5">
            {p.statements.flatMap((s) => s.factors.map((f) => (
              <div key={`${s.topic}-${f.label}`} className="flex justify-between gap-2 border-b border-line/50 py-0.5"><dt>{f.label}</dt><dd className="cz-num text-fog">{f.value}</dd></div>
            )))}
          </dl>
        </details>
      </div>
    )
  }
  return (
    <div data-testid={`readiness-${a.id}`} className="grid gap-2">
      <div className="flex items-center gap-2">
        <span className={`border px-2 py-0.5 font-display text-[11px] font-bold uppercase tracking-[0.18em] ${BADGE[p.readiness]}`}>{READINESS_LABEL[p.readiness]}</span>
        {showSummary && <span className="text-xs text-muted">{p.summary}</span>}
      </div>
      <ul className="grid gap-1">
        {issues.map((s) => (
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

/** Faction state for screens outside the War Room: the same sources it uses (the
 *  War Room view for stock, disruption and convoys; the market for open orders), so
 *  every screen shows the same readiness. */
export function useReadinessData(enabled = true) {
  const war = useQuery({ queryKey: ['warroom', 1], queryFn: () => api.warRoom(1), refetchInterval: 15_000, enabled })
  const market = useQuery({ queryKey: ['market'], queryFn: api.market, refetchInterval: 15_000, enabled })
  const actors = war.data?.world.actors ?? []
  const convoys = war.data?.world.convoys ?? []
  const orders = market.data?.orders
  return {
    ready: !!war.data,
    actor: (id: string) => actors.find((a) => a.id === id),
    inbound: (id: string) => inboundFor(id, orders, convoys),
  }
}

const MERCHANT_BADGE: Record<MerchantState, string> = {
  trading: 'border-friendly/60 bg-friendly/10 text-friendly',
  stretched: 'border-amber/60 bg-amber/10 text-amber-hi',
  constrained: 'border-hostile/70 bg-hostile/10 text-hostile',
  insolvent: 'border-hostile/70 bg-hostile/10 text-hostile',
}

/** A merchant's trading position: what it can still supply or buy, and why. */
export function MerchantSummary({ m }: { m: MarketMerchant }) {
  const p = describeMerchant(m)
  return (
    <div data-testid={`merchant-state-${m.id}`} className="grid gap-2">
      <div className="flex items-center gap-2">
        <span className={`border px-2 py-0.5 font-display text-[11px] font-bold uppercase tracking-[0.18em] ${MERCHANT_BADGE[p.state]}`}>{MERCHANT_LABEL[p.state]}</span>
        {p.state === 'trading' && <span className="text-xs text-muted">{p.summary}</span>}
      </div>
      {p.statements.length > 0 && (
        <ul className="grid gap-1">
          {p.statements.map((s) => (
            <li key={`${s.topic}-${s.headline}`} className="flex items-start gap-2 text-xs">
              <span className={`mt-1 h-2 w-2 shrink-0 ${DOT[s.severity]}`} aria-label={SEV_WORD[s.severity]} />
              <span><span className="font-display font-bold tracking-wider text-fog">{s.headline}</span> <span className="text-muted">· {s.effect}</span></span>
            </li>
          ))}
        </ul>
      )}
      <details className="text-xs text-muted">
        <summary className="cursor-pointer text-steel hover:text-fog">Exact figures</summary>
        <dl className="mt-1 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
          {(['ammo', 'med', 'fuel'] as const).map((r) => (
            <div key={r} className="flex justify-between gap-2 border-b border-line/50 py-0.5"><dt>{r} shelf</dt><dd className="cz-num text-fog">{m.shelves[r].stock}/{m.shelves[r].target}</dd></div>
          ))}
          <div className="flex justify-between gap-2 border-b border-line/50 py-0.5"><dt>Credits / reserve</dt><dd className="cz-num text-fog">{m.credits.toLocaleString()} / {m.credit_reserve.toLocaleString()}</dd></div>
        </dl>
      </details>
    </div>
  )
}
