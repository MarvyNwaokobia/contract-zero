'use client'

// The War Room's procurement record: per supply order, the causal chain from the raid
// that caused a shortage to the mission that now looks different, with every merchant's
// answer, the commander's choice and the on-chain settlement. All read from records.

import { useQuery } from '@tanstack/react-query'
import { api, type ProcurementChain } from '@/lib/api'

const RES: Record<string, string> = { ammo: 'ammunition', med: 'medical supplies', fuel: 'fuel' }

function Step({ n, label, done = true, children }: { n: number; label: string; done?: boolean; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[1.5rem_1fr] gap-2">
      <span className={`mt-0.5 grid h-5 w-5 place-items-center font-mono text-[10px] font-bold ${done ? 'bg-amber/20 text-amber-hi' : 'bg-line text-dim'}`}>{n}</span>
      <div className="min-w-0">
        <div className="font-display text-[11px] font-bold uppercase tracking-[0.2em] text-steel">{label}</div>
        <div className="text-sm text-fog">{children}</div>
      </div>
    </li>
  )
}

function Chain({ c }: { c: ProcurementChain }) {
  const buy = c.side === 'buy'
  const proposed = c.answers.filter((a) => a.proposed)
  const declined = c.answers.filter((a) => !a.proposed)
  const choice = c.choices.find((x) => x.validation === 'accepted')
  const onChain = c.settlement.filter((s) => s.settled_on_chain)
  const status = c.status.status
  let n = 0
  return (
    <details className="border border-line bg-ink-2/60 p-3 open:bg-ink-2" open={false} data-testid={`proc-${c.order}`}>
      <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-display text-sm font-bold uppercase tracking-wider text-fog">{c.requester_name}</span>
        <span className="text-sm text-muted">{buy ? 'needs' : 'sells'} {c.qty} {RES[c.resource]}</span>
        {c.fills.length > 0 && <span className="text-sm text-fog">→ {c.fills.map((f) => f.merchant_name).join(' + ')}</span>}
        <span className={`ml-auto text-[11px] font-bold uppercase tracking-wider ${status === 'filled' ? 'text-friendly' : status === 'open' ? 'text-amber-hi' : 'text-dim'}`}>{status}</span>
      </summary>
      <ol className="mt-3 grid gap-2">
        {c.raid && <Step n={++n} label="Player operation">{c.raid.player} ran a {c.raid.kind} on {c.requester_name}&apos;s {RES[c.raid.resource] ?? c.raid.resource} ({c.raid.outcome}{c.raid.units ? `, ${c.raid.units} units taken` : ''}).</Step>}
        {c.shortage && <Step n={++n} label={buy ? 'Shortage' : 'Surplus'}>{c.shortage.trigger}: {c.shortage.context.filter(([k]) => ['have', 'target', 'urgency', 'budget'].includes(k)).map(([k, v]) => `${k} ${v}`).join(' · ')}</Step>}
        <Step n={++n} label="Supply order">{c.shortage?.rationale ?? `${buy ? 'Buy' : 'Sell'} ${c.qty} ${RES[c.resource]}, limit ${c.limit_total} cr.`}</Step>
        <Step n={++n} label="Merchant proposals" done={c.answers.length > 0}>
          {c.answers.length === 0 ? 'No answers recorded.' : (
            <ul className="grid gap-0.5">
              {proposed.map((a, i) => <li key={`p${i}`}><span className="text-steel">{a.merchant_name}:</span> {a.rationale}</li>)}
              {declined.map((a, i) => <li key={`d${i}`} className="text-muted"><span className="text-dim">{a.merchant_name} declined:</span> {a.rationale}</li>)}
            </ul>
          )}
        </Step>
        <Step n={++n} label="Winning quote" done={!!choice}>{choice ? choice.rationale : c.choices[0]?.rationale ?? (status === 'expired' ? 'No acceptable offer before the deadline; the escrow went back.' : 'Not chosen yet.')}</Step>
        <Step n={++n} label="Settlement on NEAR" done={onChain.length > 0}>
          <ul className="grid gap-0.5 font-mono text-xs">
            {c.settlement.map((s) => (
              <li key={s.op_id}>{s.op_id} · <span className={s.settled_on_chain ? 'text-friendly' : 'text-amber-hi'}>{s.settled_on_chain ? 'settled' : s.status}</span>{s.tx_hashes.map((h, i) => <a key={h} href={s.explorer[i]} target="_blank" rel="noreferrer" className="ml-2 text-steel underline">{h.slice(0, 8)}…</a>)}</li>
            ))}
            {c.settlement.length === 0 && <li className="text-dim">Not queued (settlement off or pending).</li>}
          </ul>
          <div className="mt-1 text-[11px] text-dim">{c.execution_path.label}. Not an official NEAR Intents transaction.</div>
        </Step>
        <Step n={++n} label="Supplies updated" done={c.delivered > 0}>{c.delivered > 0 ? `${c.delivered} ${RES[c.resource]} ${buy ? 'delivered' : 'sold'} for ${c.paid} cr${c.next_mission ? `; ${c.requester_name} now holds ${c.next_mission.stock_now}` : ''}.` : 'Nothing delivered.'}</Step>
        {c.next_mission && <Step n={++n} label="Mission consequence">The next raid on {c.requester_name}&apos;s {c.next_mission.depot} depot faces {c.next_mission.guards} guards ({c.next_mission.rifles} rifles, {c.next_mission.sidearms} sidearms) at defense L{c.next_mission.defense}.</Step>}
      </ol>
    </details>
  )
}

export function Procurement() {
  const q = useQuery({ queryKey: ['procurement'], queryFn: () => api.procurement(10), refetchInterval: 10_000 })
  const chains = q.data ?? []
  return (
    <section className="mt-6" data-testid="procurement">
      <div className="mb-2 flex flex-wrap items-baseline gap-3">
        <h2 className="cz-label">Supply orders and competition</h2>
        <span className="text-xs text-dim">raid → shortage → order → proposals → winner → settlement → supplies → next mission</span>
      </div>
      <div className="grid gap-2">{chains.length ? chains.map((c) => <Chain key={c.order} c={c} />) : <p className="text-sm text-muted">No supply orders yet.</p>}</div>
    </section>
  )
}
