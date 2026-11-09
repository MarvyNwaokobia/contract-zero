'use client'

// The fifth first-time tip: after the first completed contract, what happens next in
// the world, and where to watch it. Shown once (with tips on), dismissible.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSettings } from '@/lib/settings'
import { markTipSeen, tipSeen } from '@/lib/tutorial'

export function ConsequenceTip({ target }: { target: string }) {
  const s = useSettings()
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (s.interface.tips && !tipSeen('consequence')) {
      setShow(true)
      markTipSeen('consequence')
    }
  }, [s.interface.tips])
  if (!show) return null
  return (
    <div className="mt-4 border-l-2 border-amber bg-amber/10 p-4 text-sm" role="status" data-testid="tip-consequence">
      <div className="font-display text-xs font-bold uppercase tracking-[0.24em] text-amber-hi">What happens now</div>
      <p className="mt-1 text-fog">{target} really lost that stock. Every in-game hour (a real minute) its commander looks at what it holds: if it is short, it posts a supply order and the merchants compete to fill it; it may raise its guard or post a bounty on a rival. The next contract against it will reflect all of that.</p>
      <p className="mt-2 text-muted">Watch it happen in the <Link href="/war-room" className="text-steel underline">War Room</Link>, or sell your haul at the <Link href="/exchange" className="text-steel underline">Exchange</Link>.</p>
      <button className="mt-2 text-xs text-dim underline" onClick={() => setShow(false)}>Got it</button>
    </div>
  )
}
