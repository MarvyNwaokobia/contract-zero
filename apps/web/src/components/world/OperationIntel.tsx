'use client'

// Everything a contractor should know before choosing a weapon: where the job is,
// what the hour does there, the map, the objectives in order, who is defending it,
// what it pays, and what you go in with. Built from the same mission data the fight
// runs on, so the briefing and the operation can't disagree.

import { useMemo } from 'react'
import { buildOperationMission, conditionsFor, RESOURCE_LABEL as CARGO, type ConvoyContract, type OpKind } from '@/engine/fps/convoy'
import { CARRY_MAX, EXTRACT_SECS } from '@/engine/fps/field'
import { SiteMap } from './SiteMap'

const PHASE_LABEL = { day: 'Day', dusk: 'Dusk', night: 'Night' } as const

export function OperationIntel({ contract, kind, reward, practice = false }: {
  contract: ConvoyContract
  kind: OpKind
  /** What it pays: the bounty or fee, and the cargo's market value for a raid. */
  reward?: { fee: number; sponsor?: string | null; cargoValue?: number }
  practice?: boolean
}) {
  const mission = useMemo(() => buildOperationMission({ ...contract, kind }), [contract, kind])
  const cond = contract.conditions ?? conditionsFor('day')
  const site = contract.site
  const field = mission.field!
  const cases = field.items.filter((i) => i.kind === 'cargo_case').length
  const ammo = field.items.filter((i) => i.kind === 'ammo_crate').length
  const med = field.items.filter((i) => i.kind === 'med_case').length
  const enemies = mission.enemies
  const rifles = enemies.filter((e) => !e.dmgMult).length
  const reinforce = mission.objectives.find((o) => (o.reinforceCount ?? 0) > 0)
  const label = CARGO[contract.cargo.resource]
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]" data-testid="operation-intel">
      <div className="grid content-start gap-4">
        <section className="cz-panel p-4">
          <div className="cz-label !text-[10px] text-amber">{practice ? 'Practice · unscored' : 'Location'}</div>
          <div className="mt-1 font-display text-2xl font-bold uppercase tracking-wide" data-testid="intel-site">{site?.name ?? mission.site?.name}</div>
          <div className="text-sm text-muted">{[site?.region, site?.environment].filter(Boolean).join(' · ')}</div>
          <div className="mt-2 text-sm">Target: <span className="text-fog">the {site?.facility ?? 'depot'}</span>, held by {contract.target}</div>
          {site?.shared_layout && <p className="mt-2 text-xs text-amber-400">This site&apos;s own map isn&apos;t built yet; it plays on the Dustline Depot layout.</p>}
        </section>

        <section className="cz-panel p-4">
          <div className="cz-label !text-[10px]">Time and conditions</div>
          <div className="mt-1 grid gap-2 text-sm sm:grid-cols-2">
            <div><span className="text-fog" data-testid="intel-phase">{PHASE_LABEL[cond.phase]}</span>{cond.hour !== undefined && <span className="text-muted"> · {String(cond.hour).padStart(2, '0')}:00</span>} · {cond.lighting}</div>
            <div>{cond.patrol}</div>
            <div>Guards engage from {cond.sight_m} m, accuracy {Math.round(cond.accuracy_bp / 100)}% of daylight</div>
            <div>{cond.nvg ? 'Night vision issued (N)' : 'No night vision needed'}{cond.reinforce_bp !== 10_000 && ` · relief ${cond.reinforce_bp < 10_000 ? 'faster' : 'slower'} than usual`}</div>
          </div>
        </section>

        <section className="cz-panel p-4">
          <div className="cz-label !text-[10px]">Objectives</div>
          <ol className="mt-2 grid gap-1 text-sm" data-testid="intel-objectives">
            {mission.objectives.map((o, i) => (
              <li key={i} className="flex gap-3"><span className="w-5 shrink-0 text-right font-display font-bold text-amber">{i + 1}</span><span className="text-slate-200">{o.text}</span></li>
            ))}
          </ol>
          <p className="mt-3 text-xs text-muted">
            {kind === 'raid' && `${contract.cargo.units} units packed in ${cases} case${cases === 1 ? '' : 's'}. Hold E on a case to take it; you can carry ${CARRY_MAX}, and each one slows you. Only cases you carry through a completed extraction count.`}
            {kind === 'sabotage' && 'Hold E for five seconds on each target to set a charge. The fuse is short once both are set. Extraction opens after the second charge.'}
            {kind === 'recovery' && 'One sealed case, heavy enough to slow you. Hold E to free it, then carry it to the handover.'}
            {` At the zone, press E to call it in, then stay inside for ${EXTRACT_SECS} seconds. Leaving pauses the countdown; going down drops what you carry.`}
          </p>
        </section>

        <section className="grid gap-4 sm:grid-cols-2">
          <div className="cz-panel p-4">
            <div className="cz-label !text-[10px]">Expected resistance</div>
            <div className="mt-1 text-sm text-slate-200" data-testid="intel-resistance">{enemies.length} guards · {rifles} rifle{rifles === 1 ? '' : 's'}, {enemies.length - rifles} sidearm{enemies.length - rifles === 1 ? '' : 's'}</div>
            <div className="text-xs text-muted">Defense level {contract.defense} · guard health {enemies[0]?.hp ?? '–'}</div>
            <div className="text-xs text-muted">{reinforce ? `${reinforce.reinforceCount} reinforcement${reinforce.reinforceCount === 1 ? '' : 's'} every ${reinforce.reinforceEvery}s while you work` : 'No reinforcements (no medicine to patch them up)'}</div>
          </div>
          <div className="cz-panel p-4">
            <div className="cz-label !text-[10px]">Rewards</div>
            {practice ? <div className="mt-1 text-sm text-muted">None. Practice is never scored and never settles anything.</div> : (
              <div className="mt-1 grid gap-0.5 text-sm" data-testid="intel-rewards">
                {(reward?.fee ?? 0) > 0 ? <div className="text-fog">{reward!.fee} cr {kind === 'raid' ? 'bounty' : 'fee'}{reward?.sponsor ? ` from ${reward.sponsor}` : ''}</div> : <div className="text-muted">No bounty</div>}
                {kind === 'raid' && <div>The cargo: up to {contract.cargo.units} {label.toLowerCase()}{reward?.cargoValue ? ` (about ${reward.cargoValue} cr at Vex)` : ''}</div>}
                {kind === 'raid' && <div className="text-xs text-muted">The bounty pays when you bring out at least half the manifest.</div>}
                <div className="text-xs text-muted">Settled to your NEAR account after extraction.</div>
              </div>
            )}
          </div>
        </section>

        <section className="cz-panel p-4">
          <div className="cz-label !text-[10px]">You go in with</div>
          <div className="mt-1 text-sm text-slate-200">Your chosen weapon and a sidearm, {mission.reserveMags ?? 3} spare magazines each, {mission.medkits ?? 1} field dressing (H). Loose supplies on site: {ammo} ammunition crate{ammo === 1 ? '' : 's'}{med ? `, ${med} medical case${med === 1 ? '' : 's'}` : ', no medical cases (the faction holds no medicine)'}.</div>
          <div className="text-xs text-muted">Way out: {field.exfil?.label}.</div>
        </section>
      </div>
      <section className="cz-panel p-3">
        <div className="cz-label mb-2 !text-[10px]">Site map</div>
        <SiteMap layout={mission.level!} mission={mission} className="aspect-[3/4] w-full" />
      </section>
    </div>
  )
}
