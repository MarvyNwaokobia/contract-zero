'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { Rajdhani } from 'next/font/google'
import { useSearchParams } from 'next/navigation'
import { Suspense, useMemo, useState } from 'react'
import { Briefing, Debrief } from '@/components/story/Briefing'
import type { MissionStory } from '@/engine/story/presence'
import { Panel, Shell, Stat } from '@/components/ui/Shell'
import { buildOperationMission } from '@/engine/fps/convoy'
import { GUN_CATALOG, gunDps, type GunId } from '@/engine/combat/GunStats'
import type { ContractRunStats } from '@/engine/scene/ContractZeroScene'
import { useQuery } from '@tanstack/react-query'
import { useSession } from '@/lib/useSession'
import { api, RESOURCE_LABEL, type OpKind, type BoardEntry, type MissionResult, type MissionStart, type ResourceName, type WorldView } from '@/lib/api'
import { retryImport } from '@/lib/retryImport'

const tactical = Rajdhani({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-tactical', display: 'swap' })

const ContractZeroScene = dynamic(
  () => retryImport(() => import('@/engine/scene/ContractZeroScene')).then((m) => m.ContractZeroScene),
  { ssr: false, loading: () => <div className="fixed inset-0 bg-black" /> },
)
const GunTurntable = dynamic(() => import('@/components/armory/GunTurntable'), { ssr: false })

/** Standard issue until the Armory sells gear. */
const ISSUE: GunId[] = ['smg', 'assault_rifle']

type Phase =
  | { kind: 'loadout' }
  | { kind: 'starting' }
  | { kind: 'briefing'; start: MissionStart; before: WorldView; story: MissionStory | null }
  | { kind: 'fighting'; start: MissionStart; before: WorldView; story: MissionStory | null }
  | { kind: 'reporting' }
  | { kind: 'results'; result: MissionResult; before: WorldView; after: WorldView }
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
  const [phase, setPhase] = useState<Phase>({ kind: 'loadout' })

  const deploy = async () => {
    if (!player) return
    setPhase({ kind: 'starting' })
    try {
      const before = await api.world()
      const start = await api.startMission(target, resource, kind, gun)
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

  const finish = async (outcome: 'extracted' | 'killed', stats: ContractRunStats, start: MissionStart, before: WorldView) => {
    if (!player) return
    setPhase({ kind: 'reporting' })
    try {
      const { result } = await api.completeMission(start.session, outcome, stats.kills)
      // Give the world clock a moment so the agents' response is visible.
      const after = await api.world()
      setPhase({ kind: 'results', result, before, after })
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
    return <Briefing story={shown} pending={!story} onDeploy={() => setPhase({ kind: 'fighting', start, before, story: shown })} />
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
    const { result, before, after } = phase
    const vgBefore = before.actors.find((a) => a.id === result.target)
    const vgAfter = after.actors.find((a) => a.id === result.target)
    const nextBefore = before.board.find((b) => b.target === result.target && b.resource === result.resource)
    const nextAfter = after.board.find((b) => b.target === result.target && b.resource === result.resource)
    const won = result.outcome === 'extracted'
    return (
      <Shell title="Extraction Results" back={{ href: '/contracts', label: 'Contract Board' }}>
        <Panel>
          <div className={`text-2xl font-bold ${won ? 'text-emerald-400' : 'text-rose-400'}`}>
            {won ? 'CARGO EXTRACTED' : result.outcome === 'killed' ? 'KILLED IN ACTION' : 'RUN REJECTED'}
          </div>
          {result.reason && <p className="mt-1 text-sm text-amber-400">The server rejected the run: {result.reason}.</p>}
          {result.settlement && <div className="mt-2"><SettlementStatus opId={result.settlement.op_id} /></div>}
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Extracted" value={`${result.extracted_units} ${result.resource}`} />
            <Stat label="Bounty" value={`${result.bounty} cr`} />
            <Stat label="Mission time" value={`${Math.round(result.elapsed_secs)} s`} hint={`minimum ${result.min_secs} s`} />
            <Stat label="You now hold" value={`${result.player_holdings.cargo} ${result.resource}`} hint={`${result.player_holdings.credits} credits`} />
          </div>
        </Panel>
        {result.debrief && result.debrief.length > 0 && (
          <Panel title={result.codename ? `DEBRIEF · ${result.codename}` : 'DEBRIEF'} className="mt-4">
            <Debrief lines={result.debrief} />
          </Panel>
        )}
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Panel title={`WHAT IT DID TO ${(vgAfter?.name ?? result.target).toUpperCase()}`}>
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
        </div>
        <div className="mt-6 flex gap-3">
          <Link href="/contracts" className="cz-btn cz-btn-primary px-5 py-2 text-sm">Back to the board</Link>
          <Link href="/" className="cz-btn cz-btn-ghost px-5 py-2 text-sm">Hub</Link>
        </div>
      </Shell>
    )
  }

  return (
    <Shell title="Armory · Loadout" back={{ href: '/contracts', label: 'Contract Board' }}>
      <Panel title={`TARGET · ${target.toUpperCase()} · ${RESOURCE_LABEL[resource].toUpperCase()} DEPOT`}>
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
            <p className="text-xs text-slate-500">SMG and assault rifle are standard issue. Owned guns are tokens in your account; <Link href="/exchange" className="text-amber-hi hover:underline">Vex&apos;s armory</Link> sells them.</p>
          </div>
          <div className="h-56 border border-line" style={{ background: 'radial-gradient(ellipse at 50% 55%, #23272e 0%, #0e1013 70%)' }}><GunTurntable gunId={gun} className="h-full w-full" /></div>
        </div>
      </Panel>
      {phase.kind === 'error' && <p className="mt-4 text-sm text-rose-400">Could not deploy: {phase.message}</p>}
      <button
        onClick={deploy}
        disabled={phase.kind === 'starting' || phase.kind === 'reporting'}
        className="cz-btn cz-btn-primary mt-6 px-6 py-3"
      >
        {phase.kind === 'starting' ? 'Locking in the mission…' : phase.kind === 'reporting' ? 'Reporting to command…' : 'Deploy'}
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
