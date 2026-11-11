'use client'

// The War Table: map plus facility intel, joined from the server's own records. It reads
// the same data as the rest of the War Room, so a faction shows the same state everywhere.

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type MarketView, type WarRoomView } from '@/lib/api'
import { describeFaction, READINESS_LABEL } from '@/lib/presenter/economy'
import { describeMerchant, MERCHANT_LABEL } from '@/lib/presenter/merchant'
import { buildTable } from '@/lib/world/table'
import { facilityIntel } from '@/lib/world/intel'
import { inboundFor } from '@/components/world/Readiness'
import { WarTable, type FacilityStatus, type Tone } from './WarTable'
import { FacilityPanel } from './FacilityPanel'

const READY_TONE = { operational: 'ok', under_pressure: 'warn', supply_critical: 'critical', rebuilding: 'info' } as const
const MERCHANT_TONE = { trading: 'ok', stretched: 'warn', constrained: 'critical', insolvent: 'critical' } as const

export function WarTableSection({ war, market }: { war: WarRoomView; market: MarketView | undefined }) {
  const world = useQuery({ queryKey: ['world'], queryFn: api.world, refetchInterval: 10_000 })
  const ops = useQuery({ queryKey: ['war-operations'], queryFn: () => api.warOperations(10), refetchInterval: 15_000 })
  const decisions = useQuery({ queryKey: ['decisions', 40], queryFn: () => api.decisions(40), refetchInterval: 15_000 })
  const [picked, setPicked] = useState<string | null>(null)

  const model = useMemo(() => buildTable({ sites: world.data?.sites ?? [], war: war.world, merchants: market?.merchants }), [world.data?.sites, war.world, market?.merchants])
  const input = { actors: war.world.actors, convoys: war.world.convoys, contracts: war.world.contracts, world: world.data, orders: market?.orders, operations: ops.data, decisions: decisions.data }

  const status = useMemo(() => {
    const out: Record<string, FacilityStatus> = {}
    for (const f of model.facilities) {
      const a = war.world.actors.find((x) => x.id === f.owner)
      if (!a) continue
      let label = '', tone: Tone = 'info'
      if (a.kind === 'faction') {
        const p = describeFaction(a, inboundFor(a.id, market?.orders, war.world.convoys))
        label = READINESS_LABEL[p.readiness]; tone = READY_TONE[p.readiness]
      } else {
        const m = market?.merchants.find((x) => x.id === a.id)
        if (m) { const p = describeMerchant(m); label = MERCHANT_LABEL[p.state]; tone = MERCHANT_TONE[p.state] }
      }
      const intel = facilityIntel(f, input)
      out[f.id] = { label, tone, linesDown: intel.lines.filter((l) => l.down_until != null).length, openContracts: intel.missions.length, activeOperations: intel.activeOperations }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, war.world, market, world.data])

  const selectedId = picked && model.facilities.some((f) => f.id === picked) ? picked : model.facilities[0]?.id ?? null
  const selected = model.facilities.find((f) => f.id === selectedId)
  const intel = selected ? facilityIntel(selected, input) : null

  return (
    <section className="grid items-start gap-4 lg:grid-cols-[1.35fr_1fr]" data-testid="war-table">
      <div className="cz-panel min-w-0 p-3 lg:sticky lg:top-4">
        <h2 className="cz-label mb-2">War Table</h2>
        <div className="overflow-x-auto" tabIndex={-1}>
          <WarTable model={model} status={status} selectedId={selectedId} onSelect={setPicked} tick={war.world.tick} />
        </div>
        {/* The same choice as the map, as plain buttons: easier on a phone, and a labelled list for screen readers. */}
        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Facilities">
          {model.facilities.map((f) => (
            <button key={f.id} type="button" aria-pressed={f.id === selectedId} onClick={() => setPicked(f.id)}
              className={`border px-2.5 py-1.5 text-left text-xs ${f.id === selectedId ? 'border-amber bg-amber/10 text-amber-hi' : 'border-line text-muted hover:text-fog'}`}>
              <span className="font-display font-bold uppercase tracking-wider">{f.name}</span>{status[f.id] && <span className="ml-1.5 text-[10px] uppercase tracking-widest opacity-80">{status[f.id].label}</span>}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-dim">Select a facility on the map or from the list. Rings show faction readiness; a triangle means a production line is down; the number is contracts on offer; a diamond on the road is a shipment placed from the server&apos;s own arrival times.</p>
      </div>
      <div className="cz-panel min-w-0 p-4">
        {intel ? <FacilityPanel intel={intel} merchant={market?.merchants.find((m) => m.id === intel.facility.owner)} tick={war.world.tick} /> : <p className="text-sm text-muted">The map has no facilities yet.</p>}
      </div>
    </section>
  )
}
