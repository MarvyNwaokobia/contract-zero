'use client'

// First launch: who you are, what you do, Training versus Live, and one big way in.
// Shown on the Hub until dismissed (or until you start training); How to play stays
// one click away afterwards.

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { HowToPlayButton } from './HowToPlay'

const KEY = 'cz_welcome_seen'

export function Welcome() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    try { setShow(!localStorage.getItem(KEY)) } catch { setShow(false) }
  }, [])
  const done = () => { try { localStorage.setItem(KEY, '1') } catch { /* private mode */ } setShow(false) }
  if (!show) return null
  return (
    <div className="fixed inset-0 z-[150] grid place-items-center overflow-y-auto bg-ink/70 p-3 backdrop-blur-sm">
    <section role="dialog" aria-modal="true" className="cz-panel relative w-full max-w-3xl overflow-hidden p-5 sm:p-7" aria-labelledby="welcome-title" data-testid="welcome">
      <div className="font-display text-[11px] font-bold uppercase tracking-[0.34em] text-amber">First time here</div>
      <h2 id="welcome-title" className="mt-1 font-display text-2xl font-bold uppercase tracking-[0.1em] text-fog sm:text-3xl">Welcome, operator</h2>
      <p className="mt-2 max-w-3xl text-sm text-muted">You are a contractor between rival factions. Take a contract, get in, secure the objective and <b className="text-fog">extract</b>. What you take is really gone from them: their commanders react, merchants compete to resupply them, and the next fight is different because of you.</p>
      <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div className="border border-line bg-ink-2 p-3"><div className="font-display text-xs font-bold uppercase tracking-[0.2em] text-steel">Training</div><p className="mt-1 text-muted">Learn the controls and extraction with nothing at stake. Practice lets you pick any site, hour and mission. Unscored, never on chain.</p></div>
        <div className="border border-line bg-ink-2 p-3"><div className="font-display text-xs font-bold uppercase tracking-[0.2em] text-steel">Live contracts</div><p className="mt-1 text-muted">Real factions, real stock. What you extract becomes yours on NEAR testnet, and the world reacts. Sign in to take one.</p></div>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Link href="/training" onClick={done} className="cz-btn cz-btn-primary px-7 py-3 text-sm" data-testid="welcome-start">Start training</Link>
        <HowToPlayButton className="cz-btn cz-btn-ghost px-5 py-3 text-sm" />
        <button onClick={done} className="text-xs text-dim underline hover:text-fog" data-testid="welcome-dismiss">I&apos;ve played before</button>
      </div>
    </section>
    </div>
  )
}
