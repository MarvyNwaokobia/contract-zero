'use client'

// An accessible tab strip (arrow keys, Home/End, roving tabindex) whose panels stay mounted
// so a quote or an order in progress is never lost by switching tabs. The chosen tab is kept
// in the URL hash, so a link or a reload lands where you were.

import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface TabDef { id: string; label: string; badge?: number | string; panel: ReactNode }

export function Tabs({ tabs, label, initial }: { tabs: TabDef[]; label: string; initial?: string }) {
  const first = initial ?? tabs[0].id
  const [active, setActive] = useState(first)
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  useEffect(() => {
    const fromHash = () => { const h = window.location.hash.slice(1); if (tabs.some((t) => t.id === h)) setActive(h) }
    fromHash()
    window.addEventListener('hashchange', fromHash)
    return () => window.removeEventListener('hashchange', fromHash)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const pick = (id: string, focus = false) => {
    setActive(id)
    try { history.replaceState(null, '', `#${id}`) } catch { /* sandboxed */ }
    if (focus) refs.current[id]?.focus()
  }
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const n = tabs.length
    const to = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1
    if (to >= 0) { e.preventDefault(); pick(tabs[to].id, true) }
  }
  return (
    <div className="min-w-0 max-w-full">
      <div role="tablist" aria-label={label} className="sticky top-0 z-10 -mx-1 mb-4 flex gap-1 overflow-x-auto border-b border-line bg-ink/95 px-1 backdrop-blur">
        {tabs.map((t, i) => (
          <button
            key={t.id} ref={(el) => { refs.current[t.id] = el }} role="tab" id={`tab-${t.id}`} aria-selected={active === t.id} aria-controls={`panel-${t.id}`} tabIndex={active === t.id ? 0 : -1}
            onClick={() => pick(t.id)} onKeyDown={(e) => onKey(e, i)} data-testid={`tab-${t.id}`}
            className={`cz-label shrink-0 whitespace-nowrap border-b-2 px-4 py-3 !text-[12px] ${active === t.id ? 'border-amber !text-amber-hi' : 'border-transparent hover:!text-fog'}`}
          >
            {t.label}{t.badge != null && <span className="ml-2 bg-line-strong px-1.5 text-[10px] text-fog">{t.badge}</span>}
          </button>
        ))}
      </div>
      {tabs.map((t) => <div key={t.id} role="tabpanel" id={`panel-${t.id}`} aria-labelledby={`tab-${t.id}`} hidden={active !== t.id}>{t.panel}</div>)}
    </div>
  )
}
