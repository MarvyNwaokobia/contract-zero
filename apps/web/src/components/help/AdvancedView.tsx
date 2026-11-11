'use client'

import type { ReactNode } from 'react'
import { useAdvanced } from '@/lib/advanced'
import type { AgentEvent, MarketView } from '@/lib/api'

/** The switch. One per screen header; the choice is shared by every screen. */
export function AdvancedSwitch() {
  const [on, set] = useAdvanced()
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted" title="Show contracts, tokens, transaction ids and the engine's validation records">
      <input type="checkbox" className="h-6 w-6" checked={on} onChange={(e) => set(e.target.checked)} data-testid="advanced-switch" />
      Advanced view
    </label>
  )
}

/** Renders its children only while the Advanced view is on. */
export function AdvancedOnly({ children }: { children: ReactNode }) {
  const [on] = useAdvanced()
  return on ? <>{children}</> : null
}

/** The Exchange plumbing: how orders settle and the contract that holds escrow. Straight from the market view. */
export function ExchangeAdvanced({ m }: { m: MarketView }) {
  return (
    <AdvancedOnly>
      <dl className="mb-4 grid gap-1 border border-line bg-ink-2 p-3 text-xs" data-testid="advanced-exchange">
        <div className="cz-label !text-[10px]">Advanced</div>
        <div className="grid grid-cols-[10rem_1fr] gap-2"><dt className="text-dim">Settlement mode</dt><dd className="text-fog">{m.settlement === 'near' ? 'NEAR testnet' : 'Off-chain (game economy only)'}</dd></div>
        <div className="grid grid-cols-[10rem_1fr] gap-2"><dt className="text-dim">Order contract</dt><dd className="break-all font-mono text-fog">{m.controller ?? 'none: orders are not escrowed on chain'}</dd></div>
        <div className="grid grid-cols-[10rem_1fr] gap-2"><dt className="text-dim">World tick</dt><dd className="font-mono text-fog">{m.tick} ({m.tick_secs}s each)</dd></div>
        <p className="text-dim">Transaction ids for each order are under its “Transaction details”. Nothing is shown as confirmed until the chain says so.</p>
      </dl>
    </AdvancedOnly>
  )
}

/** The engine's validation record for a decision: what was proposed, and what the rules did with it. */
export function ValidationRecord({ e }: { e: AgentEvent }) {
  const p = e.payload
  return (
    <AdvancedOnly>
      <dl className="mt-1 grid gap-0.5 border border-line bg-ink-2 p-2 text-[11px]" data-testid="advanced-validation">
        <div className="grid grid-cols-[6rem_1fr] gap-2"><dt className="text-dim">Validation</dt><dd className="text-fog">{p.validation ?? 'not recorded'}</dd></div>
        <div className="grid grid-cols-[6rem_1fr] gap-2"><dt className="text-dim">Planner</dt><dd className="text-fog">{p.planner ?? 'not recorded'}</dd></div>
        <div className="grid grid-cols-[6rem_1fr] gap-2"><dt className="text-dim">Trigger</dt><dd className="text-fog">{p.trigger ?? 'not recorded'}</dd></div>
        <div className="grid grid-cols-[6rem_1fr] gap-2"><dt className="text-dim">Action</dt><dd className="break-all font-mono text-fog">{p.action ? JSON.stringify(p.action) : 'none'}</dd></div>
        {p.error && <div className="grid grid-cols-[6rem_1fr] gap-2"><dt className="text-dim">Engine error</dt><dd className="text-hostile">{p.error}</dd></div>}
        <div className="grid grid-cols-[6rem_1fr] gap-2"><dt className="text-dim">Tick / seq</dt><dd className="font-mono text-fog">{e.tick} / {e.seq}</dd></div>
      </dl>
    </AdvancedOnly>
  )
}
