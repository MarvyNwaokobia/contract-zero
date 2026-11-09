'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Panel, Shell } from '@/components/ui/Shell'
import { accountLabel, api, type Career } from '@/lib/api'
import { displayName, useProfile, useSession } from '@/lib/useSession'

const VALID = /^[A-Z0-9](?:[A-Z0-9]|-(?=[A-Z0-9])){2,15}$/

const OUTCOME: Record<string, [string, string]> = {
  extracted: ['Extracted', 'text-friendly'], killed: ['Killed in action', 'text-hostile'], expired: ['Abandoned', 'text-muted'],
  rejected: ['Rejected', 'text-hostile'], in_progress: ['In the field', 'text-amber-hi'],
}

/** The service record: every operation with its NEAR settlement, totals, standing
 *  and owned gear, all read from the server's records. */
function ServiceRecord({ c }: { c: Career }) {
  const tone = (t: string) => (t === 'Hostile' || t === 'Wary' ? 'text-hostile' : t === 'Neutral' || t === 'Unknown' ? 'text-muted' : 'text-friendly')
  const owned = c.gear.filter((g) => g.owned > 0)
  return (
    <div className="mt-4 grid gap-4" data-testid="service-record">
      <Panel title="Service record">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          {([['Operations', c.totals.operations], ['Extracted', c.totals.extracted], ['Lost', c.totals.lost], ['Units moved', c.totals.units_moved], ['Fees earned', `${c.totals.fees_earned.toLocaleString()} cr`]] as const).map(([k, v]) => (
            <div key={k}><div className="cz-label !text-[10px]">{k}</div><div className="cz-num font-display text-xl font-bold text-fog">{v}</div></div>
          ))}
        </div>
      </Panel>
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Standing">
          <div className="grid gap-2 text-sm">
            <div className="flex justify-between"><span>Vex Exchange</span><span className={tone(c.standing.vex_tier)}>{c.standing.vex_tier}{c.standing.vex_discount_bp > 0 ? ` · ${c.standing.vex_discount_bp / 100}% off` : ''}</span></div>
            {c.standing.factions.map((f) => (
              <div key={f.actor} className="flex justify-between"><span>{f.name}</span><span className={tone(f.tier)}>{f.tier} · {f.jobs_for} for / {f.operations_against} against</span></div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted">Vex prices by how much business you do with it. Factions remember the contracts they paid you for and the operations you ran on them.</p>
        </Panel>
        <Panel title="Owned gear">
          {owned.length ? owned.map((g) => <div key={g.id} className="text-sm text-fog">{g.title}{g.owned > 1 ? ` ×${g.owned}` : ''}</div>) : <p className="text-sm text-muted">Standard issue only. <Link href="/exchange" className="text-amber-hi hover:underline">Vex&apos;s armory</Link> sells guns you keep.</p>}
        </Panel>
      </div>
      <Panel title="Operations">
        {c.missions.length === 0 && <p className="text-sm text-muted">No operations yet. <Link href="/contracts" className="text-amber-hi hover:underline">Take a contract.</Link></p>}
        <div className="grid gap-1">
          {c.missions.map((m, i) => {
            const [label, cls] = OUTCOME[m.outcome] ?? [m.outcome, 'text-muted']
            return (
              <div key={i} className="grid grid-cols-[7rem_1fr_auto] items-baseline gap-3 border-t border-line py-2 text-sm first:border-t-0">
                <span className="text-xs text-muted">{new Date(m.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} {new Date(m.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                <span className="min-w-0">
                  <span className="font-display font-semibold uppercase tracking-wider text-fog">{m.codename ?? `${m.kind ?? 'raid'}`}</span>
                  <span className="text-muted"> · {m.kind} on {m.target}&apos;s {m.resource}{m.units ? ` · ${m.units} units` : ''}{m.fee ? ` · ${m.fee} cr` : ''}</span>
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
      </Panel>
    </div>
  )
}

/** Operator creation: the callsign Kestrel uses for you on the radio. */
export default function Operator() {
  const router = useRouter()
  const qc = useQueryClient()
  const { session, loading, signOut } = useSession()
  const { profile } = useProfile()
  const [callsign, setCallsign] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (profile?.callsign) setCallsign(profile.callsign) }, [profile?.callsign])
  useEffect(() => { if (!loading && !session) router.replace('/signin') }, [loading, session, router])

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

  if (!session) return <Shell title="Operator"><p className="text-muted">Checking your sign-in…</p></Shell>

  return (
    <Shell title={first ? 'Create operator' : 'Operator'} back={{ href: '/', label: 'Hub' }}>
      <div className="mx-auto grid max-w-3xl gap-4 md:grid-cols-[1.3fr_1fr]">
        <Panel>
          {first && (
            <blockquote className="mb-5 border-l-2 border-amber pl-3 text-sm text-muted">
              <div className="cz-label mb-1 text-amber">Kestrel · handler</div>
              &ldquo;You found us, so you can read a map. Vanguard holds the depots, Vex sells to anyone, and nobody asks where the cargo came from. I need a callsign before I put you on the board.&rdquo;
            </blockquote>
          )}
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
