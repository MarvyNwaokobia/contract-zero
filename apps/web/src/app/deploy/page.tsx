'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { Rajdhani } from 'next/font/google'
import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useMemo, useState } from 'react'
import { Panel, Shell, Stat } from '@/components/ui/Shell'
import { buildConvoyMission } from '@/engine/fps/convoy'
import { GUN_CATALOG, gunDps, type GunId } from '@/engine/combat/GunStats'
import type { ContractRunStats } from '@/engine/scene/ContractZeroScene'
import { api, loadPlayer, RESOURCE_LABEL, type BoardEntry, type MissionResult, type MissionStart, type ResourceName, type WorldView } from '@/lib/api'
import { retryImport } from '@/lib/retryImport'

const tactical = Rajdhani({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-tactical', display: 'swap' })

const ContractZeroScene = dynamic(
  () => retryImport(() => import('@/engine/scene/ContractZeroScene')).then((m) => m.ContractZeroScene),
  { ssr: false, loading: () => <div className="fixed inset-0 bg-black" /> },
)
const GunTurntable = dynamic(() => import('@/components/armory/GunTurntable'), { ssr: false })

/** Standard issue until the Armory sells gear. */
const ISSUE: GunId[] = ['smg', 'assault_rifle', 'marksman']

type Phase =
  | { kind: 'loadout' }
  | { kind: 'starting' }
  | { kind: 'fighting'; start: MissionStart; before: WorldView }
  | { kind: 'reporting' }
  | { kind: 'results'; result: MissionResult; before: WorldView; after: WorldView }
  | { kind: 'error'; message: string }

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`

function guardsLine(e?: BoardEntry) {
  if (!e) return 'no depot (not worth raiding, or no fuel to stage it)'
  const g = e.guards
  return `${plural(g.hall.rifles + g.yard.rifles, "rifle")}, ${plural(g.hall.sidearms + g.yard.sidearms, "sidearm")}, ${g.reinforce_per_drop} reinforcements per wave, defense L${e.defense}`
}

function Deploy() {
  const params = useSearchParams()
  const target = params.get('target') ?? 'vanguard'
  const resource = (params.get('resource') ?? 'ammo') as ResourceName
  const [player, setPlayer] = useState<string | null>(null)
  const [gun, setGun] = useState<GunId>('assault_rifle')
  const [phase, setPhase] = useState<Phase>({ kind: 'loadout' })
  useEffect(() => { setPlayer(loadPlayer()) }, [])

  const deploy = async () => {
    if (!player) return
    setPhase({ kind: 'starting' })
    try {
      const before = await api.world()
      const start = await api.startMission(player, target, resource)
      setPhase({ kind: 'fighting', start, before })
    } catch (e) {
      setPhase({ kind: 'error', message: (e as Error).message })
    }
  }

  const finish = async (outcome: 'extracted' | 'killed', stats: ContractRunStats, start: MissionStart, before: WorldView) => {
    if (!player) return
    setPhase({ kind: 'reporting' })
    try {
      const { result } = await api.completeMission(start.session, player, outcome, stats.kills)
      // Give the world clock a moment so the agents' response is visible.
      const after = await api.world()
      setPhase({ kind: 'results', result, before, after })
    } catch (e) {
      setPhase({ kind: 'error', message: (e as Error).message })
    }
  }

  const mission = useMemo(() => (phase.kind === 'fighting' ? buildConvoyMission(phase.start.mission, gun) : null), [phase, gun])

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
      <Shell title="Deploy" back={{ href: '/', label: 'Main Menu' }}>
        <Panel><p>Set your operator account on the <Link href="/" className="text-cyan-400">Main Menu</Link> first.</p></Panel>
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
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Extracted" value={`${result.extracted_units} ${result.resource}`} />
            <Stat label="Bounty" value={`${result.bounty} cr`} />
            <Stat label="Mission time" value={`${Math.round(result.elapsed_secs)} s`} hint={`minimum ${result.min_secs} s`} />
            <Stat label="You now hold" value={`${result.player_holdings.cargo} ${result.resource}`} hint={`${result.player_holdings.credits} credits`} />
          </div>
        </Panel>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Panel title="WHAT IT DID TO VANGUARD">
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
          <Link href="/contracts" className="rounded bg-cyan-500 px-5 py-2 text-sm font-semibold text-slate-950">Back to the board</Link>
          <Link href="/" className="rounded border border-slate-700 px-5 py-2 text-sm">Main Menu</Link>
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
                  className={`rounded border px-4 py-3 text-left ${gun === id ? 'border-cyan-500 bg-cyan-950/30' : 'border-slate-800 hover:bg-slate-900'}`}
                >
                  <div className="font-semibold text-slate-100">{g.name}</div>
                  <div className="text-xs text-slate-500">damage {g.damage} · {g.fireRate} rpm · mag {g.magazine} · {Math.round(gunDps(g))} dps</div>
                </button>
              )
            })}
            <p className="text-xs text-slate-500">Standard issue. Owned gear arrives with the Exchange.</p>
          </div>
          <div className="h-56 rounded border border-slate-800 bg-slate-950"><GunTurntable gunId={gun} className="h-full w-full" /></div>
        </div>
      </Panel>
      {phase.kind === 'error' && <p className="mt-4 text-sm text-rose-400">Could not deploy: {phase.message}</p>}
      <button
        onClick={deploy}
        disabled={phase.kind === 'starting' || phase.kind === 'reporting'}
        className="mt-6 rounded bg-cyan-500 px-6 py-3 font-semibold text-slate-950 disabled:opacity-50"
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
