'use client'

// The War Room: who holds what, what's moving on the roads, what is being paid for,
// and — one card per decision — why the world changed:
//   trigger → observed state → proposal → validation → transaction → world → gameplay.
// Observer Mode at the bottom runs a COPY of the economy forward; it is labelled as a
// simulation everywhere it appears and never touches the live world or NEAR.

import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Panel, Shell, Stat } from '@/components/ui/Shell'
import { api, RESOURCE_LABEL, type CausalChain, type ChainTx, type ResourceName, type SimulationView, type WarActor, type WarConvoy, type WarContract, type WarRoomView } from '@/lib/api'

const RES: ResourceName[] = ['ammo', 'med', 'fuel']
const RES_COLOR: Record<ResourceName, string> = { ammo: 'var(--color-amber)', med: 'var(--color-friendly)', fuel: 'var(--color-steel)' }
const ACTOR_COLOR: Record<string, string> = { vanguard: 'var(--color-steel)', ashen: 'var(--color-hostile)', vex: 'var(--color-amber)' }
const color = (id: string) => ACTOR_COLOR[id] ?? 'var(--color-muted)'
const clock = (tick: number) => `D${Math.floor(tick / 24)} ${String(tick % 24).padStart(2, '0')}:00`

// ── regional map ──

const SITES: Record<string, { x: number; y: number; label: string; sub: string }> = {
  vanguard: { x: 150, y: 210, label: 'Dustline Depot', sub: 'Vanguard' },
  ashen: { x: 610, y: 90, label: 'Ashen Refinery', sub: 'Ashen Compact' },
  vex: { x: 420, y: 230, label: 'Vex Exchange', sub: 'Merchant' },
  blacksite: { x: 230, y: 70, label: 'Blacksite', sub: 'Vanguard, night ops' },
  outside: { x: 700, y: 300, label: 'Outer markets', sub: 'imports / exports' },
}
const ROUTES: [string, string][] = [['vanguard', 'vex'], ['ashen', 'vex'], ['outside', 'vex'], ['vanguard', 'blacksite']]

function routeFor(c: WarConvoy): [string, string] {
  // Merchant caravans come in from outside; a faction's shipments come home to its depot.
  return c.owner === 'vex' ? ['outside', 'vex'] : ['vex', c.owner in SITES ? c.owner : 'vanguard']
}

function RegionMap({ v }: { v: WarRoomView }) {
  const actors = Object.fromEntries(v.world.actors.map((a) => [a.id, a]))
  const targeted = new Map<string, WarContract[]>()
  for (const c of v.world.contracts) targeted.set(c.target, [...(targeted.get(c.target) ?? []), c])
  return (
    <svg viewBox="0 0 760 330" className="h-auto w-full" role="img" aria-label="Regional map: depots, the exchange, supply routes and convoys">
      <defs>
        <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="var(--color-line)" strokeWidth="0.6" /></pattern>
      </defs>
      <rect width="760" height="330" fill="url(#grid)" opacity="0.6" />
      {ROUTES.map(([a, b]) => (
        <line key={a + b} x1={SITES[a].x} y1={SITES[a].y} x2={SITES[b].x} y2={SITES[b].y} stroke="var(--color-line-strong)" strokeWidth="2" strokeDasharray="6 6" />
      ))}
      {v.world.convoys.filter((c) => c.status.state === 'in_transit' || c.status.state === 'seized').map((c) => {
        const [from, to] = routeFor(c)
        const p = c.progress
        const x = SITES[from].x + (SITES[to].x - SITES[from].x) * p
        const y = SITES[from].y + (SITES[to].y - SITES[from].y) * p
        const seized = c.status.state === 'seized'
        return (
          <g key={c.id}>
            <circle cx={x} cy={y} r={seized ? 9 : 7} fill={seized ? 'var(--color-hostile)' : RES_COLOR[c.resource]} stroke="var(--color-ink)" strokeWidth="2">
              <title>{`${c.owner_name} caravan #${c.id}: ${c.units} ${c.resource}, escort ${c.defense}${seized ? ` (seized by ${c.status.by})` : `, arrives ${clock(c.arrives_at)}`}`}</title>
            </circle>
            <text x={x} y={y - 12} textAnchor="middle" className="fill-fog font-display text-[11px] font-semibold">{c.units} {c.resource}{seized ? ' · SEIZED' : ''}</text>
          </g>
        )
      })}
      {Object.entries(SITES).map(([id, s]) => {
        const a = actors[id === 'blacksite' ? '' : id]
        const hits = targeted.get(id) ?? []
        const down = a?.disrupted ?? []
        return (
          <g key={id}>
            <rect x={s.x - 9} y={s.y - 9} width="18" height="18" transform={`rotate(45 ${s.x} ${s.y})`} fill="var(--color-panel-2)" stroke={id in ACTOR_COLOR ? color(id) : 'var(--color-dim)'} strokeWidth="2.5" />
            {hits.length > 0 && <circle cx={s.x} cy={s.y} r="20" fill="none" stroke="var(--color-hostile)" strokeWidth="1.5" strokeDasharray="3 3"><title>{hits.map((h) => `${h.kind} contract: ${h.amount} cr from ${h.sponsor_name}`).join('\n')}</title></circle>}
            <text x={s.x} y={s.y + 30} textAnchor="middle" className="fill-fog font-display text-[13px] font-bold uppercase tracking-wider">{s.label}</text>
            <text x={s.x} y={s.y + 44} textAnchor="middle" className="fill-muted text-[11px]">
              {s.sub}{a && a.kind === 'faction' ? ` · defense ${a.defense}` : ''}{hits.length ? ` · ${hits.length} contract${hits.length > 1 ? 's' : ''}` : ''}
            </text>
            {down.map((d, i) => <text key={d.resource} x={s.x} y={s.y + 58 + i * 13} textAnchor="middle" className="fill-hostile text-[11px] font-semibold">{d.resource} line down until {clock(d.until)}</text>)}
          </g>
        )
      })}
    </svg>
  )
}

// ── charts ──

function Spark({ values, stroke, h = 36, w = 160 }: { values: number[]; stroke: string; h?: number; w?: number }) {
  if (values.length < 2) return <svg width={w} height={h} />
  const lo = Math.min(...values), hi = Math.max(...values)
  const span = hi - lo || 1
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 3 - ((v - lo) / span) * (h - 6)}`).join(' ')
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible" aria-hidden>
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  )
}

function Lines({ series, height = 120 }: { series: { label: string; color: string; values: number[] }[]; height?: number }) {
  const w = 600
  const all = series.flatMap((s) => s.values)
  if (all.length < 2) return null
  const lo = Math.min(0, ...all), hi = Math.max(...all) || 1
  const n = Math.max(...series.map((s) => s.values.length))
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${height}`} className="h-auto w-full" aria-hidden>
        <line x1="0" x2={w} y1={height - 1} y2={height - 1} stroke="var(--color-line)" />
        {series.map((s) => (
          <polyline key={s.label} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round"
            points={s.values.map((v, i) => `${(i / Math.max(1, n - 1)) * w},${height - 2 - ((v - lo) / (hi - lo)) * (height - 6)}`).join(' ')} />
        ))}
      </svg>
      <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted">
        {series.map((s) => <span key={s.label} className="flex items-center gap-1"><span className="inline-block h-0.5 w-3" style={{ background: s.color }} />{s.label}</span>)}
        <span className="ml-auto cz-num">peak {hi.toLocaleString()}</span>
      </div>
    </div>
  )
}

// ── factions ──

function Bar({ have, need, c }: { have: number; need: number; c: string }) {
  const pct = need > 0 ? Math.min(100, (have / need) * 100) : 100
  return (
    <div className="h-1.5 w-full bg-line">
      <div className="h-full" style={{ width: `${pct}%`, background: have < need ? 'var(--color-hostile)' : c }} />
    </div>
  )
}

function ActorCard({ a, v }: { a: WarActor; v: WarRoomView }) {
  const credits = v.history.map((h) => h.holdings[a.id]?.credits).filter((x): x is number => x != null)
  const against = v.world.contracts.filter((c) => c.target === a.id)
  const sponsoring = v.world.contracts.filter((c) => c.sponsor === a.id)
  const need = (r: ResourceName) => a.kind === 'merchant' ? (v.world.prices.find((p) => p.resource === r)?.target ?? 0) : a.requirement[r]
  const stance = a.kind === 'merchant' ? 'Trader' : a.doctrine.aggression >= 50 ? 'Aggressive' : 'Defensive'
  return (
    <Panel className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-display text-lg font-bold uppercase tracking-wider" style={{ color: color(a.id) }}>{a.name}</div>
          <div className="text-xs text-muted">{stance} · {a.kind === 'faction' ? `income ${a.income_per_day} cr/day` : 'runs the Exchange'}</div>
        </div>
        {a.kind === 'faction' && (
          <div className="text-right">
            <div className="cz-label !text-[10px]">Defense</div>
            <div className="flex gap-0.5">{[1, 2, 3, 4, 5].map((i) => <span key={i} className="h-3 w-2" style={{ background: i <= a.defense ? color(a.id) : 'var(--color-line)' }} />)}</div>
          </div>
        )}
      </div>
      <div className="flex items-end justify-between">
        <Stat label="Treasury" value={`${a.holdings.credits.toLocaleString()} cr`} hint={`reserve ${a.credit_reserve.toLocaleString()}`} />
        <Spark values={credits} stroke={color(a.id)} w={120} />
      </div>
      <div className="grid gap-1.5">
        <div className="cz-label !text-[10px]">{a.kind === 'merchant' ? 'Shelf vs target' : 'Stock vs need'}</div>
        {RES.map((r) => (
          <div key={r} className="grid grid-cols-[3.5rem_1fr_4.5rem] items-center gap-2 text-xs">
            <span className="text-muted">{r}</span>
            <Bar have={a.holdings[r]} need={need(r)} c={RES_COLOR[r]} />
            <span className="cz-num text-right text-fog">{a.holdings[r]}<span className="text-dim">/{need(r)}</span></span>
          </div>
        ))}
      </div>
      {a.disrupted.length > 0 && <p className="text-xs font-semibold text-hostile">Sabotaged: {a.disrupted.map((d) => `${d.resource} line down until ${clock(d.until)}`).join(', ')}</p>}
      <div className="grid gap-1 border-t border-line pt-2 text-xs text-muted">
        {against.map((c) => <div key={c.id}><span className="text-hostile">Targeted:</span> {c.kind} on its {c.resource}, {c.amount} cr from {c.sponsor_name}</div>)}
        {sponsoring.map((c) => <div key={c.id}><span className="text-amber-hi">Paying:</span> {c.amount} cr for a {c.kind} on {c.target_name}&apos;s {c.resource}</div>)}
        {a.rivals.map((r) => <div key={r.sponsor}><span className="text-fog">Remembers:</span> {r.sponsor_name} paid for {r.bounties_paid} raid{r.bounties_paid === 1 ? '' : 's'} on it</div>)}
        {a.grudges.slice(0, 2).map((g) => <div key={g.player}><span className="text-fog">Grudge:</span> {g.player.length > 24 ? `${g.player.slice(0, 22)}…` : g.player} — {g.raids} raids, {g.sabotage} sabotage, {g.units_lost} units lost</div>)}
        {!against.length && !sponsoring.length && !a.rivals.length && !a.grudges.length && <div>No open contracts, rivals or grudges.</div>}
      </div>
    </Panel>
  )
}

// ── causal timeline ──

const VALID_STYLE: Record<string, string> = {
  accepted: 'text-friendly', rejected: 'text-hostile', rejected_by_policy: 'text-hostile', rejected_by_engine: 'text-hostile', no_action: 'text-muted',
}

function actionText(a: Record<string, unknown> | null | undefined): string {
  if (!a) return 'no action'
  const kind = String(a.action ?? a.type ?? '')
  switch (kind) {
    case 'trade': return `${a.side} ${a.qty} ${a.resource} (limit ${a.limit_total} cr)`
    case 'configure_defense': return `set defense to ${a.level}`
    case 'post_bounty': return `post ${a.amount} cr raid bounty on ${a.target}'s ${a.resource}`
    case 'post_contract': return `post ${a.amount} cr ${a.kind} contract on ${a.target}'s ${a.resource}`
    case 'seize_convoy': return `seize caravan #${a.convoy}`
    case 'set_margin': return `set margin to ${a.margin_bp} bp`
    default: return kind.replace(/_/g, ' ') || 'action'
  }
}

function TxCell({ tx }: { tx: ChainTx }) {
  if (tx.status === 'off_chain' || tx.status === 'not_queued') return <div className="text-muted">{tx.note ?? 'Game state only.'}</div>
  const label = tx.settled_on_chain ? 'Settled on NEAR' : tx.status === 'failed' ? 'Failed' : tx.status === 'compensated' ? 'Reversed in game (chain refused)' : tx.status === 'superseded' ? 'Superseded by a realignment' : 'Queued for NEAR'
  return (
    <div>
      <span className={tx.settled_on_chain ? 'text-friendly' : tx.status === 'failed' || tx.status === 'compensated' ? 'text-hostile' : 'text-amber-hi'}>{label}</span>
      <span className="text-dim"> · {tx.op_id}</span>
      {(tx.explorer ?? []).map((u, i) => <a key={u} href={u} target="_blank" rel="noreferrer" className="ml-2 text-steel underline-offset-2 hover:underline">tx {i + 1} ↗</a>)}
      {tx.settled_on_chain && !(tx.explorer ?? []).length && <span className="text-dim"> (confirmed by the contract&apos;s used-op record)</span>}
    </div>
  )
}

function Step({ n, label, children }: { n: number; label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[1.25rem_6.5rem_1fr] gap-2 text-sm">
      <span className="cz-num text-dim">{n}</span>
      <span className="cz-label !text-[10px] pt-0.5">{label}</span>
      <div className="min-w-0 text-slate-300">{children}</div>
    </div>
  )
}

function ChainCard({ c, initiallyOpen }: { c: CausalChain; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  const txs = c.transactions ?? (c.transaction ? [c.transaction] : [])
  const llm = c.proposal.planner.startsWith('llm:')
  const onChain = txs.some((t) => t.settled_on_chain)
  return (
    <article className="cz-panel grid gap-1.5 p-3" data-testid="causal-chain">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex flex-wrap items-baseline gap-2 text-left">
        <span className="font-display font-bold uppercase tracking-wider" style={{ color: c.kind === 'operation' ? 'var(--color-fog)' : color(c.actor) }}>{c.actor_name}</span>
        <span className="text-xs text-muted">{clock(c.tick)}</span>
        <span className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${llm ? 'bg-steel/15 text-steel' : c.kind === 'operation' ? 'bg-amber/15 text-amber-hi' : 'bg-line text-muted'}`}>
          {llm ? `NEAR AI · ${c.proposal.planner.slice(4)}` : c.kind === 'operation' ? 'Player operation' : 'Deterministic policy'}
        </span>
        <span className="w-full min-w-0 text-sm text-slate-300">
          <span className="text-muted">{c.trigger}</span> → {c.world[0] ?? (c.proposal.summary ?? actionText(c.proposal.action))}
          <span className={`ml-2 text-xs ${VALID_STYLE[c.validation.status] ?? ''}`}>{c.validation.status.replace(/_/g, ' ')}</span>
          {onChain && <span className="ml-2 text-xs text-friendly">· on NEAR</span>}
          <span className="ml-2 text-xs text-dim">{open ? '▴' : '▾'}</span>
        </span>
      </button>
      {open && <div className="mt-1 grid gap-1.5 border-t border-line pt-2">
      <Step n={1} label="Trigger">{c.trigger}</Step>
      <Step n={2} label="Observed">
        {c.observed?.length ? <span className="cz-num text-xs text-muted">{c.observed.map(([k, v]) => `${k.replace(/_/g, ' ')} ${String(v)}`).join(' · ')}</span> : <span className="text-dim">—</span>}
      </Step>
      <Step n={3} label="Proposal">
        <span className="text-fog">{c.proposal.summary ?? actionText(c.proposal.action)}</span>
        {c.proposal.rationale && <div className="text-xs italic text-muted">“{c.proposal.rationale}”</div>}
      </Step>
      <Step n={4} label="Validation">
        <span className={VALID_STYLE[c.validation.status] ?? 'text-fog'}>{c.validation.status.replace(/_/g, ' ')}</span>
        <span className="text-xs text-dim"> by {c.validation.by}</span>
        {c.validation.error && <div className="text-xs text-hostile">{c.validation.error}</div>}
      </Step>
      <Step n={5} label="Transaction">{txs.length ? <div className="grid gap-0.5 text-xs">{txs.map((t, i) => <TxCell key={i} tx={t} />)}</div> : <span className="text-xs text-dim">Nothing to settle.</span>}</Step>
      <Step n={6} label="World">{c.world.length ? c.world.join('; ') : <span className="text-dim">No change.</span>}</Step>
      <Step n={7} label="Gameplay">{c.gameplay.length ? <span className="text-amber-hi">{c.gameplay.join('; ')}</span> : <span className="text-dim">—</span>}</Step>
      </div>}
    </article>
  )
}

// ── observer mode ──

function Observer() {
  const [days, setDays] = useState(7)
  const [raids, setRaids] = useState(8)
  const [fresh, setFresh] = useState(false)
  const sim = useMutation({ mutationFn: () => api.simulate(days * 24, fresh ? 2026 : undefined, raids) })
  const s: SimulationView | undefined = sim.data
  const factions = s ? Object.keys(s.series[0]?.factions ?? {}) : []
  return (
    <section className="relative border-2 border-dashed border-steel/60 bg-steel-lo/20 p-4" data-testid="observer">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="bg-steel px-2 py-0.5 font-display text-sm font-bold uppercase tracking-[0.2em] text-ink">Simulation</span>
        <h2 className="font-display text-xl font-bold uppercase tracking-wider text-fog">Observer Mode</h2>
        <p className="w-full text-sm text-muted">Runs a copy of the economy forward with the deterministic agents and simulated raiders. Nothing here is live, nothing is saved, and nothing settles on NEAR.</p>
      </div>
      <div className="flex flex-wrap items-end gap-4 text-sm">
        <label className="grid gap-1"><span className="cz-label !text-[10px]">Days</span>
          <select value={days} onChange={(e) => setDays(+e.target.value)} className="border border-line bg-panel px-2 py-1">{[3, 7, 14].map((d) => <option key={d} value={d}>{d}</option>)}</select></label>
        <label className="grid gap-1"><span className="cz-label !text-[10px]">Raid chance / hour</span>
          <select value={raids} onChange={(e) => setRaids(+e.target.value)} className="border border-line bg-panel px-2 py-1">{[0, 4, 8, 20].map((d) => <option key={d} value={d}>{d}%</option>)}</select></label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} /> From a fresh world (seed 2026) instead of now</label>
        <button className="cz-btn cz-btn-ghost px-4 py-1.5" onClick={() => sim.mutate()} disabled={sim.isPending}>{sim.isPending ? 'Simulating…' : 'Run simulation'}</button>
      </div>
      {sim.isError && <p className="mt-3 text-sm text-hostile">{(sim.error as Error).message}</p>}
      {s && (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <div className="cz-label mb-1 !text-[10px]">Simulated treasuries</div>
            <Lines series={[...factions.map((f) => ({ label: f, color: color(f), values: s.series.map((p) => p.factions[f]?.holdings.credits ?? 0) })), { label: 'vex', color: color('vex'), values: s.series.map((p) => p.merchant.credits) }]} />
          </div>
          <div>
            <div className="cz-label mb-1 !text-[10px]">Simulated mid prices</div>
            <Lines series={RES.map((r) => ({ label: r, color: RES_COLOR[r], values: s.series.map((p) => p.prices[r]) }))} />
          </div>
          <div className="flex flex-wrap gap-6 md:col-span-2">
            <Stat label="Simulated hours" value={s.ticks} />
            <Stat label="Agent decisions" value={s.decisions.filter((d) => d.validation === 'accepted').length} hint="accepted" />
            <Stat label="Simulated raids" value={s.simulated_raids.length} hint={`${s.simulated_raids.filter((r) => r.extracted).length} extracted`} />
            <Stat label="Shortage hours" value={s.series.filter((p) => p.shortages > 0).length} />
            <Stat label="Conservation" value={s.conserved ? 'holds' : 'BROKEN'} hint="every unit accounted for" />
          </div>
          <div className="max-h-48 overflow-y-auto text-xs text-muted md:col-span-2">
            {s.decisions.filter((d) => d.validation === 'accepted').slice(-12).reverse().map((d, i) => (
              <div key={i}><span className="text-dim">{clock(d.tick)}</span> <span style={{ color: color(d.actor) }}>{d.actor}</span>: {d.rationale}</div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

// ── page ──

export default function WarRoom() {
  const v = useQuery({ queryKey: ['warroom'], queryFn: () => api.warRoom(96), refetchInterval: 5_000 })
  const t = useQuery({ queryKey: ['timeline'], queryFn: () => api.timeline(30), refetchInterval: 5_000 })
  const [filter, setFilter] = useState<'strategic' | 'all' | 'llm' | 'operations'>('strategic')
  // Routine top-ups (small trades with the merchant) are real but drown the story.
  const routine = (c: CausalChain) => c.kind === 'decision' && !c.proposal.planner.startsWith('llm:') && c.proposal.action?.action === 'trade' && Number(c.proposal.action.limit_total ?? 0) < 200
  const chains = useMemo(() => (t.data ?? []).filter((c) => filter === 'all' || (filter === 'strategic' ? !routine(c) : filter === 'llm' ? c.proposal.planner.startsWith('llm:') : c.kind === 'operation')), [t.data, filter])
  const hidden = filter === 'strategic' ? (t.data ?? []).filter(routine).length : 0
  const d = v.data

  return (
    <Shell title="War Room" back={{ href: '/', label: 'Hub' }} wide>
      {v.isError && <p className="text-hostile">The economy server is not reachable.</p>}
      {d && (
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted">
            <span className="font-display text-lg font-bold text-fog">{clock(d.world.tick)}</span>
            <span>{d.world.contracts.length} open contract{d.world.contracts.length === 1 ? '' : 's'} · {d.world.contracts_paid} paid out</span>
            <span>Settlement: <span className="text-friendly">{d.settlement.confirmed ?? 0} on NEAR</span> · {(d.settlement.pending ?? 0) + (d.settlement.submitted ?? 0)} in flight{d.settlement.failed ? <span className="text-hostile"> · {d.settlement.failed} failed</span> : null}</span>
            <span>Planner: {d.planner.configured ? <span className="text-steel">NEAR AI{d.planner.last_call ? ` · last call ${clock(d.planner.last_call.tick)}, ${d.planner.last_call.latency_ms} ms` : ''}</span> : <span>deterministic policy (NEAR AI key not set)</span>}</span>
            {d.world.merchant_insolvent && <span className="text-hostile">Vex is out of credits</span>}
          </div>

          <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
            <Panel title="Region">
              <RegionMap v={d} />
            </Panel>
            <Panel title="Vex Exchange prices">
              <div className="grid gap-3">
                {d.world.prices.map((p) => (
                  <div key={p.resource} className="grid gap-1">
                    <div className="flex items-baseline justify-between text-sm">
                      <span className="text-fog">{RESOURCE_LABEL[p.resource]}</span>
                      <span className="cz-num text-muted">ask <span className="text-fog">{p.ask}</span> · bid <span className="text-fog">{p.bid}</span></span>
                    </div>
                    <Spark values={d.history.map((h) => h.prices[p.resource]?.ask ?? p.ask)} stroke={RES_COLOR[p.resource]} w={280} />
                    <div className="text-xs text-dim">shelf {p.stock} / target {p.target}</div>
                  </div>
                ))}
                <p className="text-xs text-dim">Last {d.history.length} hours.</p>
              </div>
            </Panel>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            {[...d.world.actors].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'faction' ? -1 : 1)).map((a) => <ActorCard key={a.id} a={a} v={d} />)}
          </div>

          <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
            <section>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h2 className="cz-label">Why the world changed</h2>
                <span className="text-xs text-dim">trigger → observed → proposal → validation → transaction → world → gameplay</span>
                <div className="ml-auto flex gap-1 text-xs">
                  {(['strategic', 'all', 'llm', 'operations'] as const).map((f) => (
                    <button key={f} onClick={() => setFilter(f)} className={`px-2 py-1 ${filter === f ? 'bg-amber/15 text-amber-hi' : 'text-muted hover:text-fog'}`}>{f === 'llm' ? 'NEAR AI' : f}</button>
                  ))}
                </div>
              </div>
              <div className="grid gap-2">
                {chains.map((c, i) => <ChainCard key={c.seq} c={c} initiallyOpen={i < 2} />)}
                {t.data && chains.length === 0 && <Panel><p className="text-sm text-muted">{filter === 'llm' ? 'No NEAR AI decisions yet. Set NEAR_AI_API_KEY on the server to turn on the strategic planner; the deterministic policy runs either way.' : 'Nothing yet.'}</p></Panel>}
              </div>
              {hidden > 0 && <button className="mt-2 text-xs text-muted hover:text-fog" onClick={() => setFilter('all')}>{hidden} routine trade{hidden === 1 ? '' : 's'} under 200 cr hidden · show all</button>}
              <p className="mt-2 text-xs text-dim">The gameplay line is a fixed rule per event type, not model output. Only “Settled on NEAR” means a confirmed transaction.</p>
            </section>
            <Panel title="Faction broadcasts">
              {d.broadcasts.length ? (
                <div className="grid gap-3">
                  {d.broadcasts.map((b, i) => (
                    <blockquote key={i} className="border-l-2 pl-3 text-sm" style={{ borderColor: color(b.actor) }}>
                      <div className="text-fog">“{b.text}”</div>
                      <div className="text-xs text-dim">{b.actor} · {clock(b.tick)} · {b.model}</div>
                    </blockquote>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted">Silence on the radio. Factions broadcast only when the NEAR AI planner is running.</p>
              )}
            </Panel>
          </div>

          <Observer />
        </div>
      )}
    </Shell>
  )
}
