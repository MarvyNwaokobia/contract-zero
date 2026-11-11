'use client'

// What the table knows about the selected facility: who holds it, what it holds, how
// ready it is, what it can field, what can be done there, what is moving to it, who has
// hit it, and what its commander last decided. Each block is filtered from real records
// (lib/world/intel.ts) and says so when a record is missing.

import Link from 'next/link'
import { describeFaction, describeGuardPlan } from '@/lib/presenter/economy'
import { describeConsequence, worldClock } from '@/lib/presenter/consequence'
import { factionColor } from '@/lib/factions'
import type { FacilityIntel } from '@/lib/world/intel'
import type { MarketMerchant } from '@/lib/api'
import { RESOURCE_LABEL } from '@/lib/api'
import { convoyState } from '@/lib/world/convoy'
import { inboundFor, MerchantSummary, ReadinessSummary } from '@/components/world/Readiness'
import { BeforeAfter } from '@/components/world/BeforeAfter'
import { FacilityGlyph } from './FacilityGlyph'
import { SupplyGauge } from './SupplyGauge'

const RES = ['ammo', 'med', 'fuel'] as const

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="border-t border-line pt-3"><h3 className="cz-label mb-1.5 !text-[10px]">{title}</h3>{children}</section>
}

export function FacilityPanel({ intel, merchant, tick }: { intel: FacilityIntel; merchant?: MarketMerchant; tick: number }) {
  const { facility: f, owner } = intel
  const color = factionColor(f.owner)
  const isFaction = owner?.kind === 'faction'
  const need = (r: (typeof RES)[number]) => (owner ? owner.requirement[r] : 0)
  return (
    <div className="grid gap-3" data-testid="facility-panel" aria-live="polite">
      <header className="flex items-start gap-3">
        <FacilityGlyph id={f.id} color={color} size={56} />
        <div className="min-w-0">
          <div className="font-display text-xl font-bold uppercase tracking-wider text-fog">{f.name}</div>
          <div className="text-xs text-muted">{f.kind === 'site' ? `${f.subtitle} · held by ` : 'Run by '}<span style={{ color }}>{owner?.name ?? f.owner}</span></div>
          {f.kind === 'site' && <div className="mt-0.5 text-[11px] text-dim">Stock is {owner?.name ?? 'its owner'}&apos;s and shared across its sites.</div>}
        </div>
      </header>

      {owner && isFaction && (
        <Block title="Readiness">
          <ReadinessSummary a={owner} inbound={inboundFor(owner.id, intel.openOrders, intel.convoys)} />
        </Block>
      )}
      {owner && !isFaction && merchant && <Block title="Trading position"><MerchantSummary m={merchant} /></Block>}

      {owner && (
        <Block title={isFaction ? 'Holdings against need' : 'Shelves against target'}>
          <div className="grid gap-1">
            {RES.map((r) => <SupplyGauge key={r} resource={r} stock={merchant && !isFaction ? merchant.shelves[r].stock : owner.holdings[r]} target={merchant && !isFaction ? merchant.shelves[r].target : need(r)} />)}
            <div className="text-xs text-muted">Treasury <span className="cz-num text-fog">{owner.holdings.credits.toLocaleString()} cr</span>{isFaction && <span className="text-dim"> · reserve {owner.credit_reserve.toLocaleString()}</span>}</div>
          </div>
        </Block>
      )}

      {intel.lines.length > 0 && (
        <Block title="Production at this site">
          <ul className="grid gap-0.5 text-sm">
            {intel.lines.map((l) => (
              <li key={l.line} className="flex justify-between gap-2"><span className="text-fog capitalize">{l.line}</span>{l.down_until != null ? <span className="font-semibold text-hostile">down until {worldClock(l.down_until)}</span> : <span className="text-friendly">running</span>}</li>
            ))}
          </ul>
        </Block>
      )}

      {intel.missions.length > 0 && (
        <Block title={`Contracts here (${intel.missions.length})`}>
          <ul className="grid gap-2">
            {intel.missions.map((m) => {
              const g = describeGuardPlan(m.guards, m.target_name)
              return (
                <li key={`${m.kind}-${m.resource}`} className="border border-line bg-ink-2/60 p-2 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-display font-bold uppercase tracking-wider text-fog">{m.kind} · {RESOURCE_LABEL[m.resource]} · {m.manifest} units</span>
                    <Link href={`/deploy?target=${m.target}&resource=${m.resource}&kind=${m.kind}`} className="text-xs text-amber-hi hover:underline">View intel</Link>
                  </div>
                  <div className="text-xs text-muted">Guard capability: {g.arms}{g.stayedHome > 0 ? ` · ${g.stayedHome} unarmed at home` : ''} · {g.medical}{m.bounty ? ` · bounty ${m.bounty.amount} cr` : ''}</div>
                </li>
              )
            })}
          </ul>
        </Block>
      )}
      {f.kind === 'site' && intel.missions.length === 0 && <Block title="Contracts here"><p className="text-sm text-muted">None on offer right now.{owner && isFaction && describeFaction(owner).statements.some((s) => s.topic === 'fuel' && s.severity !== 'ok') ? ' Its fuel is too low to stage a depot.' : ''}</p></Block>}
      {intel.activeOperations > 0 && <p className="text-sm text-steel">{intel.activeOperations} operator{intel.activeOperations === 1 ? ' is' : 's are'} deployed here now.</p>}

      <Block title="Supply routes">
        {intel.convoys.length === 0 && intel.openOrders.length === 0 && <p className="text-sm text-muted">Nothing inbound and no open supply order.</p>}
        <ul className="grid gap-0.5 text-sm">
          {intel.convoys.map((c) => {
            const st = convoyState(c.status)
            return (
            <li key={c.id}>
              {st.state === 'seized' ? <span className="text-hostile">Seized convoy: {c.units} {c.resource}{st.by ? ` taken by ${st.by}` : ''}.</span>
                : st.state === 'in_transit' ? <>Shipment: {c.units} {c.resource}, due {worldClock(c.arrives_at)} <span className="text-dim">({Math.round(c.progress * 100)}% of the trip by the server&apos;s clock; strategic marker, not vehicle telemetry)</span></>
                : <span className="text-muted">Shipment of {c.units} {c.resource}: {st.state === 'arrived' ? 'delivered' : 'status unknown'}, {worldClock(c.arrives_at)}.</span>}
            </li>
            )
          })}
          {intel.openOrders.map((o) => <li key={o.id} className="text-steel">Open supply order: {o.side === 'buy' ? 'wants' : 'sells'} {o.qty - o.filled} {o.resource}, {o.proposals.length} proposal{o.proposals.length === 1 ? '' : 's'} so far.</li>)}
        </ul>
        {intel.contractsAgainst.length > 0 && <p className="mt-1 text-xs text-muted">{intel.contractsAgainst.length} contract{intel.contractsAgainst.length === 1 ? '' : 's'} paid against it by rivals.</p>}
      </Block>

      {isFaction && <Block title="Recent attacks">
        {intel.attacks.length === 0 ? <p className="text-sm text-muted">No recorded operations against {owner?.name ?? 'it'} yet.</p> : (
          <ul className="grid gap-2">
            {intel.attacks.map((o, i) => {
              const story = describeConsequence(o, o.consequence, { recorded: true, settled: !!o.consequence.after, decisions: o.decisions })
              return (
                <li key={i} className="text-sm">
                  <div className="text-fog capitalize">{o.kind} · {RESOURCE_LABEL[o.resource]} · {o.outcome === 'extracted' ? `${o.extracted_units} units` : o.outcome}{o.consequence.settled_tick != null ? <span className="text-dim"> · {worldClock(o.consequence.settled_tick)}</span> : null}</div>
                  <div className="text-xs text-muted">{story.steps[2]?.lines[0]}</div>
                  <details className="mt-1 text-xs">
                    <summary className="cursor-pointer text-steel hover:text-fog">Compare before and after</summary>
                    <div className="mt-1"><BeforeAfter c={o.consequence} /></div>
                  </details>
                </li>
              )
            })}
          </ul>
        )}
      </Block>}

      <Block title={isFaction ? 'Commander' : 'Latest decision'}>
        {intel.latestDecision ? (
          <p className="text-sm"><span className="text-dim">{worldClock(intel.latestDecision.tick)} · </span><span className="text-fog">{intel.latestDecision.payload.rationale ?? intel.latestDecision.payload.trigger ?? 'acted'}</span>{intel.latestDecision.payload.validation === 'rejected' && <span className="text-hostile"> (rejected by the engine)</span>}</p>
        ) : <p className="text-sm text-muted">No decision logged yet.</p>}
        {isFaction && owner && <p className="mt-1 text-xs text-dim">{owner.doctrine.aggression >= 50 ? 'Aggressive doctrine' : 'Defensive doctrine'} · {tick >= 0 ? `as of ${worldClock(tick)}` : ''}</p>}
      </Block>
    </div>
  )
}
