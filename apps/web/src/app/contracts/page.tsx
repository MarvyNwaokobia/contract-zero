'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { Panel, Shell, Stat } from '@/components/ui/Shell'
import { api, RESOURCE_LABEL, type BoardEntry } from '@/lib/api'

function Guards({ e }: { e: BoardEntry }) {
  const g = e.guards
  const rifles = g.hall.rifles + g.yard.rifles
  const sidearms = g.hall.sidearms + g.yard.sidearms
  const missing = g.planned - rifles - sidearms
  return (
    <div className="text-sm text-slate-300">
      <span className="font-semibold text-slate-100">{rifles + sidearms}</span> guards: {rifles} rifle{rifles === 1 ? '' : 's'}
      {sidearms > 0 && <>, {sidearms} sidearm{sidearms === 1 ? '' : 's'}</>}
      {missing > 0 && <span className="text-amber-400"> · {missing} stayed home (not enough ammunition)</span>}
      <div className="text-xs text-slate-500">
        {g.reinforce_per_drop === 0 ? 'No reinforcements: Vanguard is out of medicine' : `${g.reinforce_per_drop} reinforcements per wave while you load`}
        {' · '}guard HP {g.guard_hp}
      </div>
    </div>
  )
}

export default function ContractBoard() {
  const world = useQuery({ queryKey: ['world'], queryFn: api.world, refetchInterval: 5_000 })
  const board = world.data?.board ?? []

  return (
    <Shell title="Contract Board" back={{ href: '/', label: 'Main Menu' }}>
      {world.isError && <p className="text-rose-400">The economy server is not reachable.</p>}
      {world.data && board.length === 0 && (
        <Panel><p className="text-slate-400">No depot is worth raiding right now. Vanguard may be out of fuel to stage one, or its stores are too thin.</p></Panel>
      )}
      <div className="grid gap-3">
        {board.map((e) => (
          <Panel key={`${e.target}-${e.resource}`}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="text-xs tracking-[0.2em] text-slate-500">RAID · {e.target_name.toUpperCase()} · DEFENSE L{e.defense}</div>
                <div className="mt-1 text-lg font-semibold text-slate-100">{RESOURCE_LABEL[e.resource]} depot: {e.manifest} units</div>
                <div className="mt-2"><Guards e={e} /></div>
              </div>
              <div className="flex gap-6">
                <Stat label="Sells for" value={`${e.market_value.bid} cr`} hint={`${e.market_value.unit_bid} cr/unit at Vex`} />
                <Stat label="Bounty" value={e.bounty ? `${e.bounty.amount} cr` : 'none'} hint={e.bounty ? `from ${e.bounty.sponsor_name}` : undefined} />
              </div>
              <Link
                href={`/deploy?target=${e.target}&resource=${e.resource}`}
                className="self-center rounded bg-cyan-500 px-5 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400"
              >
                Deploy
              </Link>
            </div>
          </Panel>
        ))}
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
