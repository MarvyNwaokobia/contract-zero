'use client'

// Extraction Results: the outcome first, what you earned, what it did to the world (the
// server's recorded before and after), the cast's debrief, and where to go next. Settlement
// is shown as settled only once the chain says so.

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { Panel, Shell, Stat } from '@/components/ui/Shell'
import { Debrief } from '@/components/story/Briefing'
import { ConsequenceTip } from '@/components/help/ConsequenceTip'
import { ConsequencePanel } from '@/components/world/Consequence'
import { api, RESOURCE_LABEL, type BoardEntry, type MissionResult, type WorldView } from '@/lib/api'

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

function guardsLine(e?: BoardEntry) {
  if (!e) return 'no depot (not worth raiding, or no fuel to stage it)'
  const g = e.guards
  return `${plural(g.hall.rifles + g.yard.rifles, 'rifle')}, ${plural(g.hall.sidearms + g.yard.sidearms, 'sidearm')}, ${g.reinforce_per_drop} reinforcements per wave, defense L${e.defense}`
}

/** Shows on-chain settlement only once it is confirmed (verified FINAL on NEAR). */
export function SettlementStatus({ opId }: { opId: string }) {
  const q = useQuery({
    queryKey: ['settlement', opId],
    queryFn: () => api.settlement(opId),
    refetchInterval: (query) => (query.state.data && ['confirmed', 'failed', 'compensated'].includes(query.state.data.status) ? false : 3000),
  })
  const s = q.data
  if (!s || !s.settled_on_chain) {
    if (s && (s.status === 'failed' || s.status === 'compensated')) {
      return <p className="text-sm text-hostile">On-chain settlement failed: {s.error}</p>
    }
    return <p className="text-sm text-muted">Settling on NEAR… ({s?.status ?? 'queued'}). Not settled until confirmed.</p>
  }
  return (
    <p className="text-sm text-friendly">
      Settled on NEAR testnet:{' '}
      {s.explorer.map((url, i) => (
        <a key={url} href={url} target="_blank" rel="noreferrer" className="underline">{s.tx_hashes[i].slice(0, 10)}…</a>
      ))}
    </p>
  )
}

export function headline(r: MissionResult): string {
  if (r.outcome === 'extracted') return r.kind === 'sabotage' ? 'LINE DESTROYED' : r.kind === 'recovery' ? 'CARGO HANDED OVER' : 'CARGO EXTRACTED'
  return r.outcome === 'killed' ? 'KILLED IN ACTION · NOTHING SECURED' : 'RUN REJECTED'
}

export function MissionResults({ result, before, after, session }: { result: MissionResult; before: WorldView; after: WorldView; session: string }) {
  const vgBefore = before.actors.find((a) => a.id === result.target)
  const vgAfter = after.actors.find((a) => a.id === result.target)
  const nextBefore = before.board.find((b) => b.target === result.target && b.resource === result.resource)
  const nextAfter = after.board.find((b) => b.target === result.target && b.resource === result.resource)
  const won = result.outcome === 'extracted'
  const brought = won && result.kind !== 'sabotage' && result.kind !== 'recovery' && result.player_holdings.cargo > 0
  const tone = won ? 'var(--color-friendly)' : 'var(--color-hostile)'
  return (
    <Shell title="Extraction Results" back={{ href: '/contracts', label: 'Contract Board' }}>
      <section className="cz-panel p-5" style={{ borderLeft: `4px solid ${tone}` }} data-testid="results-hero" data-outcome={result.outcome}>
        <div className="cz-label !text-[10px]">{[result.codename, result.site?.name].filter(Boolean).join(' · ') || 'Operation report'}</div>
        <h2 className="mt-1 font-display text-3xl font-bold uppercase tracking-wide sm:text-4xl" style={{ color: tone }} data-testid="results-headline">{headline(result)}</h2>
        {result.reason && <p className="mt-1 text-sm text-amber-hi">The server rejected the run: {result.reason}.</p>}
        {result.settlement && <div className="mt-2"><SettlementStatus opId={result.settlement.op_id} /></div>}
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label={result.kind === 'sabotage' ? 'Destroyed' : result.kind === 'recovery' ? 'Returned' : 'Extracted'} value={`${result.extracted_units} ${result.resource}`}
            hint={result.kind === 'raid' && result.record ? `${result.record.secured.length} case${result.record.secured.length === 1 ? '' : 's'} carried out of ${result.manifest ?? '?'} units on site` : result.kind === 'sabotage' && result.record ? `${result.record.charges.length} charges set` : undefined} />
          <Stat label="Bounty" value={`${result.bounty} cr`} />
          <Stat label="Mission time" value={`${Math.round(result.elapsed_secs)} s`} hint={`minimum ${result.min_secs} s`} />
          <Stat label="You now hold" value={`${result.player_holdings.cargo} ${result.resource}`} hint={`${result.player_holdings.credits} credits`} />
        </div>
      </section>

      {won && <div className="mt-4"><ConsequenceTip target={vgAfter?.name ?? result.target} /></div>}

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div>
          <ConsequencePanel session={session} result={result} />
          {/* Sessions from before recording have no snapshot: fall back to this browser's two
              reads of the world, labelled as such. */}
          {!result.consequence && (
            <div className="mt-4 grid gap-4">
              <Panel title={`FROM THIS BROWSER: ${(vgAfter?.name ?? result.target).toUpperCase()} BEFORE AND AFTER`}>
                {vgBefore && vgAfter && (
                  <div className="grid grid-cols-3 gap-3">
                    {(['ammo', 'med', 'fuel'] as const).map((r) => <Stat key={r} label={RESOURCE_LABEL[r]} value={`${vgBefore.holdings[r]} → ${vgAfter.holdings[r]}`} />)}
                  </div>
                )}
              </Panel>
              <Panel title="THE NEXT RAID ON THIS DEPOT">
                <p className="text-sm text-muted">Before: {guardsLine(nextBefore)}</p>
                <p className="mt-1 text-sm text-fog">Now: {guardsLine(nextAfter)}</p>
                <p className="mt-2 text-xs text-dim">The commander reacts on the next world tick; check the board again in a minute.</p>
              </Panel>
            </div>
          )}
        </div>
        {result.debrief && result.debrief.length > 0 && (
          <Panel title={result.codename ? `DEBRIEF · ${result.codename}` : 'DEBRIEF'} className="lg:mt-4">
            <Debrief lines={result.debrief} />
          </Panel>
        )}
      </div>

      <div className="sticky bottom-0 z-20 -mx-4 mt-6 flex flex-wrap items-center gap-3 border-t border-line-strong bg-ink/95 px-4 py-3 backdrop-blur sm:mx-0" data-testid="results-next">
        <Link href="/contracts" className="cz-btn cz-btn-primary px-5 py-2 text-sm">Back to the board</Link>
        {brought && <Link href="/exchange" className="cz-btn cz-btn-ghost px-5 py-2 text-sm" data-testid="results-sell">Sell your {result.resource} at the Exchange</Link>}
        {won && <Link href="/war-room" className="cz-btn cz-btn-ghost px-5 py-2 text-sm">Watch the reaction</Link>}
        <Link href="/" className="ml-auto text-sm text-muted hover:text-fog">Hub</Link>
      </div>
    </Shell>
  )
}
