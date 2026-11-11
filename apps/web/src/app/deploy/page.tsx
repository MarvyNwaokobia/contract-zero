'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { Rajdhani } from 'next/font/google'
import { useSearchParams } from 'next/navigation'
import { Suspense, useMemo, useState } from 'react'
import { Briefing, Debrief } from '@/components/story/Briefing'
import { ScreenTip } from '@/components/help/ScreenTip'
import { ConsequenceTip } from '@/components/help/ConsequenceTip'
import type { MissionStory } from '@/engine/story/presence'
import { Panel, Shell, Stat } from '@/components/ui/Shell'
import { buildOperationMission } from '@/engine/fps/convoy'
import { GUN_CATALOG, gunDps, type GunId } from '@/engine/combat/GunStats'
import type { ContractRunStats } from '@/engine/scene/ContractZeroScene'
import { useQuery } from '@tanstack/react-query'
import { useSession } from '@/lib/useSession'
import { api, RESOURCE_LABEL, type OpKind, type BoardEntry, type MissionResult, type MissionStart, type ResourceName, type WorldView } from '@/lib/api'
import { OperationIntel } from '@/components/world/OperationIntel'
import { ReadinessSummary, useReadinessData } from '@/components/world/Readiness'
import { ConsequencePanel } from '@/components/world/Consequence'
import { useMusicState } from '@/components/audio/AudioProvider'
import { WorldClockPanel } from '@/components/world/WorldClock'
import { MissionStream } from '@/lib/missionStream'
import { ItemInspector } from '@/components/inspect/ItemInspector'
import type { InspectItem } from '@/components/inspect/itemInfo'
import { retryImport } from '@/lib/retryImport'

const tactical = Rajdhani({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-tactical', display: 'swap' })

const ContractZeroScene = dynamic(
  () => retryImport(() => import('@/engine/scene/ContractZeroScene')).then((m) => m.ContractZeroScene),
  { ssr: false, loading: () => <div className="fixed inset-0 bg-black" /> },
)
const GunTurntable = dynamic(() => import('@/components/armory/GunTurntable'), { ssr: false })

/** Standard issue until the Armory sells gear. */
const ISSUE: GunId[] = ['smg', 'assault_rifle']

// The flow: what the job is (intel) → accept, and the sponsor's briefing → choose a
// weapon → fight → results. The weapon comes last so you choose it for the job.
type Phase =
  | { kind: 'intel' }
  | { kind: 'starting' }
  | { kind: 'briefing'; start: MissionStart; before: WorldView; story: MissionStory | null }
  | { kind: 'loadout'; start: MissionStart; before: WorldView; story: MissionStory | null; error?: string }
  | { kind: 'arming'; start: MissionStart; before: WorldView; story: MissionStory | null }
  | { kind: 'fighting'; start: MissionStart; before: WorldView; story: MissionStory | null }
  | { kind: 'reporting' }
  | { kind: 'results'; session: string; result: MissionResult; before: WorldView; after: WorldView }
  | { kind: 'error'; message: string }

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`

function guardsLine(e?: BoardEntry) {
  if (!e) return 'no depot (not worth raiding, or no fuel to stage it)'
  const g = e.guards
  return `${plural(g.hall.rifles + g.yard.rifles, "rifle")}, ${plural(g.hall.sidearms + g.yard.sidearms, "sidearm")}, ${g.reinforce_per_drop} reinforcements per wave, defense L${e.defense}`
}

/** Shows on-chain settlement only once it is confirmed (verified FINAL on NEAR). */
function SettlementStatus({ opId }: { opId: string }) {
  const q = useQuery({
    queryKey: ['settlement', opId],
    queryFn: () => api.settlement(opId),
    refetchInterval: (query) => (query.state.data && ['confirmed', 'failed', 'compensated'].includes(query.state.data.status) ? false : 3000),
  })
  const s = q.data
  if (!s || !s.settled_on_chain) {
    if (s && (s.status === 'failed' || s.status === 'compensated')) {
      return <p className="text-sm text-rose-400">On-chain settlement failed: {s.error}</p>
    }
    return <p className="text-sm text-slate-400">Settling on NEAR… ({s?.status ?? 'queued'}). Not settled until confirmed.</p>
  }
  return (
    <p className="text-sm text-emerald-400">
      Settled on NEAR testnet:{' '}
      {s.explorer.map((url, i) => (
        <a key={url} href={url} target="_blank" rel="noreferrer" className="underline">{s.tx_hashes[i].slice(0, 10)}…</a>
      ))}
    </p>
  )
}

function Deploy() {
  const params = useSearchParams()
  const target = params.get('target') ?? 'vanguard'
  const resource = (params.get('resource') ?? 'ammo') as ResourceName
  const kind = (params.get('kind') ?? 'raid') as OpKind
  const { session, loading } = useSession()
  const player = session?.account ?? null
  const [gun, setGun] = useState<GunId>('assault_rifle')
  const armory = useQuery({ queryKey: ['armory', player], queryFn: () => api.exchange(player).then((e) => e.armory ?? []), enabled: !!player })
  const [phase, setPhase] = useState<Phase>({ kind: 'intel' })
  // The score follows the flow: preparation up to the fight, the fight drives its own, results resolve it.
  useMusicState(phase.kind === 'fighting' || phase.kind === 'reporting' || phase.kind === 'error' ? null : phase.kind === 'results' ? 'results' : 'prep')
  const [inspect, setInspect] = useState<InspectItem | null>(null)
  const world = useQuery({ queryKey: ['world'], queryFn: api.world, refetchInterval: 10_000, enabled: phase.kind === 'intel' })
  const entry = world.data?.board.find((b) => b.kind === kind && b.target === target && b.resource === resource)
  const readiness = useReadinessData(phase.kind === 'intel')
  const targetActor = entry ? readiness.actor(entry.target) : undefined

  const accept = async () => {
    if (!player) return
    setPhase({ kind: 'starting' })
    try {
      const before = await api.world()
      const start = await api.startMission(target, resource, kind)
      setPhase({ kind: 'briefing', start, before, story: null })
      // The voiced story when the server has a model (checked line by line), else
      // the authored one it started with. Never wait more than 12 s for it.
      const authored = start.story ?? null
      const voiced = await Promise.race([
        api.missionStory(start.session).catch(() => authored),
        new Promise<MissionStory | null>((r) => setTimeout(() => r(authored), 12_000)),
      ])
      setPhase((p) => (p.kind === 'briefing' && p.start.session === start.session ? { ...p, story: voiced ?? authored } : p))
    } catch (e) {
      setPhase({ kind: 'error', message: (e as Error).message })
    }
  }

  // The weapon is checked against the ledger again here: you can't carry in a gun you don't own.
  const arm = async () => {
    if (phase.kind !== 'loadout') return
    const p = phase
    setPhase({ ...p, kind: 'arming' })
    try {
      await api.missionLoadout(p.start.session, gun)
      setPhase({ kind: 'fighting', start: p.start, before: p.before, story: p.story })
    } catch (e) {
      setPhase({ ...p, kind: 'loadout', error: (e as Error).message })
    }
  }

  // The server checks the run from this stream; completion settles from its account.
  const stream = useMemo(() => (phase.kind === 'fighting' ? new MissionStream(phase.start.session) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [phase.kind === 'fighting' ? phase.start.session : null])

  const finish = async (outcome: 'extracted' | 'killed', stats: ContractRunStats, start: MissionStart, before: WorldView) => {
    if (!player) return
    setPhase({ kind: 'reporting' })
    try {
      await stream?.flush()
      // Object ids only: the server counts the units from its own manifest.
      const { result } = await api.completeMission(start.session, outcome, stats.kills, outcome === 'extracted' ? stats.record : undefined)
      // Give the world clock a moment so the agents' response is visible.
      const after = await api.world()
      setPhase({ kind: 'results', session: start.session, result, before, after })
    } catch (e) {
      setPhase({ kind: 'error', message: (e as Error).message })
    }
  }

  const mission = useMemo(() => {
    if (phase.kind !== 'fighting') return null
    const m = buildOperationMission(phase.start.mission, gun)
    return phase.story ? { ...m, radio: phase.story.radio } : m
  }, [phase, gun])

  if (phase.kind === 'briefing') {
    const { start, before, story } = phase
    // An older server sends no story: brief from the contract alone.
    const shown: MissionStory = story ?? start.story ?? {
      codename: `${kind.toUpperCase()} · ${target.toUpperCase()}`, location: start.mission.zone ?? 'DUSTLINE', time: '', source: 'authored', radio: {},
      briefing: [{ id: 'fallback', speaker: 'handler', text: `${start.mission.cargo.units} units of ${RESOURCE_LABEL[resource].toLowerCase()} at ${target}'s site. Get in, do the job, get out.` }],
    }
    return <Briefing story={shown} pending={!story} actionLabel="Choose loadout" onDeploy={() => setPhase({ kind: 'loadout', start, before, story: shown })} />
  }

  if (phase.kind === 'fighting' && mission) {
    const { start, before } = phase
    return (
      <div className={tactical.variable} style={{ position: 'fixed', inset: 0 }}>
        <ContractZeroScene
          contract={{
            mission,
            onExtracted: (s) => finish('extracted', s, start, before),
            onKilled: (s) => finish('killed', s, start, before),
            onProtocol: (evs) => stream?.push(evs),
          }}
        />
      </div>
    )
  }

  if (!player) {
    return (
      <Shell title="Deploy" back={{ href: '/', label: 'Hub' }}>
        <Panel><p>{loading ? 'Checking your sign-in…' : <><Link href="/signin" className="text-amber-hi">Sign in</Link> to take contracts.</>}</p></Panel>
      </Shell>
    )
  }

  if (phase.kind === 'results') {
    const { result, before, after, session } = phase
    const vgBefore = before.actors.find((a) => a.id === result.target)
    const vgAfter = after.actors.find((a) => a.id === result.target)
    const nextBefore = before.board.find((b) => b.target === result.target && b.resource === result.resource)
    const nextAfter = after.board.find((b) => b.target === result.target && b.resource === result.resource)
    const won = result.outcome === 'extracted'
    return (
      <Shell title="Extraction Results" back={{ href: '/contracts', label: 'Contract Board' }}>
        <Panel>
          <div className={`text-2xl font-bold ${won ? 'text-emerald-400' : 'text-rose-400'}`}>
            {won ? (result.kind === 'sabotage' ? 'LINE DESTROYED' : result.kind === 'recovery' ? 'CARGO HANDED OVER' : 'CARGO EXTRACTED') : result.outcome === 'killed' ? 'KILLED IN ACTION · NOTHING SECURED' : 'RUN REJECTED'}
          </div>
          {result.reason && <p className="mt-1 text-sm text-amber-400">The server rejected the run: {result.reason}.</p>}
          {result.settlement && <div className="mt-2"><SettlementStatus opId={result.settlement.op_id} /></div>}
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label={result.kind === 'sabotage' ? 'Destroyed' : result.kind === 'recovery' ? 'Returned' : 'Extracted'} value={`${result.extracted_units} ${result.resource}`}
              hint={result.kind === 'raid' && result.record ? `${result.record.secured.length} case${result.record.secured.length === 1 ? '' : 's'} carried out of ${result.manifest ?? '?'} units on site` : result.kind === 'sabotage' && result.record ? `${result.record.charges.length} charges set` : undefined} />
            <Stat label="Bounty" value={`${result.bounty} cr`} />
            <Stat label="Mission time" value={`${Math.round(result.elapsed_secs)} s`} hint={`minimum ${result.min_secs} s`} />
            <Stat label="You now hold" value={`${result.player_holdings.cargo} ${result.resource}`} hint={`${result.player_holdings.credits} credits`} />
          </div>
        </Panel>
        {won && <ConsequenceTip target={vgAfter?.name ?? result.target} />}
        {result.debrief && result.debrief.length > 0 && (
          <Panel title={result.codename ? `DEBRIEF · ${result.codename}` : 'DEBRIEF'} className="mt-4">
            <Debrief lines={result.debrief} />
          </Panel>
        )}
        <ConsequencePanel session={session} result={result} />
        {/* Sessions from before recording have no snapshot: fall back to this browser's two
            reads of the world, labelled as such. */}
        {!result.consequence && <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Panel title={`FROM THIS BROWSER: ${(vgAfter?.name ?? result.target).toUpperCase()} BEFORE AND AFTER`}>
            {vgBefore && vgAfter && (
              <div className="grid grid-cols-3 gap-3">
                {(['ammo', 'med', 'fuel'] as const).map((r) => (
                  <Stat key={r} label={RESOURCE_LABEL[r]} value={`${vgBefore.holdings[r]} → ${vgAfter.holdings[r]}`} />
                ))}
              </div>
            )}
          </Panel>
          <Panel title="THE NEXT RAID ON THIS DEPOT">
            <p className="text-sm text-slate-400">Before: {guardsLine(nextBefore)}</p>
            <p className="mt-1 text-sm text-slate-100">Now: {guardsLine(nextAfter)}</p>
            <p className="mt-2 text-xs text-slate-500">The commander reacts on the next world tick; check the board again in a minute.</p>
          </Panel>
        </div>}
        <div className="mt-6 flex gap-3">
          <Link href="/contracts" className="cz-btn cz-btn-primary px-5 py-2 text-sm">Back to the board</Link>
          <Link href="/" className="cz-btn cz-btn-ghost px-5 py-2 text-sm">Hub</Link>
        </div>
      </Shell>
    )
  }

  if (phase.kind === 'intel' || phase.kind === 'starting') {
    return (
      <Shell title="Contract Intel" back={{ href: '/contracts', label: 'Contract Board' }} wide>
        <div className="mb-4"><WorldClockPanel clock={world.data?.clock} compact /></div>
        <ScreenTip tip="intel" title="Reading a contract">
          <p>The sponsor pays for what is <b className="text-fog">taken</b>, so the target&apos;s stock matters twice: it sets what is worth carrying out and how well its guards are armed.</p>
          <p>The readiness note on the target is its real stock turned into what you will meet: armed guards, reinforcements, and whether it can field a forward depot. Open “Exact figures” to see the numbers behind it.</p>
        </ScreenTip>
        {world.isLoading && <Panel><p className="text-muted">Pulling the contract…</p></Panel>}
        {world.data && !entry && <Panel><p className="text-muted">This contract is no longer on the board. The world moved on: <Link href="/contracts" className="text-amber-hi">see what&apos;s open now</Link>.</p></Panel>}
        {entry && (
          <OperationIntel
            contract={entry.mission}
            kind={kind}
            reward={{ fee: entry.bounty?.amount ?? 0, sponsor: entry.bounty?.sponsor_name, cargoValue: entry.market_value.bid }}
            targetBrief={targetActor ? <ReadinessSummary a={targetActor} inbound={readiness.inbound(targetActor.id)} ammoForGuards={entry.guards.ammo_available} /> : undefined}
          />
        )}
        <button onClick={accept} disabled={!entry || phase.kind === 'starting'} className="cz-btn cz-btn-primary mt-6 px-6 py-3" data-testid="accept-contract">
          {phase.kind === 'starting' ? 'Locking in the contract…' : 'Accept and get briefed'}
        </button>
        <p className="mt-2 text-xs text-dim">Accepting locks this plan in and opens a 30-minute deployment window. You choose your weapon after the briefing.</p>
      </Shell>
    )
  }

  if (phase.kind === 'error') {
    return (
      <Shell title="Deploy" back={{ href: '/contracts', label: 'Contract Board' }}>
        <Panel><p className="text-rose-400">Could not deploy: {phase.message}</p></Panel>
        <Link href="/contracts" className="cz-btn cz-btn-ghost mt-4 inline-block px-5 py-2 text-sm">Back to the board</Link>
      </Shell>
    )
  }

  if (phase.kind !== 'loadout' && phase.kind !== 'arming') {
    return <Shell title="Deploy"><Panel><p className="text-muted">Reporting to command…</p></Panel></Shell>
  }

  return (
    <Shell title="Armory · Loadout" back={{ href: '/contracts', label: 'Contract Board' }}>
      <Panel title={`${(phase.start.mission.site?.name ?? target).toUpperCase()} · ${phase.start.mission.site?.facility?.toUpperCase() ?? RESOURCE_LABEL[resource].toUpperCase()}`}>
        <div className="grid gap-4 md:grid-cols-[1fr_280px]">
          <div className="grid gap-2">
            {ISSUE.map((id) => {
              const g = GUN_CATALOG[id]
              return (
                <button
                  key={id}
                  onClick={() => setGun(id)}
                  className={`border px-4 py-3 text-left ${gun === id ? 'border-amber bg-amber/10' : 'border-line hover:bg-panel-2'}`}
                >
                  <div className="font-semibold text-slate-100">{g.name}</div>
                  <div className="text-xs text-slate-500">damage {g.damage} · {g.fireRate} rpm · mag {g.magazine} · {Math.round(gunDps(g))} dps</div>
                </button>
              )
            })}
            <div className="cz-label mt-2 !text-[10px]">Owned gear</div>
            {(armory.data ?? []).map((a) => {
              const id = a.id as GunId
              const g = GUN_CATALOG[id]
              const owned = a.owned > 0
              return (
                <button
                  key={a.id}
                  onClick={() => owned && setGun(id)}
                  disabled={!owned}
                  data-testid={`gear-${a.id}`}
                  className={`border px-4 py-3 text-left ${gun === id ? 'border-amber bg-amber/10' : owned ? 'border-line hover:bg-panel-2' : 'border-line/60 opacity-60'}`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-semibold text-slate-100">{a.title}</span>
                    {owned ? <span className="text-xs font-semibold uppercase tracking-wider text-friendly">Owned{a.owned > 1 ? ` ×${a.owned}` : ''}</span> : <span className="text-xs text-muted">{a.price.toLocaleString()} cr at the Exchange</span>}
                  </div>
                  {g && <div className="text-xs text-slate-500">damage {g.damage} · {g.fireRate} rpm · mag {g.magazine} · {Math.round(gunDps(g))} dps</div>}
                </button>
              )
            })}
            <button className="cz-btn cz-btn-ghost self-start px-3 py-1 text-xs" data-testid="inspect-loadout" onClick={() => {
              const a = (armory.data ?? []).find((x) => x.id === gun)
              setInspect({ type: 'weapon', gun, status: a ? (a.owned > 0 ? 'owned' : 'locked') : 'standard', owned: a?.owned, price: a?.price ?? null })
            }}>Inspect the selected weapon</button>
            {inspect && <ItemInspector item={inspect} onClose={() => setInspect(null)} />}
            <p className="text-xs text-slate-500">SMG and assault rifle are standard issue. Owned guns are tokens in your account; <Link href="/exchange" className="text-amber-hi hover:underline">Vex&apos;s armory</Link> sells them.</p>
          </div>
          <div className="h-56 border border-line" style={{ background: 'radial-gradient(ellipse at 50% 55%, #23272e 0%, #0e1013 70%)' }}><GunTurntable gunId={gun} className="h-full w-full" /></div>
        </div>
      </Panel>
      {phase.kind === 'loadout' && phase.error && <p className="mt-4 text-sm text-rose-400">Could not arm: {phase.error}</p>}
      <button onClick={arm} disabled={phase.kind === 'arming'} className="cz-btn cz-btn-primary mt-6 px-6 py-3" data-testid="deploy">
        {phase.kind === 'arming' ? 'Checking your gear…' : 'Deploy'}
      </button>
    </Shell>
  )
}

export default function DeployPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#07090d]" />}>
      <Deploy />
    </Suspense>
  )
}
