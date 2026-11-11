'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { Rajdhani } from 'next/font/google'
import { useSearchParams } from 'next/navigation'
import { Suspense, useMemo, useState } from 'react'
import { Briefing } from '@/components/story/Briefing'
import { GunStatBars } from '@/components/armory/GunStatBars'
import { ScreenTip } from '@/components/help/ScreenTip'
import type { MissionStory } from '@/engine/story/presence'
import { Panel, Shell } from '@/components/ui/Shell'
import { buildOperationMission } from '@/engine/fps/convoy'
import { GUN_CATALOG, type GunId } from '@/engine/combat/GunStats'
import type { ContractRunStats } from '@/engine/scene/ContractZeroScene'
import { useQuery } from '@tanstack/react-query'
import { useSession } from '@/lib/useSession'
import { api, RESOURCE_LABEL, type OpKind, type MissionResult, type MissionStart, type ResourceName, type WorldView } from '@/lib/api'
import { OperationIntel } from '@/components/world/OperationIntel'
import { ReadinessSummary, useReadinessData } from '@/components/world/Readiness'
import { MissionResults } from '@/components/world/MissionResults'
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
    return <Briefing story={shown} pending={!story} contract={start.mission} kind={kind} pay={(before.board?.find((b) => b.target === target && b.resource === resource && b.kind === kind)?.bounty?.amount ?? 0) + (kind === 'raid' ? before.board?.find((b) => b.target === target && b.resource === resource && b.kind === kind)?.market_value.bid ?? 0 : 0)} actionLabel="Choose loadout" onDeploy={() => setPhase({ kind: 'loadout', start, before, story: shown })} />
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

  if (phase.kind === 'results') return <MissionResults result={phase.result} before={phase.before} after={phase.after} session={phase.session} />

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
        <div className="sticky bottom-0 z-20 -mx-4 mt-6 border-t border-line-strong bg-ink/95 px-4 py-3 backdrop-blur sm:-mx-0" data-testid="accept-bar">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <button onClick={accept} disabled={!entry || phase.kind === 'starting'} className="cz-btn cz-btn-primary px-6 py-3" data-testid="accept-contract">
              {phase.kind === 'starting' ? 'Locking in the contract…' : 'Accept and get briefed'}
            </button>
            <p className="min-w-0 flex-1 text-xs text-dim">Accepting locks this plan in and opens a 30-minute deployment window. You choose your weapon after the briefing.</p>
          </div>
        </div>
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

  const gp = phase.start.mission.guards
  const guardsIn = gp ? gp.hall.rifles + gp.hall.sidearms + gp.yard.rifles + gp.yard.sidearms : null
  const owned = new Map((armory.data ?? []).map((a) => [a.id, a]))
  const chosen = GUN_CATALOG[gun]
  const Card = ({ id, tag, tagTone, disabled = false }: { id: GunId; tag: string; tagTone: string; disabled?: boolean }) => (
    <button
      onClick={() => !disabled && setGun(id)} disabled={disabled} aria-pressed={gun === id} data-testid={owned.has(id) ? `gear-${id}` : `issue-${id}`}
      className={`border px-4 py-3 text-left ${gun === id ? 'border-amber bg-amber/10' : disabled ? 'border-line/60 opacity-60' : 'border-line hover:bg-panel-2'}`}
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-2"><span className="font-display font-bold uppercase tracking-wider text-fog">{GUN_CATALOG[id]?.name ?? id}</span><span className={`text-[11px] font-semibold uppercase tracking-wider ${tagTone}`}>{tag}</span></div>
      <GunStatBars gun={id} compact />
    </button>
  )
  return (
    <Shell title="Armory · Loadout" back={{ href: '/contracts', label: 'Contract Board' }} wide>
      <div className="grid gap-4 lg:grid-cols-[1fr_26rem]" data-testid="loadout">
        <div className="grid content-start gap-2">
          <div className="cz-label !text-[10px]">Standard issue</div>
          {ISSUE.map((id) => <Card key={id} id={id} tag="Issued" tagTone="text-steel" />)}
          <div className="cz-label mt-2 !text-[10px]">Owned gear · tokens in your account</div>
          {(armory.data ?? []).map((a) => {
            const have = a.owned > 0
            return <Card key={a.id} id={a.id as GunId} disabled={!have} tag={have ? `Owned${a.owned > 1 ? ` ×${a.owned}` : ''}` : `${a.price ?? ''} cr at Vex`} tagTone={have ? 'text-friendly' : 'text-muted'} />
          })}
          {armory.data?.length === 0 && <p className="text-sm text-muted">You own no gear yet.</p>}
          <p className="text-xs text-dim">SMG and assault rifle are standard issue. <Link href="/exchange" className="text-amber-hi hover:underline">Vex&apos;s armory</Link> sells the rest; what you buy stays yours.</p>
        </div>
        <aside className="cz-panel p-4 lg:sticky lg:top-4 lg:self-start" aria-label="Selected weapon">
          <div className="h-56 border border-line" style={{ background: 'radial-gradient(ellipse at 50% 55%, #23272e 0%, #0e1013 70%)' }}><GunTurntable gunId={gun} className="h-full w-full" /></div>
          <div className="mt-3 font-display text-2xl font-bold uppercase tracking-wide text-fog" data-testid="selected-gun">{chosen?.name ?? gun}</div>
          <div className="mt-2"><GunStatBars gun={gun} /></div>
          <p className="mt-2 text-[11px] text-dim">Each bar is measured against the best weapon in the game, with the real figure beside it.</p>
          <button className="cz-btn cz-btn-ghost mt-3 px-3 py-1 text-xs" data-testid="inspect-loadout" onClick={() => {
            const a = owned.get(gun)
            setInspect({ type: 'weapon', gun, status: a ? (a.owned > 0 ? 'owned' : 'locked') : 'standard', owned: a?.owned, price: a?.price ?? null })
          }}>Inspect the selected weapon</button>
          {inspect && <ItemInspector item={inspect} onClose={() => setInspect(null)} />}
          <div className="mt-3 border-t border-line pt-3 text-xs text-muted" data-testid="loadout-recap">Going in: <span className="text-fog">{phase.start.mission.site?.name ?? target}</span>{guardsIn != null ? <> · <span className="text-fog">{guardsIn} guards</span></> : null}. A sidearm and spare magazines come with any weapon.</div>
        </aside>
      </div>
      {phase.kind === 'loadout' && phase.error && <p className="mt-4 text-sm text-rose-400">Could not arm: {phase.error}</p>}
      <div className="sticky bottom-0 z-20 -mx-4 mt-6 border-t border-line-strong bg-ink/95 px-4 py-3 backdrop-blur sm:mx-0" data-testid="deploy-bar">
        <button onClick={arm} disabled={phase.kind === 'arming'} className="cz-btn cz-btn-primary px-6 py-3" data-testid="deploy">
          {phase.kind === 'arming' ? 'Checking your gear…' : `Deploy with ${chosen?.name ?? gun}`}
        </button>
      </div>
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
