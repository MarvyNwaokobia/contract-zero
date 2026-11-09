'use client'

// The Configuration Center's controls. Every one is a native input (keyboard and
// screen-reader operable) dressed in the game's identity: graphite rows, amber
// selection, steel readouts.

import type { ReactNode } from 'react'

export const focusRing = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-hi'

/** A labelled setting: name and hint on the left, the control on the right. */
export function Row({ label, htmlFor, hint, children, testid }: { label: string; htmlFor?: string; hint?: ReactNode; children: ReactNode; testid?: string }) {
  return (
    <div className="grid items-center gap-x-6 gap-y-2 border-b border-line/70 py-3 last:border-b-0 md:grid-cols-[minmax(12rem,17rem)_1fr]" data-testid={testid}>
      <div className="min-w-0">
        {htmlFor ? <label htmlFor={htmlFor} className="text-sm font-semibold text-fog">{label}</label> : <div className="text-sm font-semibold text-fog">{label}</div>}
        {hint && <div className="mt-0.5 text-xs leading-snug text-dim">{hint}</div>}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-3">{children}</div>
    </div>
  )
}

/** A group heading inside a section. */
export function Group({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="mb-6 last:mb-0">
      <div className="mb-1 flex items-center gap-3">
        <h3 className="font-display text-[11px] font-bold uppercase tracking-[0.28em] text-steel">{title}</h3>
        <div className="h-px flex-1 bg-line" aria-hidden />
        {aside}
      </div>
      {children}
    </section>
  )
}

export function Segmented<T extends string | number>({ name, value, options, onChange, label, testid }: {
  name: string; value: T; label: string; testid?: string
  options: { id: T; label: string; hint?: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap border border-line-strong bg-ink-2">
      {options.map((o) => {
        const on = value === o.id
        return (
          <label key={String(o.id)} title={o.hint}
            className={`cursor-pointer select-none px-3 py-1.5 font-display text-xs font-bold uppercase tracking-[0.14em] transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-amber-hi ${on ? 'bg-amber text-[#1a1206]' : 'text-muted hover:bg-panel-2 hover:text-fog'}`}>
            <input type="radio" name={name} value={String(o.id)} checked={on} onChange={() => onChange(o.id)} className="sr-only" data-testid={testid ? `${testid}-${o.id}` : undefined} />
            {o.label}
          </label>
        )
      })}
    </div>
  )
}

export function Slider({ id, value, min, max, step, onChange, format, valueText, testid }: {
  id: string; value: number; min: number; max: number; step: number
  onChange: (v: number) => void; format: (v: number) => string; valueText?: (v: number) => string; testid?: string
}) {
  return (
    <>
      <input id={id} type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        className={`h-2 min-w-[10rem] flex-1 cursor-pointer accent-amber ${focusRing}`}
        aria-valuetext={(valueText ?? format)(value)} data-testid={testid ?? id} />
      <output htmlFor={id} className="w-16 shrink-0 text-right font-mono text-sm tabular-nums text-steel">{format(value)}</output>
    </>
  )
}

/** An on/off switch: a native checkbox with role="switch". */
export function Switch({ id, checked, onChange, label, testid }: { id: string; checked: boolean; onChange: (v: boolean) => void; label?: string; testid?: string }) {
  return (
    <span className="inline-flex items-center gap-3">
      <input id={id} type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} aria-label={label}
        className={`relative h-5 w-10 shrink-0 cursor-pointer appearance-none border border-line-strong bg-ink-2 transition-colors checked:border-amber checked:bg-amber/25 before:absolute before:left-0.5 before:top-0.5 before:h-3.5 before:w-3.5 before:bg-muted before:transition-transform checked:before:translate-x-5 checked:before:bg-amber-hi ${focusRing}`}
        data-testid={testid ?? id} />
      <span className={`font-display text-xs font-bold uppercase tracking-[0.18em] ${checked ? 'text-amber-hi' : 'text-dim'}`} aria-hidden>{checked ? 'On' : 'Off'}</span>
    </span>
  )
}

/** A short note in the system's voice: info, caution or a hard limit. */
export function Note({ tone = 'info', children, testid }: { tone?: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode; testid?: string }) {
  const c = tone === 'warn' ? 'border-amber/60 text-amber-hi' : tone === 'error' ? 'border-hostile/70 text-[#ff8a8d]' : tone === 'ok' ? 'border-friendly/60 text-[#7fe0a6]' : 'border-steel/50 text-muted'
  return <div className={`border-l-2 bg-ink-2/70 px-3 py-2 text-xs leading-relaxed ${c}`} data-testid={testid}>{children}</div>
}

export function Button({ children, onClick, tone = 'ghost', disabled, testid, type = 'button', ariaLabel }: {
  children: ReactNode; onClick?: () => void; tone?: 'ghost' | 'primary' | 'danger'; disabled?: boolean; testid?: string; type?: 'button' | 'submit'; ariaLabel?: string
}) {
  const cls = tone === 'primary' ? 'cz-btn-primary' : tone === 'danger' ? 'bg-hostile/15 text-[#ff8a8d] shadow-[inset_0_0_0_1px_rgba(229,72,77,.55)] hover:bg-hostile/25' : 'cz-btn-ghost'
  return <button type={type} className={`cz-btn px-4 py-1.5 text-xs ${cls} ${focusRing}`} onClick={onClick} disabled={disabled} data-testid={testid} aria-label={ariaLabel}>{children}</button>
}
