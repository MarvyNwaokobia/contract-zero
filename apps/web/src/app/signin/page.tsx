'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Panel, Shell } from '@/components/ui/Shell'
import { auth, signInSocial, signInWallet, socialBlocker } from '@/lib/auth'
import { useSession } from '@/lib/useSession'

function Google() {
  return (
    <svg viewBox="0 0 48 48" className="h-5 w-5" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  )
}

export default function SignIn() {
  const router = useRouter()
  const { session, refresh } = useSession()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [blocked, setBlocked] = useState<string | null>(null)
  const cfg = useQuery({ queryKey: ['auth-config'], queryFn: auth.config })

  useEffect(() => { socialBlocker().then(setBlocked).catch(() => setBlocked('The game server is not reachable.')) }, [])
  useEffect(() => { if (session) router.replace('/') }, [session, router])

  async function run(label: string, f: () => Promise<unknown>) {
    setBusy(label)
    setError(null)
    try {
      await f()
      await refresh()
      router.replace('/')
    } catch (e) {
      const m = (e as Error).message ?? String(e)
      setError(/popup|closed|cancel/i.test(m) ? 'Sign-in was cancelled.' : m)
    } finally {
      setBusy(null)
    }
  }

  const social = (label: string) => run(label, signInSocial)
  const btn = 'flex w-full items-center justify-center gap-3 rounded-md px-4 py-3 text-sm font-semibold disabled:opacity-40'

  return (
    <Shell title="Sign in" back={{ href: '/', label: 'Main Menu' }}>
      <div className="mx-auto max-w-md space-y-4">
        <Panel>
          <p className="mb-4 text-sm text-slate-400">Your account keeps what you extract and what you trade. No seed phrase, no extensions.</p>
          <div className="space-y-2">
            <button className={`${btn} bg-white text-slate-900 hover:bg-slate-100`} disabled={!!busy || !!blocked} onClick={() => social('google')}>
              <Google /> {busy === 'google' ? 'Opening Google…' : 'Continue with Google'}
            </button>
            <button className={`${btn} border border-slate-700 text-slate-200 hover:bg-slate-900`} disabled={!!busy || !!blocked} onClick={() => social('email')}>
              {busy === 'email' ? 'Opening…' : 'Email or passkey'}
            </button>
          </div>
          {blocked && <p className="mt-3 text-xs text-amber-400">{blocked}</p>}
        </Panel>

        <div className="flex items-center gap-3 text-xs text-slate-600"><div className="h-px flex-1 bg-slate-800" />or<div className="h-px flex-1 bg-slate-800" /></div>

        <Panel>
          <button className={`${btn} border border-cyan-700 text-cyan-300 hover:bg-cyan-950`} disabled={!!busy} onClick={() => run('wallet', signInWallet)}>
            {busy === 'wallet' ? 'Waiting for your wallet…' : 'I already have a NEAR wallet'}
          </button>
          <p className="mt-2 text-xs text-slate-500">You will be asked to sign a sign-in message. It costs nothing and moves nothing.</p>
        </Panel>

        {cfg.data?.dev_login && (
          <Panel title="DEVELOPMENT">
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const id = new FormData(e.currentTarget).get('id') as string; run('dev', () => auth.dev(id)) }}>
              <input name="id" placeholder="dev account id" className="flex-1 rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm" />
              <button className="rounded bg-amber-500 px-3 py-2 text-sm font-semibold text-slate-950">Dev sign-in</button>
            </form>
            <p className="mt-2 text-xs text-amber-400">Off-chain development only: no proof of control. Disabled whenever settlement is on NEAR.</p>
          </Panel>
        )}

        {error && <p className="text-sm text-rose-400">{error}</p>}
        <p className="text-center text-xs text-slate-600"><Link href="/training" className="hover:text-slate-400">Just want to practice? Training needs no account.</Link></p>
      </div>
    </Shell>
  )
}
