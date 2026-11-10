'use client'

// The War Room's record of completed operations. Each row opens to the same five-part
// story as the Extraction Results screen, read from the snapshots the server recorded
// when the operation started and settled. Nothing is reconstructed for older sessions:
// operations without a record are simply not listed.

import { useQuery } from '@tanstack/react-query'
import { api, accountLabel, RESOURCE_LABEL, type OperationRecord } from '@/lib/api'
import { describeConsequence, worldClock } from '@/lib/presenter/consequence'

const KIND: Record<OperationRecord['kind'], string> = { raid: 'Raid', sabotage: 'Sabotage', recovery: 'Recovery' }
const OUTCOME: Record<OperationRecord['outcome'], { label: string; cls: string }> = {
  extracted: { label: 'Extracted', cls: 'text-friendly' },
  killed: { label: 'Killed in action', cls: 'text-hostile' },
  rejected: { label: 'Rejected', cls: 'text-dim' },
}

function Settlement({ s }: { s: NonNullable<OperationRecord['settlement']> }) {
  // Only a confirmed row is settlement; anything else is shown with its real status.
  return (
    <p className="mt-2 text-xs text-muted">
      NEAR payout: <span className={s.settled_on_chain ? 'text-friendly' : s.status === 'failed' || s.status === 'compensated' ? 'text-hostile' : 'text-amber-hi'}>{s.settled_on_chain ? 'settled' : s.status}</span>
      {s.tx_hashes.map((h, i) => <a key={h} href={s.explorer[i]} target="_blank" rel="noreferrer" className="ml-2 text-steel underline">{h.slice(0, 8)}…</a>)}
      {s.error && <span className="ml-2 text-hostile">{s.error}</span>}
    </p>
  )
}

function Row({ o }: { o: OperationRecord }) {
  const c = o.consequence
  const story = describeConsequence(o, c, { recorded: true, settled: !!c.after, decisions: o.decisions })
  const out = OUTCOME[o.outcome] ?? OUTCOME.rejected
  return (
    <details className="border border-line bg-ink-2/60 p-3 open:bg-ink-2" data-testid="operation-row">
      <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-display text-sm font-bold uppercase tracking-wider text-fog">{KIND[o.kind]} · {c.before.name}</span>
        <span className="text-sm text-muted">{RESOURCE_LABEL[o.resource]}{o.outcome === 'extracted' ? `, ${o.extracted_units} units` : ''}</span>
        <span className="text-sm text-muted">by {accountLabel(o.player)}</span>
        <span className={`ml-auto text-[11px] font-bold uppercase tracking-wider ${out.cls}`}>{out.label}</span>
        {c.settled_tick != null && <span className="text-[11px] text-dim">{worldClock(c.settled_tick)}</span>}
      </summary>
      <ol className="mt-3 grid gap-2">
        {story.steps.map((s, i) => (
          <li key={s.key} className="grid grid-cols-[1.5rem_1fr] gap-2">
            <span className={`mt-0.5 text-center font-mono text-xs ${s.state === 'done' ? 'text-friendly' : s.state === 'pending' ? 'text-amber-hi' : 'text-dim'}`} aria-hidden>{s.state === 'done' ? '●' : s.state === 'pending' ? '○' : '–'}</span>
            <div>
              <div className="font-display text-[11px] font-bold uppercase tracking-[0.2em] text-steel">{i + 1}. {s.title}</div>
              <ul className="grid gap-0.5 text-sm text-fog">{s.lines.map((l, j) => <li key={j} className={s.state === 'pending' ? 'text-muted' : ''}>{l}</li>)}</ul>
            </div>
          </li>
        ))}
      </ol>
      {o.settlement && <Settlement s={o.settlement} />}
      <details className="mt-2 text-xs text-muted">
        <summary className="cursor-pointer text-steel hover:text-fog">Advanced evidence (recorded snapshots)</summary>
        <pre className="mt-1 max-h-64 overflow-auto bg-ink p-2 font-mono text-[11px] text-fog">{JSON.stringify({ before: c.before, faced: c.faced, after: c.after, next: c.next, settled_tick: c.settled_tick, decisions: o.decisions }, null, 2)}</pre>
      </details>
    </details>
  )
}

export function Operations() {
  const q = useQuery({ queryKey: ['war-operations'], queryFn: () => api.warOperations(10), refetchInterval: 15_000 })
  const ops = q.data ?? []
  return (
    <section className="mt-6" data-testid="operations-record">
      <div className="mb-2 flex flex-wrap items-baseline gap-3">
        <h2 className="cz-label">Operations and what they changed</h2>
        <span className="text-xs text-dim">recorded before and after, from the server</span>
      </div>
      <div className="grid gap-2">
        {q.isError && <p className="text-sm text-muted">The operations record is unavailable right now.</p>}
        {!q.isError && ops.length === 0 && <p className="text-sm text-muted">No operation has been recorded yet. Complete a contract and it appears here.</p>}
        {ops.map((o, i) => <Row key={`${o.completed_at}-${i}`} o={o} />)}
      </div>
    </section>
  )
}
