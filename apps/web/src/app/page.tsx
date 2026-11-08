'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { TopBar } from '@/components/ui/Shell'
import { api, RESOURCE_LABEL, type ActorView, type BoardEntry, type ResourceName } from '@/lib/api'
import { loadSettings, type Quality } from '@/lib/settings'
import { useProfile, useSession, useStash } from '@/lib/useSession'

const HangarScene = dynamic(() => import('@/components/hub/HangarScene'), { ssr: false })

const RES: ResourceName[] = ['ammo', 'med', 'fuel']

/** The contract worth taking next: an open bounty first, then the richest cargo. */
function pickNext(board: BoardEntry[]): BoardEntry | null {
  return [...board].sort((a, b) => (b.bounty?.amount ?? 0) - (a.bounty?.amount ?? 0) || b.market_value.bid - a.market_value.bid)[0] ?? null
}

function target(a: ActorView, r: ResourceName) {
  return r === 'ammo' ? a.ammo_target : a.requirement[r]
}

function Meter({ label, have, want }: { label: string; have: number; want: number }) {
  const pct = Math.min(100, Math.round((100 * have) / Math.max(1, want)))
  const tone = pct < 50 ? 'bg-hostile' : pct < 90 ? 'bg-amber' : 'bg-friendly'
  return (
    <div>
      <div className="flex justify-between text-[11px] text-muted"><span className="uppercase tracking-wider">{label}</span><span className="cz-num">{have}/{want}</span></div>
      <div className="mt-1 h-1 bg-line"><div className={`h-1 ${tone}`} style={{ width: `${pct}%` }} /></div>
    </div>
  )
}

function NextOperation({ e, others, signedIn }: { e: BoardEntry; others: BoardEntry[]; signedIn: boolean }) {
  const g = e.guards
  const rifles = g.hall.rifles + g.yard.rifles
  const sidearms = g.hall.sidearms + g.yard.sidearms
  return (
    <section className="cz-panel cz-rise p-5">
      <div className="cz-label text-amber">Next operation</div>
      <div className="mt-1 font-display text-3xl font-bold uppercase leading-none tracking-wide">{e.kind === 'sabotage' ? `Sabotage: ${e.resource} line` : e.kind === 'recovery' ? `Recover seized ${e.resource}` : `${RESOURCE_LABEL[e.resource]} raid`}</div>
      <div className="mt-1 text-sm text-muted">{e.target_name} depot · Dustline · defense level {e.defense}</div>
      <div className="mt-4 grid grid-cols-3 gap-3">
        <div><div className="cz-label !text-[10px]">Cargo</div><div className="cz-num font-display text-xl font-bold">{e.manifest}</div><div className="text-xs text-muted">units of {e.resource}</div></div>
        <div><div className="cz-label !text-[10px]">Resale</div><div className="cz-num font-display text-xl font-bold text-amber-hi">{e.market_value.bid}</div><div className="text-xs text-muted">credits at Vex</div></div>
        <div><div className="cz-label !text-[10px]">Bounty</div><div className="cz-num font-display text-xl font-bold">{e.bounty ? e.bounty.amount : '—'}</div><div className="text-xs text-muted">{e.bounty ? `from ${e.bounty.sponsor_name}` : 'none posted'}</div></div>
      </div>
      <div className="mt-4 border-l-2 border-hostile/70 pl-3 text-sm">
        <div><span className="font-semibold text-fog">{rifles + sidearms} guards</span> <span className="text-muted">· {rifles} rifles{sidearms ? `, ${sidearms} sidearms` : ''} · HP {g.guard_hp}</span></div>
        <div className="text-muted">{g.reinforce_per_drop ? `${g.reinforce_per_drop} reinforcements per wave while you load` : 'No reinforcements: they are out of medicine'}</div>
      </div>
      <p className="mt-3 text-sm text-muted">
        Taking it strips {e.target_name} of {e.manifest} {e.resource}. Expect its commander to restock from Vex, and its next patrols to field what it can still arm.
      </p>
      <div className="mt-5 flex flex-wrap gap-3">
        {signedIn ? (
          <Link href={`/deploy?target=${e.target}&resource=${e.resource}&kind=${e.kind}`} className="cz-btn cz-btn-primary px-6 py-2.5 text-sm">Brief &amp; deploy</Link>
        ) : (
          <Link href="/signin" className="cz-btn cz-btn-primary px-6 py-2.5 text-sm">Sign in to deploy</Link>
        )}
        <Link href="/contracts" className="cz-btn cz-btn-ghost px-5 py-2.5 text-sm">All contracts{others.length ? ` (${others.length + 1})` : ''}</Link>
      </div>
    </section>
  )
}

export default function Hub() {
  const { session, loading } = useSession()
  const { profile, loading: profileLoading } = useProfile()
  const stash = useStash()
  const [quality, setQuality] = useState<Quality | null>(null)
  const [clean, setClean] = useState(false)
  useEffect(() => { setQuality(loadSettings().quality); setClean(new URLSearchParams(window.location.search).has('clean')) }, [])

  const world = useQuery({ queryKey: ['world'], queryFn: api.world, refetchInterval: 10_000 })
  const decisions = useQuery({ queryKey: ['decisions'], queryFn: () => api.decisions(6), refetchInterval: 15_000 })
  const ex = useQuery({ queryKey: ['exchange', null], queryFn: () => api.exchange(null), refetchInterval: 15_000 })

  const board = world.data?.board ?? []
  const next = useMemo(() => pickNext(board), [board])
  const factions = world.data?.actors.filter((a) => a.kind === 'faction') ?? []
  const merchant = world.data?.actors.find((a) => a.kind === 'merchant')
  const needsCallsign = !!session && !profileLoading && !profile?.callsign

  return (
    <main className="relative h-screen min-h-[640px] w-full overflow-hidden bg-ink text-fog">
      <div className="absolute inset-0">{quality && <HangarScene quality={quality} />}</div>
      {/* legibility gradients */}
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(10,11,13,0.82)_0%,rgba(10,11,13,0.15)_38%,rgba(10,11,13,0.15)_55%,rgba(10,11,13,0.88)_100%)]" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-56 bg-gradient-to-t from-ink via-ink/70 to-transparent" />

      <div className={`relative z-10 flex h-full flex-col ${clean ? 'hidden' : ''}`}>
        <TopBar />
        <div className="grid flex-1 grid-cols-1 gap-6 overflow-y-auto p-4 sm:p-8 lg:grid-cols-[minmax(280px,360px)_1fr_minmax(340px,440px)]">
          {/* operator */}
          <div className="flex flex-col justify-end gap-4">
            {!session && !loading && (
              <section className="cz-panel cz-rise p-5">
                <div className="font-display text-4xl font-bold uppercase leading-none tracking-wide">Contract Zero</div>
                <p className="mt-3 text-sm text-muted">Raid depots, sell what you take, and watch rival factions fight over what is left. Everything you take is yours to keep.</p>
                <div className="mt-4 flex gap-3">
                  <Link href="/signin" className="cz-btn cz-btn-primary px-5 py-2 text-sm">Sign in</Link>
                  <Link href="/training" className="cz-btn cz-btn-ghost px-5 py-2 text-sm">Training</Link>
                </div>
              </section>
            )}
            {needsCallsign && (
              <section className="cz-panel cz-rise p-5">
                <div className="cz-label text-amber">Kestrel</div>
                <p className="mt-2 text-sm">&ldquo;New face. Before I put you on a contract, I need a callsign for the radio.&rdquo;</p>
                <Link href="/operator" className="cz-btn cz-btn-primary mt-4 inline-block px-5 py-2 text-sm">Create operator</Link>
              </section>
            )}
            {session && profile?.callsign && (
              <section className="cz-panel cz-rise p-5">
                <div className="cz-label">Operator</div>
                <div className="font-display text-3xl font-bold tracking-widest">{profile.callsign}</div>
                <div className="text-xs text-muted">Assault rifle · sidearm</div>
                {stash && (
                  <div className="mt-4 grid grid-cols-4 gap-2 border-t border-line pt-3">
                    {([['Credits', stash.credits], ['Ammo', stash.ammo], ['Med', stash.med], ['Fuel', stash.fuel]] as const).map(([k, v]) => (
                      <div key={k}><div className="cz-label !text-[9px]">{k}</div><div className="cz-num font-display text-lg font-bold">{v}</div></div>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex gap-3 text-xs"><Link href="/exchange" className="text-amber-hi hover:underline">Trade at Vex</Link><Link href="/operator" className="text-muted hover:text-fog">Profile</Link></div>
              </section>
            )}
          </div>

          <div className="hidden lg:block" />

          {/* operations console */}
          <div className="flex flex-col justify-end gap-4">
            {world.isError && <section className="cz-panel p-4 text-sm text-hostile">Command is unreachable: the game server is down.</section>}
            {next ? (
              <NextOperation e={next} others={board.filter((b) => b !== next)} signedIn={!!session} />
            ) : (
              world.data && <section className="cz-panel p-5 text-sm text-muted">No depot is worth hitting right now. Vanguard may be out of fuel to stage one.</section>
            )}
          </div>
        </div>

        {/* world status strip */}
        <div className="grid grid-cols-1 gap-4 px-4 pb-4 sm:px-8 sm:pb-6 md:grid-cols-3">
          <section className="cz-panel p-4">
            <div className="cz-label mb-2">World status</div>
            {factions.map((f) => (
              <div key={f.id} className="space-y-2">
                <div className="flex items-baseline justify-between"><span className="font-display font-bold uppercase tracking-wider">{f.name}</span><span className="text-xs text-muted">defense L{f.defense}</span></div>
                {RES.map((r) => <Meter key={r} label={r} have={f.holdings[r]} want={target(f, r)} />)}
              </div>
            ))}
            {merchant && <div className="mt-3 text-xs text-muted">{merchant.name}: {merchant.holdings.credits.toLocaleString()} cr{world.data?.market.insolvent ? ' · insolvent, not buying' : ''}</div>}
          </section>
          <section className="cz-panel p-4">
            <div className="cz-label mb-2">Alerts</div>
            {(ex.data?.shortages ?? []).length === 0 && <p className="text-sm text-muted">No shortages.</p>}
            <ul className="space-y-1.5 text-sm">
              {(ex.data?.shortages ?? []).slice(0, 4).map((s) => (
                <li key={`${s.actor}-${s.resource}`}><span className="font-semibold text-amber">{s.name}</span> short {s.short} {s.resource} <span className="text-muted">({s.have}/{s.target})</span></li>
              ))}
            </ul>
            {ex.data && (
              <div className="mt-3 flex gap-4 text-xs text-muted">
                {ex.data.prices.map((p) => <span key={p.resource} className="cz-num">{p.resource} {p.ask} cr</span>)}
              </div>
            )}
          </section>
          <section className="cz-panel p-4">
            <div className="cz-label mb-2">Faction activity</div>
            <ul className="space-y-2 text-sm">
              {(decisions.data ?? []).slice(0, 3).map((d) => (
                <li key={d.seq} className="leading-snug">
                  <span className="font-semibold text-steel">{d.source.replace(/^agent:/, '').replace(/^\w/, (c) => c.toUpperCase())}</span>{' '}
                  <span className="text-muted">{d.payload.rationale ?? d.payload.trigger ?? 'acted'}</span>
                </li>
              ))}
              {decisions.data?.length === 0 && <li className="text-muted">Quiet. No decisions yet this cycle.</li>}
            </ul>
          </section>
        </div>
      </div>
    </main>
  )
}
