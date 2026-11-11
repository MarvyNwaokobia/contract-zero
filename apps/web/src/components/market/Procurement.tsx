'use client'

// The War Room's supply-order record as a seven-stage timeline:
//   shortage → order → bids → winner → settlement → supply arrives → readiness
// Each stage has its own mark, a one-line plain-language account, and the evidence behind
// it on demand. All of it is read from what the server recorded (lib/presenter/procurement
// holds the rules: a lone offer is not competition, a pending settlement is not settled).

import { useQuery } from '@tanstack/react-query'
import { api, type MarketOrder, type ProcurementChain } from '@/lib/api'
import { describeProcurement, type StageKey, type StageState, type TimelineStage } from '@/lib/presenter/procurement'
import { worldClock } from '@/lib/presenter/consequence'

/** One accent per stage so each reads as its own beat, not a row in a list. */
const ACCENT: Record<StageKey, string> = {
  shortage: 'var(--color-amber)', order: 'var(--color-steel)', bids: 'var(--color-fog)', winner: 'var(--color-friendly)',
  settlement: 'var(--color-steel)', arrival: 'var(--color-amber)', readiness: 'var(--color-friendly)',
}
const STATE_WORD: Record<StageState, string> = { done: 'recorded', pending: 'waiting', failed: 'failed', skipped: 'did not happen', none: 'not recorded' }

function Icon({ k }: { k: StageKey }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'square' as const, strokeLinejoin: 'round' as const }
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden {...p}>
      {k === 'shortage' && <><path d="M12 3l10 18H2z" /><path d="M12 10v5M12 18v.5" /></>}
      {k === 'order' && <><path d="M6 3h9l4 4v14H6z" /><path d="M9 11h7M9 15h7" /></>}
      {k === 'bids' && <><path d="M4 9h13l-3-3M20 15H7l3 3" /></>}
      {k === 'winner' && <><circle cx="12" cy="12" r="9" /><path d="M7.5 12.5l3 3 6-7" /></>}
      {k === 'settlement' && <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>}
      {k === 'arrival' && <><path d="M3 8l9-5 9 5v8l-9 5-9-5z" /><path d="M3 8l9 5 9-5M12 13v8" /></>}
      {k === 'readiness' && <><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M9 12l2.2 2.2L15.5 10" /></>}
    </svg>
  )
}

function Mark({ s }: { s: TimelineStage }) {
  const c = s.state === 'failed' ? 'var(--color-hostile)' : s.state === 'done' ? ACCENT[s.key] : 'var(--color-dim)'
  const solid = s.state === 'done' || s.state === 'failed'
  return (
    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border-2" style={{ color: c, borderColor: c, background: solid ? 'color-mix(in srgb, currentColor 14%, transparent)' : 'transparent', borderStyle: s.state === 'skipped' || s.state === 'none' ? 'dashed' : 'solid' }}>
      <Icon k={s.key} />
    </span>
  )
}

function Stage({ s, last }: { s: TimelineStage; last: boolean }) {
  return (
    <li className="relative grid grid-cols-[1.75rem_1fr] gap-3 pb-4" data-testid={`stage-${s.key}`} data-state={s.state}>
      {!last && <span className="absolute left-[0.8rem] top-7 h-[calc(100%-1.75rem)] w-px bg-line-strong" aria-hidden />}
      <Mark s={s} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-display text-[12px] font-bold uppercase tracking-[0.18em]" style={{ color: s.state === 'done' ? ACCENT[s.key] : undefined }}>{s.title}</span>
          <span className={`text-[10px] uppercase tracking-widest ${s.state === 'failed' ? 'text-hostile' : s.state === 'pending' ? 'text-amber-hi' : 'text-dim'}`}>{STATE_WORD[s.state]}</span>
          {s.tick != null && <span className="text-[11px] text-dim">{worldClock(s.tick)}</span>}
        </div>
        <p className={`text-sm ${s.state === 'done' || s.state === 'failed' ? 'text-fog' : 'text-muted'}`}>{s.summary}</p>
        {s.evidence.length > 0 && (
          <details className="mt-0.5 text-xs text-muted">
            <summary className="cursor-pointer text-steel hover:text-fog">Evidence</summary>
            <dl className="mt-1 grid gap-0.5">
              {s.evidence.map((e, i) => <div key={i} className="grid grid-cols-[minmax(0,10rem)_1fr] gap-2 border-b border-line/50 py-0.5"><dt className="truncate">{e.label}</dt><dd className="break-words text-fog">{e.value}</dd></div>)}
            </dl>
          </details>
        )}
      </div>
    </li>
  )
}

function Chain({ c, order }: { c: ProcurementChain; order: MarketOrder | undefined }) {
  const t = describeProcurement(c, order?.proposals)
  const tone = c.status.status === 'filled' ? 'text-friendly' : c.status.status === 'open' ? 'text-amber-hi' : 'text-dim'
  return (
    <details className="border border-line bg-ink-2/60 p-3 open:bg-ink-2" data-testid={`proc-${c.order}`}>
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-display text-sm font-bold uppercase tracking-wider text-fog">{t.headline}</span>
        {c.fills.length > 0 && <span className="text-sm text-muted">→ {c.fills.map((f) => f.merchant_name).join(' + ')}</span>}
        {/* the whole story at a glance: one pip per stage */}
        <span className="flex items-center gap-1" role="img" aria-label={t.stages.map((s) => `${s.title}: ${STATE_WORD[s.state]}`).join('; ')}>
          {t.stages.map((s) => <span key={s.key} title={`${s.title}: ${STATE_WORD[s.state]}`} className="h-2 w-4" style={{ background: s.state === 'done' ? ACCENT[s.key] : s.state === 'failed' ? 'var(--color-hostile)' : 'transparent', border: `1px ${s.state === 'skipped' || s.state === 'none' ? 'dashed' : 'solid'} ${s.state === 'done' ? ACCENT[s.key] : s.state === 'failed' ? 'var(--color-hostile)' : 'var(--color-dim)'}` }} />)}
        </span>
        <span className={`ml-auto text-[11px] font-bold uppercase tracking-wider ${tone}`}>{t.status}</span>
      </summary>
      <ol className="mt-4 grid">{t.stages.map((s, i) => <Stage key={s.key} s={s} last={i === t.stages.length - 1} />)}</ol>
      <p className="text-[11px] text-dim">
        {c.settlement.length > 0 ? `${c.execution_path.label}.` : 'CONTRACT ZERO supply order, executed in the game economy. No on-chain settlement is recorded for it.'} Not an official NEAR Intents transaction.
      </p>
      <details className="mt-2 text-xs text-muted">
        <summary className="cursor-pointer text-steel hover:text-fog">Advanced evidence (the raw recorded chain)</summary>
        <pre className="mt-1 max-h-72 overflow-auto bg-ink p-2 font-mono text-[11px] text-fog">{JSON.stringify(c, null, 2)}</pre>
      </details>
    </details>
  )
}

export function Procurement() {
  const q = useQuery({ queryKey: ['procurement'], queryFn: () => api.procurement(10), refetchInterval: 10_000 })
  // The structured offers (quantity and price) live on the market's orders; join them by order id.
  const market = useQuery({ queryKey: ['market'], queryFn: api.market, refetchInterval: 15_000 })
  const chains = q.data ?? []
  return (
    <section className="mt-6" data-testid="procurement">
      <div className="mb-2 flex flex-wrap items-baseline gap-3">
        <h2 className="cz-label">Supply orders: from shortage to readiness</h2>
        <span className="text-xs text-dim">shortage → order → bids → winner → settlement → arrival → readiness</span>
      </div>
      <div className="grid gap-2">{chains.length ? chains.map((c) => <Chain key={c.order} c={c} order={market.data?.orders.find((o) => o.id === c.order)} />) : <p className="text-sm text-muted">No supply orders yet.</p>}</div>
    </section>
  )
}
