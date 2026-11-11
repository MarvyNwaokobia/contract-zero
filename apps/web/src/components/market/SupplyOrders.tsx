'use client'

// Supply Orders in the Exchange: trading partners competing for your business, your
// bounded orders, and every faction's orders in the open market. A player's order is
// signed in their own wallet (or within a quick-trade budget): place, accept, cancel.
// The server only applies a step to the game after reading it back from the chain.

import { MerchantSummary } from '@/components/world/Readiness'
import { FactionDossier } from '@/components/world/FactionDossier'
import { OrderChain } from '@/components/market/Procurement'
import { describeMerchant } from '@/lib/presenter/merchant'
import { merchantRemark } from '@/lib/presenter/remarks'
import { FactionInsignia } from '@/components/ui/FactionInsignia'
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type MarketMerchant, type MarketOrder, type MarketView, type OrderProposal, type ResourceName } from '@/lib/api'
import { acceptQuote, type Session } from '@/lib/auth'
import { Panel } from '@/components/ui/Shell'

const RES: ResourceName[] = ['ammo', 'med', 'fuel']
const RES_LABEL: Record<ResourceName, string> = { ammo: 'Ammunition', med: 'Medical', fuel: 'Fuel' }
const explorer = (h: string) => `https://testnet.nearblocks.io/txns/${h}`
const unit = (total: number, qty: number) => (qty ? Math.round((total / qty) * 10) / 10 : 0)

/** Who's selling and buying, on what terms. */
export function TradingPartners({ m }: { m: MarketView }) {
  return (
    <Panel title="TRADING PARTNERS" className="mt-4">
      <p className="mb-3 text-xs text-muted">Every supply order goes to all of them. Each prices from its own shelves and margin, may decline, and reprices when it keeps winning or losing.</p>
      <div className="grid gap-3 md:grid-cols-2" data-testid="trading-partners">
        {m.merchants.map((x) => <PartnerCard key={x.id} x={x} />)}
      </div>
    </Panel>
  )
}

function PartnerCard({ x }: { x: MarketMerchant }) {
  const r = x.record
  return (
    <div className="border border-line bg-ink-2 p-3" data-testid={`partner-${x.id}`}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-center gap-2 font-display text-lg font-bold uppercase tracking-wider text-fog"><FactionInsignia id={x.id} className="h-7 w-7" title={x.name} />{x.name}</div>
        <div className="font-mono text-xs text-steel">{x.margin_bp / 100}% margin</div>
      </div>
      <div className="mt-0.5 text-xs text-dim">{x.instant_market ? 'Also runs the instant market. ' : ''}Commits up to {x.max_commit_bp / 100}% of a shelf per order · never below {x.min_margin_bp / 100}% over cost</div>
      <div className="mt-2"><MerchantSummary m={x} /></div>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-steel hover:text-fog">Who runs it</summary>
        <div className="mt-2"><FactionDossier id={x.id} remark={merchantRemark(x.id, describeMerchant(x))} compact /></div>
      </details>
      <table className="mt-2 w-full text-sm">
        <thead><tr className="text-left text-[11px] uppercase tracking-wider text-dim"><th className="font-normal">Shelf</th><th className="font-normal">Stock</th><th className="font-normal">Sells at</th><th className="font-normal">Buys at</th></tr></thead>
        <tbody>
          {RES.map((k) => {
            const s = x.shelves[k]
            return (
              <tr key={k} className="border-t border-line/60">
                <td className="py-1 text-fog">{RES_LABEL[k]}</td>
                <td className="font-mono tabular-nums text-fog">{s.stock}<span className="text-dim">/{s.target}</span>{s.reserved ? <span className="ml-1 text-[11px] text-amber-hi">({s.reserved} held)</span> : null}</td>
                <td className="font-mono tabular-nums text-steel">{s.ask ?? '—'}</td>
                <td className="font-mono tabular-nums text-steel">{s.bid ?? '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="mt-2 font-mono text-[11px] text-muted">Won {r.wins} · lost {r.losses} · {r.units_sold} sold · {r.units_bought} bought</div>
    </div>
  )
}

/** Place a bounded supply order. */
export function NewSupplyOrder({ m, session, onDone }: { m: MarketView; session: Session | null; onDone: (msg: string) => void }) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [res, setRes] = useState<ResourceName>('ammo')
  const [qty, setQty] = useState(20)
  const [partial, setPartial] = useState(true)
  const [hours, setHours] = useState(6)
  const best = useMemo(() => {
    const quotes = m.merchants.map((x) => (side === 'buy' ? x.shelves[res].ask : x.shelves[res].bid)).filter((v): v is number => v != null)
    if (!quotes.length) return null
    return side === 'buy' ? Math.min(...quotes) : Math.max(...quotes)
  }, [m, side, res])
  const [limit, setLimit] = useState<number | null>(null)
  const suggested = best ? Math.ceil(best * qty * (side === 'buy' ? 1.15 : 0.9)) : 0
  const limitTotal = limit ?? suggested
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const maxHours = Math.max(1, Math.floor(3600 / m.tick_secs))
  const submit = async () => {
    if (!session) return
    setBusy(true); setErr(null)
    try {
      const prep = await api.prepareOrder({ side, resource: res, qty, limit_total: limitTotal, allow_partial: partial, ttl_ticks: Math.min(hours, maxHours) })
      const { hash } = await acceptQuote(session, { receiver_id: prep.call.receiver_id, method: prep.call.method, args: prep.call.args as Record<string, string>, gas: prep.call.gas })
      // The chain is the authority: wait until the order shows up there, then record it.
      let last: unknown
      for (let i = 0; i < 8; i++) {
        try { await api.confirmOrder(prep.order_id, hash); onDone(`Supply Order placed. Your ${side === 'buy' ? 'credits' : 'goods'} are held until it fills, expires or you cancel.`); setBusy(false); return } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500)) }
      }
      throw last
    } catch (e) {
      setErr((e as Error).message)
    }
    setBusy(false)
  }
  if (m.settlement !== 'near') return null
  return (
    <Panel title="NEW SUPPLY ORDER" className="mt-4">
      {!session ? <p className="text-sm text-muted">Sign in to place supply orders.</p> : (
        <div className="grid gap-3 md:grid-cols-[repeat(5,minmax(0,1fr))_auto] md:items-end" data-testid="new-order">
          <label className="text-xs text-dim">I want to
            <select value={side} onChange={(e) => { setSide(e.currentTarget.value as 'buy' | 'sell'); setLimit(null) }} className="mt-1 block w-full border border-line-strong bg-ink-2 px-2 py-1.5 text-sm text-fog" data-testid="order-side">
              <option value="buy">Buy</option><option value="sell">Sell</option>
            </select>
          </label>
          <label className="text-xs text-dim">Supplies
            <select value={res} onChange={(e) => { setRes(e.currentTarget.value as ResourceName); setLimit(null) }} className="mt-1 block w-full border border-line-strong bg-ink-2 px-2 py-1.5 text-sm text-fog" data-testid="order-resource">
              {RES.map((r) => <option key={r} value={r}>{RES_LABEL[r]}</option>)}
            </select>
          </label>
          <label className="text-xs text-dim">Quantity
            <input type="number" min={1} max={500} value={qty} onChange={(e) => { setQty(Math.max(1, Number(e.currentTarget.value) || 1)); setLimit(null) }} className="mt-1 block w-full border border-line-strong bg-ink-2 px-2 py-1.5 font-mono text-sm text-fog" data-testid="order-qty" />
          </label>
          <label className="text-xs text-dim">{side === 'buy' ? 'Spend at most (cr)' : 'Receive at least (cr)'}
            <input type="number" min={1} value={limitTotal} onChange={(e) => setLimit(Math.max(1, Number(e.currentTarget.value) || 1))} className="mt-1 block w-full border border-line-strong bg-ink-2 px-2 py-1.5 font-mono text-sm text-fog" data-testid="order-limit" />
          </label>
          <label className="text-xs text-dim">Open for (hours)
            <input type="number" min={1} max={maxHours} value={hours} onChange={(e) => setHours(Math.max(1, Math.min(maxHours, Number(e.currentTarget.value) || 1)))} className="mt-1 block w-full border border-line-strong bg-ink-2 px-2 py-1.5 font-mono text-sm text-fog" />
          </label>
          <button disabled={busy || limitTotal < 1} onClick={submit} className="cz-btn cz-btn-primary px-5 py-2 text-xs" data-testid="order-place">{busy ? 'Placing…' : 'Place order'}</button>
          <label className="flex items-center gap-2 text-xs text-muted md:col-span-6">
            <input type="checkbox" checked={partial} onChange={(e) => setPartial(e.currentTarget.checked)} className="accent-amber" /> Accept partial fills (several partners can each fill part)
            {best != null && <span className="ml-auto text-dim">Best {side === 'buy' ? 'ask' : 'bid'} now: <span className="font-mono text-steel">{best} cr/unit</span> · your limit: <span className="font-mono text-steel">{unit(limitTotal, qty)} cr/unit</span></span>}
          </label>
          {err && <p className="text-sm text-[#ff8a8d] md:col-span-6" data-testid="order-error">{err}</p>}
        </div>
      )}
    </Panel>
  )
}

/** Orders in the market: yours first, then every faction's. */
export function OrderBoard({ m, session, onDone }: { m: MarketView; session: Session | null; onDone: (msg: string) => void }) {
  const mine = m.orders.filter((o) => session && o.requester === `player:${session.account}`)
  const others = m.orders.filter((o) => !mine.includes(o)).slice(0, 12)
  return (
    <>
      {session && (
        <Panel title="YOUR SUPPLY ORDERS" className="mt-4">
          {mine.length ? mine.map((o) => <OrderCard key={o.id} o={o} m={m} session={session} onDone={onDone} />) : <p className="text-sm text-muted">None yet.</p>}
        </Panel>
      )}
      <Panel title="MARKET · SUPPLY ORDERS" className="mt-4">
        <p className="mb-2 text-xs text-muted">What the factions are asking for, and who fills it.</p>
        <div data-testid="market-orders">{others.length ? others.map((o) => <OrderCard key={o.id} o={o} m={m} session={null} onDone={onDone} />) : <p className="text-sm text-muted">No orders yet.</p>}</div>
      </Panel>
    </>
  )
}

const statusLabel = (o: MarketOrder) => {
  const s = o.status.status
  if (s === 'filled') return o.side === 'buy' ? 'Order Filled' : 'Credits Received'
  if (s === 'expired') return o.filled ? 'Expired (partly filled)' : 'Order Expired'
  if (s === 'cancelled') return 'Cancelled'
  return o.filled ? `Partly filled · ${o.filled}/${o.qty}` : 'Open'
}

function OrderCard({ o, m, session, onDone }: { o: MarketOrder; m: MarketView; session: Session | null; onDone: (msg: string) => void }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const open = o.status.status === 'open'
  const pending = o.proposals.filter((p) => p.status === 'pending')
  // Best Offer: the lowest price per unit to buy, the highest to sell.
  const ranked = [...pending].sort((a, b) => (o.side === 'buy' ? a.total * b.qty - b.total * a.qty : b.total * a.qty - a.total * b.qty))
  const onChain = (p: OrderProposal) => o.settlement.some((s) => s.op_id === `propose:${o.chain_id}|${p.chain_proposal_id}` && s.status === 'confirmed')
  const sign = async (method: string, args: Record<string, string>) => {
    if (!session || !m.controller) throw new Error('sign in first')
    return acceptQuote(session, { receiver_id: m.controller, method, args, gas: method === 'accept_proposal' ? '110000000000000' : '70000000000000' })
  }
  const retry = async (f: () => Promise<unknown>) => { let last: unknown; for (let i = 0; i < 8; i++) { try { return await f() } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500)) } } throw last }
  const accept = async (p: OrderProposal) => {
    setBusy(`p${p.id}`); setErr(null)
    try {
      const { hash } = await sign('accept_proposal', { order_id: o.chain_id, proposal_id: p.chain_proposal_id })
      await retry(() => api.acceptOrderProposal(o.id, p.id, hash))
      onDone(o.side === 'buy' ? `Order Filled: ${p.qty} ${RES_LABEL[o.resource].toLowerCase()} from ${p.merchant_name}.` : `Credits Received: ${p.total} cr from ${p.merchant_name}.`)
      await qc.invalidateQueries()
    } catch (e) { setErr((e as Error).message) }
    setBusy(null)
  }
  const cancel = async () => {
    setBusy('cancel'); setErr(null)
    try {
      const { hash } = await sign('cancel_order', { order_id: o.chain_id })
      await retry(() => api.cancelOrder(o.id, hash))
      onDone('Order cancelled; your escrow is on its way back.')
      await qc.invalidateQueries()
    } catch (e) { setErr((e as Error).message) }
    setBusy(null)
  }
  return (
    <div className="border-b border-line/70 py-3 last:border-b-0" data-testid={`order-${o.id}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-display text-sm font-bold uppercase tracking-wider text-fog">{o.requester_name}</span>
        <span className="text-sm text-fog">{o.side === 'buy' ? 'wants' : 'sells'} {o.qty} {RES_LABEL[o.resource].toLowerCase()}</span>
        <span className="font-mono text-xs text-steel">{o.side === 'buy' ? '≤' : '≥'} {o.limit_total} cr ({unit(o.limit_total, o.qty)}/unit)</span>
        {o.urgency >= 2 && <span className="bg-hostile/15 px-1.5 text-[11px] font-bold uppercase tracking-wider text-[#ff8a8d]">{o.urgency === 3 ? 'Critical' : 'Urgent'}</span>}
        <span className={`ml-auto text-xs font-bold uppercase tracking-wider ${open ? 'text-amber-hi' : o.status.status === 'filled' ? 'text-friendly' : 'text-dim'}`} data-testid={`order-status-${o.id}`}>{statusLabel(o)}</span>
      </div>
      {o.purpose && <div className="text-xs text-dim">{o.purpose}</div>}
      {(ranked.length > 0 || o.fills.length > 0) && (
        <ul className="mt-2 grid gap-1">
          {o.fills.map((f) => (
            <li key={`f${f.proposal}`} className="flex flex-wrap items-center gap-2 text-sm"><span className="text-friendly">✓</span><span className="text-fog">{m.merchants.find((x) => x.id === f.merchant)?.name ?? f.merchant}</span><span className="font-mono text-steel">{f.qty} for {f.total} cr ({unit(f.total, f.qty)}/unit)</span></li>
          ))}
          {ranked.map((p, i) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
              {i === 0 && <span className="bg-amber px-1.5 text-[10px] font-bold uppercase tracking-wider text-[#1a1206]">Best Offer</span>}
              <span className="text-fog">{p.merchant_name ?? p.merchant}</span>
              <span className="font-mono text-steel">{p.qty} for {p.total} cr ({unit(p.total, p.qty)}/unit)</span>
              {p.note && <span className="text-xs text-dim">· {p.note}</span>}
              {session && open && (onChain(p)
                ? <button disabled={!!busy} onClick={() => accept(p)} className="cz-btn cz-btn-ghost ml-auto px-3 py-1 text-[11px]" data-testid={`accept-${p.id}`}>{busy === `p${p.id}` ? 'Accepting…' : 'Accept'}</button>
                : <span className="ml-auto text-[11px] text-dim">posting to chain…</span>)}
            </li>
          ))}
        </ul>
      )}
      {open && !ranked.length && <div className="mt-1 text-xs text-dim">Waiting for trading partners…</div>}
      {session && open && <button disabled={!!busy} onClick={cancel} className="mt-2 text-xs text-muted underline hover:text-fog" data-testid={`cancel-${o.id}`}>{busy === 'cancel' ? 'Cancelling…' : 'Cancel order'}</button>}
      {err && <p className="mt-1 text-sm text-[#ff8a8d]">{err}</p>}
      <OrderChain order={o} />
      {o.settlement.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[11px] uppercase tracking-wider text-dim hover:text-fog">Transaction details</summary>
          <ul className="mt-1 grid gap-0.5 font-mono text-[11px] text-muted">
            <li>Order <span className="text-fog">{o.chain_id}</span> on {m.controller} (CONTRACT ZERO supply order, NEAR testnet)</li>
            {o.settlement.map((s) => (
              <li key={s.op_id}>{s.op_id} · <span className={s.status === 'confirmed' ? 'text-friendly' : 'text-amber-hi'}>{s.status}</span>{s.tx_hashes.map((h) => <a key={h} href={explorer(h)} target="_blank" rel="noreferrer" className="ml-2 text-steel underline">{h.slice(0, 8)}…</a>)}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

export function useMarket() {
  return useQuery({ queryKey: ['market'], queryFn: api.market, refetchInterval: 5_000 })
}
