'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { Panel, Shell, Stat } from '@/components/ui/Shell'
import { api, RESOURCE_LABEL, type BoardEntry } from '@/lib/api'
import { WorldClockPanel } from '@/components/world/WorldClock'
import { describeGuardPlan } from '@/lib/presenter/economy'

const PHASE_WORD = { day: 'by day', dusk: 'at dusk', night: 'at night' } as const

function Guards({ e }: { e: BoardEntry }) {
  const d = describeGuardPlan(e.guards, e.target_name)
  return (
    <div className="text-sm text-slate-300">
      <span className="font-semibold text-slate-100">{d.arms}</span>
      {d.stayedHome > 0 && <span className="text-amber-400"> · {d.stayedHome} stayed home (not enough ammunition)</span>}
      <div className="text-xs text-slate-500">{d.medical} · guard HP {e.guards.guard_hp}</div>
    </div>
  )
}

const KIND: Record<string, { label: string; badge: string; title: (e: BoardEntry) => string; does: (e: BoardEntry) => string; changes: (e: BoardEntry) => string }> = {
  raid: {
    label: 'Depot raid', badge: 'bg-amber/15 !text-amber-hi',
    title: (e) => `${RESOURCE_LABEL[e.resource]}: ${e.manifest} units`,
    does: (e) => `Break into ${e.site?.name ?? `${e.target_name}'s depot`}, take the cargo cases from the ${e.site?.facility ?? 'store'} and carry them to the extraction. What you bring out is yours to keep or sell.`,
    changes: (e) => `${e.target_name} loses ${e.manifest} ${e.resource}. Expect it to restock from Vex and field fewer armed guards next time.`,
  },
  sabotage: {
    label: 'Sabotage', badge: 'bg-hostile/15 !text-hostile',
    title: (e) => `${e.target_name}'s ${e.resource} line`,
    does: (e) => `Set two charges at ${e.site?.name ?? 'the site'} and get clear before the fuse runs out. No need to fight them all; you take nothing home but the fee.`,
    changes: (e) => `Destroys ${e.manifest} ${e.resource} and stops ${e.target_name} producing it for 36 hours, so it has to buy from the market.`,
  },
  recovery: {
    label: 'Recovery', badge: 'bg-steel/15 !text-steel',
    title: (e) => `Seized ${e.resource}: ${e.manifest} units`,
    does: (e) => `${e.target_name} took a caravan on the road and holds it in the ${e.site?.facility ?? 'yard'} at ${e.site?.name ?? 'its site'}. Carry the sealed case out and hand it back to its owner.`,
    changes: (e) => `The ${e.resource} goes back on the owner's shelf and ${e.target_name} loses what it stole. You're paid the fee, not the cargo.`,
  },
}

export default function ContractBoard() {
  const world = useQuery({ queryKey: ['world'], queryFn: api.world, refetchInterval: 5_000 })
  const board = world.data?.board ?? []

  return (
    <Shell title="Contract Board" back={{ href: '/', label: 'Hub' }}>
      {world.isError && <p className="text-rose-400">The economy server is not reachable.</p>}
      <div className="mb-4"><WorldClockPanel clock={world.data?.clock} /></div>
      {world.data && board.length === 0 && (
        <Panel><p className="text-muted">Nothing on the board right now. Vanguard may be out of fuel to stage a depot, and nobody is paying for anything else.</p></Panel>
      )}
      <div className="grid gap-3">
        {board.map((e) => {
          const k = KIND[e.kind] ?? KIND.raid
          const phase = world.data?.clock?.conditions.phase
          // Each contract is at its own site; the hour only changes the conditions there.
          const site = e.site ? `${e.site.name} · ${e.site.facility}${phase ? ` · ${PHASE_WORD[phase]}` : ''}`
            : world.data?.zone === 'BLACKSITE' ? 'Blacksite · night' : world.data?.zone === 'REDYARD' ? 'Dustline Depot · dusk' : 'Dustline Depot · day'
          const fee = e.bounty?.amount ?? 0
          return (
            <section key={`${e.kind}-${e.target}-${e.resource}`} className="cz-panel p-5">
              <div className="flex flex-wrap items-start justify-between gap-5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`cz-label !text-[10px] px-2 py-0.5 ${k.badge}`}>{k.label}</span>
                    <span className="cz-label !text-[10px]">{site} · defense L{e.defense}</span>
                  </div>
                  <div className="mt-2 font-display text-2xl font-bold uppercase tracking-wide">{k.title(e)}</div>
                  <p className="mt-1 text-sm text-muted">{k.does(e)}</p>
                  <p className="mt-2 border-l-2 border-amber/60 pl-3 text-sm">{k.changes(e)}</p>
                  <div className="mt-3"><Guards e={e} /></div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-3">
                  <div className="flex gap-6 text-right">
                    {e.kind === 'raid' && <Stat label="Cargo sells for" value={`${e.market_value.bid} cr`} hint={`${e.market_value.unit_bid} cr/unit at Vex`} />}
                    <Stat label={e.kind === 'raid' ? 'Bounty' : 'Contract fee'} value={fee ? `${fee} cr` : 'none'} hint={e.bounty ? `from ${e.bounty.sponsor_name}` : undefined} />
                  </div>
                  <Link href={`/deploy?target=${e.target}&resource=${e.resource}&kind=${e.kind}`} className="cz-btn cz-btn-primary px-6 py-2 text-sm">View intel</Link>
                </div>
              </div>
            </section>
          )
        })}
      </div>

      {world.data && (
        <Panel title="MARKET (VEX EXCHANGE)" className="mt-6">
          <div className="grid grid-cols-3 gap-3">
            {world.data.prices.map((p) => (
              <Stat key={p.resource} label={RESOURCE_LABEL[p.resource]} value={`${p.price.bid} / ${p.price.ask} cr`} hint={`bid / ask · Vex holds ${p.stock}`} />
            ))}
          </div>
          {world.data.market.insolvent && <p className="mt-3 text-sm text-amber-400">Vex is insolvent and not buying.</p>}
        </Panel>
      )}
    </Shell>
  )
}
