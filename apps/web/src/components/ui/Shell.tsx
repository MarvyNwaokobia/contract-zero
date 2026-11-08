'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { Emblem } from '@/components/ui/Emblem'
import { useProfile, useSession, useStash } from '@/lib/useSession'

const NAV: { href: string; label: string; icon: ReactNode; soon?: boolean }[] = [
  { href: '/', label: 'Hub', icon: <path d="M3 11l9-7 9 7v9h-6v-6H9v6H3z" /> },
  { href: '/contracts', label: 'Contracts', icon: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.5" /><path d="M12 1v5M12 18v5M1 12h5M18 12h5" /></> },
  { href: '/exchange', label: 'Exchange', icon: <path d="M4 8h13l-3-3M20 16H7l3 3" /> },
  { href: '/war-room', label: 'War Room', icon: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /> },
  { href: '/training', label: 'Training', icon: <path d="M12 3l9 5-9 5-9-5zM6 11v5c0 1 3 3 6 3s6-2 6-3v-5" /> },
  { href: '/settings', label: 'Settings', icon: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" /></> },
]

/** The game's top bar: mark, sections, and who you are. */
export function TopBar() {
  const path = usePathname()
  const { session } = useSession()
  const { profile } = useProfile()
  const stash = useStash()
  return (
    <header className="relative z-20 flex items-center gap-4 border-b border-line bg-ink/80 px-4 py-2 backdrop-blur sm:px-6">
      <Link href="/" className="flex items-center gap-2 text-fog" aria-label="CONTRACT ZERO hub">
        <Emblem />
        <span className="hidden font-display text-sm font-bold tracking-[0.32em] sm:inline">CONTRACT&nbsp;ZERO</span>
      </Link>
      <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
        {NAV.map((n) => {
          const active = n.href === '/' ? path === '/' : path.startsWith(n.href)
          const cls = `cz-btn flex shrink-0 items-center gap-2 px-4 py-2 text-[12px] ${active ? 'bg-amber/15 text-amber-hi shadow-[inset_0_-2px_0_var(--color-amber)]' : 'text-muted hover:text-fog'}`
          const icon = <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">{n.icon}</svg>
          return n.soon ? (
            <span key={n.href} className={`${cls} cursor-not-allowed opacity-40`} title="Coming in a later milestone">{icon}<span className="hidden md:inline">{n.label}</span></span>
          ) : (
            <Link key={n.href} href={n.href} className={cls}>{icon}<span className="hidden md:inline">{n.label}</span></Link>
          )
        })}
      </nav>
      <div className="flex shrink-0 items-center gap-4 text-right">
        {session ? (
          <>
            {stash && (
              <div className="hidden sm:block">
                <div className="cz-label !text-[9px]">Credits</div>
                <div className="cz-num font-display text-base font-bold text-amber-hi">{stash.credits.toLocaleString()}</div>
              </div>
            )}
            <Link href="/operator" className="font-display text-sm font-bold tracking-widest text-fog hover:text-amber-hi">
              {profile?.callsign ?? 'NEW OPERATOR'}
            </Link>
          </>
        ) : (
          <Link href="/signin" className="cz-btn cz-btn-primary px-4 py-1.5 text-xs">Sign in</Link>
        )}
      </div>
    </header>
  )
}

/** The frame around every non-combat screen. */
export function Shell({ title, children, back, wide = false }: { title: string; children: ReactNode; back?: { href: string; label: string }; wide?: boolean }) {
  return (
    <main className="min-h-screen bg-ink text-fog">
      <TopBar />
      <div className={`mx-auto px-4 py-8 sm:px-8 ${wide ? 'max-w-7xl' : 'max-w-5xl'}`}>
        <header className="mb-6 flex items-end justify-between gap-4">
          <h1 className="font-display text-3xl font-bold uppercase tracking-[0.12em] text-fog">{title}</h1>
          {back && <Link href={back.href} className="cz-label hover:text-fog">← {back.label}</Link>}
        </header>
        <div className="cz-rise">{children}</div>
      </div>
    </main>
  )
}

export function Panel({ title, children, className = '' }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`cz-panel p-4 ${className}`}>
      {title && <h2 className="cz-label mb-3">{title}</h2>}
      {children}
    </section>
  )
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div>
      <div className="cz-label !text-[10px]">{label}</div>
      <div className="cz-num font-display text-xl font-bold text-fog">{value}</div>
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </div>
  )
}
