import Link from 'next/link'
import type { ReactNode } from 'react'

/** The frame around every non-combat screen. */
export function Shell({ title, children, back }: { title: string; children: ReactNode; back?: { href: string; label: string } }) {
  return (
    <main className="min-h-screen bg-[#07090d] text-slate-200">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8">
        <header className="mb-8 flex items-baseline justify-between gap-4 border-b border-slate-800 pb-4">
          <div>
            <Link href="/" className="text-xs font-semibold tracking-[0.3em] text-cyan-400">CONTRACT ZERO</Link>
            <h1 className="mt-1 text-2xl font-bold tracking-wide text-slate-100">{title}</h1>
          </div>
          {back && <Link href={back.href} className="text-sm text-slate-400 hover:text-slate-200">← {back.label}</Link>}
        </header>
        {children}
      </div>
    </main>
  )
}

export function Panel({ title, children, className = '' }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-md border border-slate-800 bg-slate-900/40 p-4 ${className}`}>
      {title && <h2 className="mb-3 text-xs font-semibold tracking-[0.2em] text-slate-400">{title}</h2>}
      {children}
    </section>
  )
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="text-lg font-semibold tabular-nums text-slate-100">{value}</div>
      {hint && <div className="text-xs text-slate-500">{hint}</div>}
    </div>
  )
}
