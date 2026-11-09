'use client'

// The official NEAR Intents protocol (1Click API), live but read-only: supported assets
// and real dry quotes from the mainnet service. Clearly separate from the game's own
// Supply Orders: different network, different settlement, and no execution here.

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type IntentsQuote } from '@/lib/api'
import { Panel } from '@/components/ui/Shell'

const PAIRS = [
  { label: '0.1 wNEAR → USDC', origin: 'nep141:wrap.near', destination: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', amount: '100000000000000000000000' },
  { label: '0.1 wNEAR → ETH', origin: 'nep141:wrap.near', destination: 'nep141:eth.bridge.near', amount: '100000000000000000000000' },
  { label: '10 ammo (CZ) → wNEAR', origin: 'nep245:assets.contract-zero.testnet:ammo', destination: 'nep141:wrap.near', amount: '10' },
]

export function IntentsPanel() {
  const ov = useQuery({ queryKey: ['intents'], queryFn: api.intents, staleTime: 60_000 })
  const [q, setQ] = useState<{ label: string; r?: IntentsQuote; err?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async (p: (typeof PAIRS)[number]) => {
    setBusy(true)
    try { setQ({ label: p.label, r: await api.intentsQuote({ origin_asset: p.origin, destination_asset: p.destination, amount: p.amount }) }) } catch (e) { setQ({ label: p.label, err: (e as Error).message }) }
    setBusy(false)
  }
  const o = ov.data
  return (
    <Panel title="NEAR INTENTS · OFFICIAL PROTOCOL" className="mt-4">
      <div className="mb-2 inline-flex items-center gap-2 border border-steel/50 bg-steel-lo/40 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-steel" data-testid="intents-path">Mainnet · 1Click · dry quotes only · not executed</div>
      <p className="text-xs text-muted">The real NEAR Intents network: solvers compete to fill cross-chain swaps, settled by the Verifier at <span className="font-mono">intents.near</span> on mainnet (there is no testnet Verifier). CONTRACT ZERO&apos;s Supply Orders above are the game&apos;s own intents, settled on testnet; they are not NEAR Intents transactions. Game credits have no exchange rate to any real token.</p>
      {o && (
        <div className="mt-2 grid gap-1 font-mono text-xs text-fog" data-testid="intents-overview">
          <div>{o.reachable ? `${o.supported_assets} assets across ${o.chains.length} chains supported` : `1Click unreachable: ${o.error}`}</div>
          <div>CONTRACT ZERO assets supported: <span className={o.contract_zero_assets_supported ? 'text-friendly' : 'text-amber-hi'}>{o.contract_zero_assets_supported ? 'yes' : 'no'}</span> (checked against the live list)</div>
          <div>Execution: {o.adapter.execution}</div>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {PAIRS.map((p) => <button key={p.label} disabled={busy} onClick={() => run(p)} className="cz-btn cz-btn-ghost px-3 py-1 text-[11px]" data-testid={`intents-quote-${p.label.split(' ')[1]}${p.label.includes('ETH') ? '-eth' : ''}`}>{p.label}</button>)}
      </div>
      {q && (
        <div className="mt-3 border border-line bg-ink-2 p-3 font-mono text-xs" data-testid="intents-result">
          <div className="mb-1 text-muted">{q.label}</div>
          {q.err ? <div className="text-[#ff8a8d]">{q.err}</div> : q.r && (
            <div className="grid gap-0.5 text-fog">
              <div>Receive ≈ <span className="text-steel">{q.r.quote.amount_out_formatted ?? q.r.quote.amount_out}</span>{q.r.quote.amount_out_usd ? ` (~$${Number(q.r.quote.amount_out_usd).toFixed(3)})` : ''}</div>
              <div>Minimum received: {q.r.quote.min_amount_out ?? '—'} (base units)</div>
              <div>Fees: {(q.r.quote.app_fees ?? []).map((f) => `${f.fee} bps`).join(', ') || 'none listed'} · est. {q.r.quote.time_estimate_secs ?? '?'} s</div>
              <div>Quote expires {new Date(q.r.quote.deadline).toLocaleTimeString()}{q.r.expired ? ' (expired)' : ''}</div>
              <div className="text-dim">Reference {q.r.quote.correlation_id} · {q.r.quote.dry ? 'dry quote: no deposit address, nothing can be sent' : 'live quote'}</div>
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}
