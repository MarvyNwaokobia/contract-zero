'use client'

// Account & Security: who you're signed in as, how, and what this browser can do on
// your behalf. Quick trade is shown from the CHAIN's record (budget, expiry, revoked),
// never from local state, and revoking it reports success only once the chain
// confirms. No private key, token or other secret is ever shown or logged here: the
// quick-trade secret stays in storage and only its public half is read.

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RPC, chainSession, disableQuickTrade, loadSessionKey, sessionDead, type Session } from '@/lib/auth'
import { useProfile, useSession } from '@/lib/useSession'
import { syncNow, useSyncState } from '@/lib/preferencesSync'
import { Button, Group, Note, Row } from './controls'

export function methodLabel(s: Session): string {
  if (s.method === 'wallet') return 'NEAR wallet'
  if (s.method === 'dev') return 'Developer login (testnet only)'
  if (s.provider === 'google') return 'Google, through NEAR Auth'
  if (s.provider === 'apple') return 'Apple, through NEAR Auth'
  if (s.provider === 'email') return 'Email, through NEAR Auth'
  return 'NEAR Auth'
}

const network = () => (/testnet/.test(RPC) ? 'testnet' : /mainnet/.test(RPC) ? 'mainnet' : 'custom RPC')
const shortKey = (k: string) => (k.length > 24 ? `${k.slice(0, 16)}…${k.slice(-6)}` : k)

export function AccountSecurity() {
  const { session, loading, signOut } = useSession()
  const { profile } = useProfile()
  const router = useRouter()
  const [out, setOut] = useState<{ busy: boolean; warning: string | null }>({ busy: false, warning: null })

  if (loading) return <p className="text-sm text-dim">Checking your session…</p>
  if (!session) {
    return (
      <div className="space-y-4" data-testid="account-signed-out">
        <Note>You aren’t signed in. Every setting is stored on this device only.</Note>
        <Link href="/signin" className="cz-btn cz-btn-primary inline-block px-5 py-2 text-xs">Sign in</Link>
        <SyncRow />
      </div>
    )
  }

  return (
    <div data-testid="account-signed-in">
      <Group title="Operator">
        <Row label="Callsign"><span className="font-display text-lg font-bold tracking-widest text-fog">{profile?.callsign ?? 'Not chosen yet'}</span></Row>
        <Row label="Signed in with"><span className="text-sm text-fog" data-testid="account-method">{methodLabel(session)}</span></Row>
        <Row label="Session ends" hint="Signing in again renews it."><span className="font-mono text-sm text-steel">{new Date(session.expires_at).toLocaleString()}</span></Row>
        <details className="group border-b border-line/70 py-3" data-testid="near-details">
          <summary className="cursor-pointer select-none font-display text-xs font-bold uppercase tracking-[0.2em] text-muted hover:text-fog">NEAR account details</summary>
          <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm md:grid-cols-[12rem_1fr]">
            <dt className="text-dim">Account</dt>
            <dd className="break-all font-mono text-fog">{session.account}</dd>
            <dt className="text-dim">Network</dt>
            <dd className="text-fog">{network()}</dd>
            {session.public_key && <><dt className="text-dim">Sign-in public key</dt><dd className="break-all font-mono text-fog" title="A public key: safe to share">{shortKey(session.public_key)}</dd></>}
            <dt className="text-dim">On the explorer</dt>
            <dd><a className="text-steel underline hover:text-fog" href={`https://${network() === 'mainnet' ? '' : 'testnet.'}nearblocks.io/address/${encodeURIComponent(session.account)}`} target="_blank" rel="noreferrer noopener">nearblocks.io ↗</a></dd>
          </dl>
          <p className="mt-3 text-xs text-dim">The game never sees your account’s private keys. Your assets move only with your approval, or within a quick-trade budget you set.</p>
        </details>
      </Group>

      <Group title="Quick trade">
        <QuickTrade session={session} />
      </Group>

      <Group title="Preferences">
        <SyncRow />
      </Group>

      <Group title="Sign out">
        <Row label="Sign out of this browser" hint="Revokes quick trade on chain first (if this browser holds a key), then ends the session.">
          <Button tone="danger" disabled={out.busy} testid="sign-out" onClick={async () => {
            setOut({ busy: true, warning: null })
            const warning = await signOut()
            if (warning) setOut({ busy: false, warning })
            else router.push('/')
          }}>{out.busy ? 'Signing out…' : 'Sign out'}</Button>
        </Row>
        {out.warning && <Note tone="warn" testid="sign-out-warning">Signed out. {out.warning}</Note>}
      </Group>
    </div>
  )
}

function QuickTrade({ session }: { session: Session }) {
  const qc = useQueryClient()
  const key = loadSessionKey(session.account)
  const pk = key?.getPublicKey().toString() ?? null
  const q = useQuery({ queryKey: ['quick-trade', session.account, pk], queryFn: () => chainSession(session.account, pk!), enabled: !!pk, retry: 1, staleTime: 15_000 })
  const [confirm, setConfirm] = useState(false)
  const [res, setRes] = useState<{ busy: boolean; ok?: string; err?: string }>({ busy: false })

  if (!pk) {
    return (
      <>
        <Row label="Status" hint="Quick trade lets the Exchange accept Vex’s quotes without a prompt each time, within a budget and an expiry you choose.">
          <span className="font-display text-sm font-bold uppercase tracking-[0.16em] text-dim" data-testid="qt-status">Off in this browser</span>
          <Link href="/exchange" className="text-xs text-steel underline hover:text-fog">Turn on in the Exchange</Link>
        </Row>
        {res.ok && <Note tone="ok" testid="qt-result">{res.ok}</Note>}
        {/* A failed revocation still wipes the local key, so this branch must show it. */}
        {res.err && <Note tone="error" testid="qt-result">{res.err}</Note>}
        <p className="py-2 text-xs text-dim">A key opened in another browser is managed there, and stops working at its own expiry.</p>
      </>
    )
  }

  const st = q.data
  const dead = st !== undefined && sessionDead(st)
  return (
    <>
      <Row label="Status" hint="Read from the game controller on chain.">
        {q.isLoading ? <span className="text-sm text-dim">Reading the chain…</span>
          : q.isError ? <span className="text-sm text-[#ff8a8d]" data-testid="qt-status">Couldn’t read the chain. Try again in a moment.</span>
          : dead ? <span className="font-display text-sm font-bold uppercase tracking-[0.16em] text-dim" data-testid="qt-status">{st?.revoked ? 'Revoked' : 'Expired or used up'}</span>
          : <span className="font-display text-sm font-bold uppercase tracking-[0.16em] text-friendly" data-testid="qt-status">Active</span>}
      </Row>
      {st && !dead && (
        <>
          <Row label="Budget left"><span className="font-mono text-sm text-steel" data-testid="qt-budget">{Number(st.credit_budget).toLocaleString()} credits · {Number(st.unit_budget).toLocaleString()} units</span></Row>
          <Row label="Expires"><span className="font-mono text-sm text-steel">{new Date(st.expires_at_ns / 1e6).toLocaleString()}</span></Row>
        </>
      )}
      <Row label="Key" hint="The public half of this browser’s quick-trade key."><span className="break-all font-mono text-xs text-muted">{shortKey(pk)}</span></Row>
      <Row label="Revoke" hint="Signs a revocation with the key itself and waits until the chain confirms it can no longer trade.">
        {!confirm ? (
          <Button tone="danger" disabled={res.busy} testid="qt-revoke" onClick={() => setConfirm(true)}>Revoke quick trade</Button>
        ) : (
          <>
            <Button tone="danger" disabled={res.busy} testid="qt-revoke-confirm" onClick={async () => {
              setRes({ busy: true })
              try {
                await disableQuickTrade(session)
                setRes({ busy: false, ok: 'Revoked. The chain confirms this key can no longer trade.' })
              } catch (e) {
                setRes({ busy: false, err: (e as Error).message })
              }
              setConfirm(false)
              await qc.invalidateQueries({ queryKey: ['quick-trade'] })
            }}>{res.busy ? 'Revoking and checking…' : 'Yes, revoke'}</Button>
            {!res.busy && <Button onClick={() => setConfirm(false)}>Keep it</Button>}
          </>
        )}
      </Row>
      {res.err && <Note tone="error" testid="qt-result">{res.err}</Note>}
    </>
  )
}

function SyncRow() {
  const st = useSyncState()
  const text = st.kind === 'local' ? 'This device only (sign in to carry your controls and interface between devices).'
    : st.kind === 'syncing' ? 'Syncing…'
    : st.kind === 'synced' ? `Saved to your account ${new Date(st.at).toLocaleTimeString()}${st.pulled ? ', loaded from another device' : ''}.`
    : `Couldn’t sync: ${st.message}. Your settings are still saved on this device.`
  return (
    <Row label="Where settings are kept" hint="Controls, key bindings, interface, accessibility, audio and subtitles follow your account. Graphics stays per device.">
      <span className={`text-sm ${st.kind === 'error' ? 'text-[#ff8a8d]' : 'text-fog'}`} data-testid="sync-state">{text}</span>
      {st.kind !== 'local' && <Button onClick={() => void syncNow()} disabled={st.kind === 'syncing'} testid="sync-now">Sync now</Button>}
    </Row>
  )
}
