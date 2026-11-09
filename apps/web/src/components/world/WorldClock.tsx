'use client'

// The world clock, said plainly: what hour it is in the basin, what that does to the
// sites (lighting, sight lines, patrols), and when it next changes. The clock is
// accelerated for play: one game hour passes every `tick_secs` real seconds.

import type { WorldClock as Clock } from '@/lib/api'
import type { Phase } from '@/engine/fps/convoy'

const PHASE: Record<Phase, { label: string; color: string; icon: string }> = {
  day: { label: 'Day', color: 'var(--color-amber-hi)', icon: 'M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4M12 8a4 4 0 100 8 4 4 0 000-8z' },
  dusk: { label: 'Dusk', color: '#e8955a', icon: 'M3 17h18M6 17a6 6 0 0112 0M12 5v3M5 9l2 1.5M19 9l-2 1.5' },
  night: { label: 'Night', color: '#8fb2e6', icon: 'M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z' },
}

const hh = (h: number) => `${String(h % 24).padStart(2, '0')}:00`

export function realTime(secs: number) {
  if (secs < 90) return `${Math.round(secs)} s`
  return `${Math.round(secs / 60)} min`
}

export function WorldClockPanel({ clock, compact = false }: { clock?: Clock; compact?: boolean }) {
  if (!clock) return null
  const c = clock.conditions
  const p = PHASE[c.phase]
  const next = c.next_phase ? PHASE[c.next_phase] : null
  const inSecs = (c.ticks_to_change ?? 0) * clock.tick_secs
  const icon = <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="none" stroke={p.color} strokeWidth="1.8" aria-hidden><path d={p.icon} /></svg>
  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm" data-testid="world-clock">
        <span className="flex items-center gap-2 font-display font-bold uppercase tracking-widest" style={{ color: p.color }}>{icon}Day {clock.day} · {hh(clock.hour)} · {p.label}</span>
        <span className="text-muted">{c.patrol}</span>
        {next && <span className="text-dim">{next.label} at {hh(c.next_change_hour ?? 0)}, in about {realTime(inSecs)}</span>}
      </div>
    )
  }
  return (
    <section className="cz-panel p-4" data-testid="world-clock">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          {icon}
          <div>
            <div className="font-display text-xl font-bold uppercase tracking-widest" style={{ color: p.color }}>Day {clock.day} · {hh(clock.hour)} · {p.label}</div>
            <div className="text-sm text-muted">{c.lighting}</div>
          </div>
        </div>
        {next && (
          <div className="text-right text-sm">
            <div className="cz-label !text-[10px]">Next change</div>
            <div className="text-fog">{next.label} at {hh(c.next_change_hour ?? 0)}</div>
            <div className="text-xs text-dim">in about {realTime(inSecs)} of real time</div>
          </div>
        )}
      </div>
      <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
        <div><span className="cz-label !text-[10px]">Patrols</span><div className="text-slate-200">{c.patrol}</div></div>
        <div><span className="cz-label !text-[10px]">Guard sight</span><div className="text-slate-200">{c.sight_m} m · accuracy {Math.round(c.accuracy_bp / 100)}%</div></div>
        <div><span className="cz-label !text-[10px]">Night vision</span><div className="text-slate-200">{c.nvg ? 'Issued' : 'Not needed'}</div></div>
      </div>
      <p className="mt-3 text-xs text-dim">The world clock runs fast for play: one game hour passes every {clock.tick_secs} seconds of real time, so a full day takes {Math.round((24 * clock.tick_secs) / 60)} minutes. Every contract stays at its own site; the hour changes the conditions there.</p>
    </section>
  )
}
