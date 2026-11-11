'use client'

// A one-time explanation for a screen: what you are looking at and what the numbers mean.
// It sits inline above the content (never over it), shows once per player, is dismissed with
// one click, and never appears when tips are off or after the player has seen it. A returning
// player who has seen it, or turned tips off, gets nothing.

import { useEffect, useState, type ReactNode } from 'react'
import { useSettings } from '@/lib/settings'
import { markTipSeen, tipSeen, type Tip } from '@/lib/tutorial'

export function ScreenTip({ tip, title, children }: { tip: Tip; title: string; children: ReactNode }) {
  const s = useSettings()
  const [show, setShow] = useState(false)
  useEffect(() => { if (!tipSeen(tip)) setShow(true) }, [tip])
  // Gated on the live setting, so tips turned off (even after a late settings load) never show.
  if (!show || !s.interface.tips) return null
  const close = () => { markTipSeen(tip); setShow(false) }
  return (
    <aside className="mb-4 border-l-2 border-amber bg-amber/10 p-4 text-sm" role="note" aria-label={title} data-testid={`tip-${tip}`}>
      <div className="font-display text-xs font-bold uppercase tracking-[0.24em] text-amber-hi">{title}</div>
      <div className="mt-1 grid gap-1.5 text-muted">{children}</div>
      <button type="button" className="mt-2 text-xs text-dim underline hover:text-fog" onClick={close} data-testid={`tip-${tip}-close`}>Got it</button>
    </aside>
  )
}
