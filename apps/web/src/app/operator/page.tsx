'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Panel, Shell } from '@/components/ui/Shell'
import { accountLabel, api, type Career } from '@/lib/api'
import { displayName, useProfile, useSession } from '@/lib/useSession'
import { FactionInsignia } from '@/components/ui/FactionInsignia'
import { GunStatBars } from '@/components/armory/GunStatBars'
import { GUN_CATALOG, type GunId } from '@/engine/combat/GunStats'
import { factionColor } from '@/lib/factions'
import { extractionRate, missionLine, OUTCOME_LABEL } from '@/lib/world/career'

const VALID = /^[A-Z0-9](?:[A-Z0-9]|-(?=[A-Z0-9])){2,15}$/

const tone = (t: string) => (t === 'Hostile' || t === 'Wary' ? 'text-hostile' : t === 'Neutral' || t === 'Unknown' ? 'text-muted' : 'text-friendly')
const PAGE = 8

/** The service record: every operation with its NEAR settlement, totals, standing
 *  and owned gear, all read from the server's records. */
function ServiceRecord({ c }: { c: Career }) {
  const [all, setAll] = useState(false)
  const owned = c.gear.filter((g) => g.owned > 0)
  const rate = extractionRate(c.totals)
  const missions = all ? c.missions : c.missions.slice(0, PAGE)
  const stats: [string, string | number, string?][] = [
    ['Operations', c.totals.operations], ['Extracted', c.totals.extracted], ['Lost', c.totals.lost],
    ['Extraction rate', rate == null ? '—' : `${rate}%`, rate == null ? 'no finished run yet' : 'of finished runs'],
    ['Units moved', c.totals.units_moved.toLocaleString()], ['Fees earned', `${c.totals.fees_earned.toLocaleString()} cr`],
  ]
  return (
    <div className="mt-4 grid gap-4" data-testid="service-record">
      <section className="cz-panel p-4" aria-label="Service record">
        <h2 className="cz-label mb-3">Service record</h2>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {stats.map(([k, v, hint]) => (
            <div key={k}><dt className="cz-label !text-[10px]">{k}</dt><dd className="cz-num m-0 font-display text-2xl font-bold text-fog">{v}</dd>{hint && <dd className="m-0 text-[11px] text-dim">{hint}</dd>}</div>
          ))}
        </dl>
      </section>
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Standing">
          <ul className="grid gap-3 text-sm">
            <li className="flex items-center gap-3"><span style={{ color: 'var(--color-amber)' }}><FactionInsignia id="vex" className="h-8 w-8" title="" /></span><span className="flex-1">Vex Exchange<span className="block text-xs text-dim">{c.standing.vex_discount_bp > 0 ? `${c.standing.vex_discount_bp / 100}% better prices` : 'list prices'} · {c.standing.vex_traded.toLocaleString()} cr traded</span></span><span className={`font-display font-bold uppercase tracking-wider ${tone(c.standing.vex_tier)}`}>{c.standing.vex_tier}</span></li>
            {c.standing.factions.map((f) => (
              <li key={f.actor} className="flex items-center gap-3"><span style={{ color: factionColor(f.actor) }}><FactionInsignia id={f.actor} className="h-8 w-8" title="" /></span><span className="flex-1">{f.name}<span className="block text-xs text-dim">{f.jobs_for} job{f.jobs_for === 1 ? '' : 's'} for them · {f.operations_against} against</span></span><span className={`font-display font-bold uppercase tracking-wider ${tone(f.tier)}`}>{f.tier}</span></li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">Vex prices by how much business you do with it. Factions remember the contracts they paid you for and the operations you ran on them.</p>
        </Panel>
        <Panel title="Owned gear">
          {owned.length ? (
            <ul className="grid gap-3">
              {owned.map((g) => (
                <li key={g.id}>
                  <div className="text-sm font-semibold text-fog">{g.title}{g.owned > 1 ? ` ×${g.owned}` : ''}</div>
                  {GUN_CATALOG[g.id as GunId] && <div className="mt-1"><GunStatBars gun={g.id as GunId} compact /></div>}
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">Standard issue only. <Link href="/exchange#armory" className="text-amber-hi hover:underline">Vex&apos;s armory</Link> sells guns you keep.</p>}
        </Panel>
      </div>
      <Panel title="Operations">
        {c.missions.length === 0 && <p className="text-sm text-muted">No operations yet. <Link href="/contracts" className="text-amber-hi hover:underline">Take a contract.</Link></p>}
        <div className="grid gap-1">
          {missions.map((m, i) => {
            const label = OUTCOME_LABEL[m.outcome] ?? m.outcome
            const cls = { extracted: 'text-friendly', killed: 'text-hostile', rejected: 'text-hostile', in_progress: 'text-amber-hi' }[m.outcome] ?? 'text-muted'
            const line = missionLine(m)
            return (
              <div key={i} className="grid grid-cols-[1fr_auto] items-baseline gap-x-3 gap-y-0.5 border-t border-line py-2 text-sm first:border-t-0 sm:grid-cols-[7rem_1fr_auto]">
                <span className="col-span-2 text-xs text-muted sm:col-span-1">{new Date(m.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} {new Date(m.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                <span className="min-w-0">
                  <span className="font-display font-semibold uppercase tracking-wider text-fog">{m.codename ?? m.kind ?? 'Operation'}</span>
                  {line && <span className="text-muted"> · {line}</span>}
                </span>
                <span className="text-right text-xs">
                  <span className={cls}>{label}</span>
                  {m.settlement && (m.settlement.settled_on_chain
                    ? m.settlement.explorer.slice(0, 1).map((u) => <a key={u} href={u} target="_blank" rel="noreferrer" className="ml-2 text-steel hover:underline">on NEAR ↗</a>)
                    : <span className="ml-2 text-muted">settling</span>)}
                </span>
              </div>
            )
          })}
        </div>
        {c.missions.length > PAGE && <button type="button" onClick={() => setAll(!all)} className="mt-2 text-sm text-steel underline hover:text-fog" data-testid="ops-more">{all ? 'Show the latest only' : `Show all ${c.missions.length}`}</button>}
      </Panel>
    </div>
  )
}

/** Operator creation: the callsign Kestrel uses for you on the radio. */
export default function Operator() {
  const router = useRouter()
  const qc = useQueryClient()
  const { session, loading, failed, refresh, signOut } = useSession()
  const { profile } = useProfile()
  const [callsign, setCallsign] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (profile?.callsign) setCallsign(profile.callsign) }, [profile?.callsign])
  // Only a definite "not signed in" sends you to sign-in; a failed check does not (see useSession).
  useEffect(() => { if (!loading && !failed && !session) router.replace('/signin') }, [loading, failed, session, router])

  const career = useQuery({ queryKey: ['career', session?.account], queryFn: api.career, enabled: !!session })
  const first = !profile?.callsign
  const ok = VALID.test(callsign) && callsign.length <= 16

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      await api.setProfile(callsign)
      await qc.invalidateQueries({ queryKey: ['profile'] })
      router.push('/')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (failed) return <Shell title="Operator" back={{ href: '/', label: 'Hub' }}><p className="text-muted" role="alert">We couldn&apos;t check your sign-in just now (the server didn&apos;t answer). You are not signed out. <button className="text-amber-hi underline" onClick={() => refresh()} data-testid="session-retry">Try again</button></p></Shell>
  if (!session) return <Shell title="Operator"><p className="text-muted">Checking your sign-in…</p></Shell>

  return (
    <Shell title={first ? 'Create operator' : 'Operator'} back={{ href: '/', label: 'Hub' }}>
      <div className={`grid gap-4 md:grid-cols-[1.3fr_1fr] ${first ? "mx-auto max-w-3xl" : ""}`}>
        <Panel>
          {first && (
            <blockquote className="mb-5 border-l-2 border-amber pl-3 text-sm text-muted">
              <div className="cz-label mb-1 text-amber">Kestrel · handler</div>
              &ldquo;You found us, so you can read a map. Vanguard holds the depots, Vex sells to anyone, and nobody asks where the cargo came from. I need a callsign before I put you on the board.&rdquo;
            </blockquote>
          )}
          {!first && (
            <div className="mb-3" data-testid="operator-callsign">
              <div className="cz-label !text-[10px]">Callsign</div>
              <div className="font-display text-4xl font-bold uppercase tracking-[0.2em] text-fog">{profile?.callsign}</div>
              <div className="text-xs text-dim">What Kestrel calls you on the radio, and what others see on the board.</div>
            </div>
          )}
          {first ? (
          <form onSubmit={save} className="space-y-3">
            <label className="cz-label block" htmlFor="callsign">Callsign</label>
            <input
              id="callsign" autoFocus value={callsign} maxLength={16}
              onChange={(e) => setCallsign(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
              placeholder="WRAITH-6"
              className="w-full border border-line-strong bg-ink-2 px-4 py-3 font-display text-2xl font-bold tracking-[0.25em] text-fog outline-none focus:border-amber"
            />
            <p className="text-xs text-muted">3–16 letters, digits or single dashes. Other operators see it on the board.</p>
            {error && <p className="text-sm text-hostile">{error}</p>}
            <button disabled={!ok || busy} className="cz-btn cz-btn-primary px-6 py-2.5 text-sm">{busy ? 'Saving…' : first ? 'Report for duty' : 'Save callsign'}</button>
          </form>
          ) : (
            <details className="text-sm">
              <summary className="cursor-pointer text-steel hover:text-fog">Change callsign</summary>
              <div className="mt-3">
          <form onSubmit={save} className="space-y-3">
            <label className="cz-label block" htmlFor="callsign">Callsign</label>
            <input
              id="callsign" autoFocus value={callsign} maxLength={16}
              onChange={(e) => setCallsign(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
              placeholder="WRAITH-6"
              className="w-full border border-line-strong bg-ink-2 px-4 py-3 font-display text-2xl font-bold tracking-[0.25em] text-fog outline-none focus:border-amber"
            />
            <p className="text-xs text-muted">3–16 letters, digits or single dashes. Other operators see it on the board.</p>
            {error && <p className="text-sm text-hostile">{error}</p>}
            <button disabled={!ok || busy} className="cz-btn cz-btn-primary px-6 py-2.5 text-sm">{busy ? 'Saving…' : first ? 'Report for duty' : 'Save callsign'}</button>
          </form>
              </div>
            </details>
          )}
        </Panel>
        <Panel title="Account">
          <div className="text-sm">{displayName(session)}</div>
          <div className="mt-1 text-xs text-muted">{session.method === 'wallet' ? 'Signed in with a wallet' : 'Signed in with your account'} · {accountLabel(session.account)}</div>
          <p className="mt-3 text-xs text-muted">What you extract and buy is held by this account, and only you can trade it.</p>
          <div className="mt-4 flex gap-4 text-sm">
            <Link href="/exchange" className="text-amber-hi hover:underline">Your stash</Link>
            <button onClick={() => signOut().then((warn) => { if (warn) window.alert(warn); router.push('/') })} className="text-muted hover:text-fog">Sign out</button>
          </div>
        </Panel>
      </div>
      {career.data && <ServiceRecord c={career.data} />}
    </Shell>
  )
}
