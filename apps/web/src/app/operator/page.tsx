'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Panel, Shell } from '@/components/ui/Shell'
import { accountLabel, api } from '@/lib/api'
import { displayName, useProfile, useSession } from '@/lib/useSession'

const VALID = /^[A-Z0-9](?:[A-Z0-9]|-(?=[A-Z0-9])){2,15}$/

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
            <button onClick={() => signOut().then(() => router.push('/'))} className="text-muted hover:text-fog">Sign out</button>
          </div>
        </Panel>
      </div>
    </Shell>
  )
}
