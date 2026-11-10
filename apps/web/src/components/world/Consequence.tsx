'use client'

// The five-part story of what an operation did to the world, from the server's recorded
// snapshots, with the raw records one click away. The commander's reaction fills in by
// itself when its next turn is logged; until then it says it is waiting.

import { useQuery } from '@tanstack/react-query'
import { api, type MissionResult } from '@/lib/api'
import { describeConsequence, type StepState } from '@/lib/presenter/consequence'

const MARK: Record<StepState, { glyph: string; cls: string; label: string }> = {
  done: { glyph: '●', cls: 'text-friendly', label: 'recorded' },
  pending: { glyph: '○', cls: 'text-amber-hi', label: 'waiting' },
  none: { glyph: '–', cls: 'text-dim', label: 'not recorded' },
}

export function ConsequencePanel({ session, result }: { session: string; result: MissionResult }) {
  const c = result.consequence ?? null
  const settled = !!c?.after
  // Poll the target's decisions until it has acted; stop once it has (or there is no record).
  const after = useQuery({
    queryKey: ['aftermath', session],
    queryFn: () => api.aftermath(session),
    enabled: settled,
    refetchInterval: (q) => ((q.state.data?.decisions.length ?? 0) > 0 ? false : 10_000),
  })
  const story = describeConsequence(result, c, after.data)
  return (
    <section className="cz-panel mt-4 p-4" data-testid="consequence">
      <h2 className="cz-label mb-3">What this did to the world</h2>
      <ol className="grid gap-3">
        {story.steps.map((s, i) => (
          <li key={s.key} className="grid grid-cols-[1.75rem_1fr] gap-2" data-testid={`consequence-${s.key}`}>
            <span className={`mt-0.5 text-center font-mono text-sm ${MARK[s.state].cls}`} role="img" aria-label={MARK[s.state].label}>{MARK[s.state].glyph}</span>
            <div>
              <div className="font-display text-[11px] font-bold uppercase tracking-[0.2em] text-steel">{i + 1}. {s.title}</div>
              <ul className="mt-0.5 grid gap-0.5 text-sm text-fog">
                {s.lines.map((l, j) => <li key={j} className={s.state === 'pending' ? 'text-muted' : ''}>{l}</li>)}
              </ul>
            </div>
          </li>
        ))}
      </ol>
      {c && (
        <details className="mt-3 text-xs text-muted">
          <summary className="cursor-pointer text-steel hover:text-fog">Advanced evidence (recorded snapshots)</summary>
          <pre className="mt-2 max-h-72 overflow-auto bg-ink-2 p-2 font-mono text-[11px] text-fog">{JSON.stringify({ before: c.before, faced: c.faced, after: c.after, next: c.next, settled_tick: c.settled_tick, decisions: after.data?.decisions }, null, 2)}</pre>
        </details>
      )}
    </section>
  )
}
