'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Panel, Shell, Stat } from '@/components/ui/Shell'
import { api, loadPlayer, RESOURCE_LABEL, type ExchangePrice, type PlayerQuote, type ResourceName } from '@/lib/api'
import { connect, disconnect, onAccount, restore, signCall, type ChainCall } from '@/lib/wallet'

const ACCEPT_GAS = '60000000000000'
const explorer = (h: string) => `https://testnet.nearblocks.io/txns/${h}`

/** The wallet call for an open quote, rebuilt from its on-chain id (after a reload). */
function callFor(q: PlayerQuote, chainQuote: string, receiver: string): ChainCall {
  const [kind, id] = chainQuote.split(':')
  return kind === 'offer'
    ? { receiver_id: receiver, method: 'accept_offer', args: { offer_id: id, max_total: String(q.total) }, gas: ACCEPT_GAS, deposit: '0' }
    : { receiver_id: receiver, method: 'accept_bid', args: { bid_id: id, min_total: String(q.total) }, gas: ACCEPT_GAS, deposit: '0' }
}

type Ticket = {
  quote: PlayerQuote
  call: ChainCall | null
  expiresAt: number
  phase: 'ready' | 'signing' | 'confirming' | 'settled' | 'released' | 'error'
  message?: string
  txs: string[]
}

function Bar({ have, target }: { have: number; target: number }) {
  const pct = Math.min(100, Math.round((100 * have) / Math.max(1, target)))
  const tone = pct < 50 ? 'bg-rose-500' : pct < 90 ? 'bg-amber-400' : 'bg-emerald-500'
  return (
    <div className="h-1.5 w-full rounded bg-slate-800">
      <div className={`h-1.5 rounded ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

function Row({ p, canTrade, busy, onQuote }: { p: ExchangePrice; canTrade: boolean; busy: boolean; onQuote: (r: ResourceName, side: 'buy' | 'sell', qty: number) => void }) {
  const [qty, setQty] = useState(10)
  const premium = p.scarcity_bp / 10_000
  return (
    <div className="grid items-center gap-3 border-t border-slate-800 py-3 first:border-t-0 sm:grid-cols-[1.4fr_1fr_1fr_auto]">
      <div>
        <div className="font-semibold text-slate-100">{RESOURCE_LABEL[p.resource]}</div>
        <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
          <span className="tabular-nums">Vex holds {p.stock}/{p.target}</span>
          <div className="w-24"><Bar have={p.stock} target={p.target} /></div>
        </div>
        {premium > 1.05 && <div className="text-xs text-amber-400">scarcity ×{premium.toFixed(2)}{p.net_demand_24h > 0 ? ` · ${p.net_demand_24h} sold in 24h` : ''}</div>}
      </div>
      <Stat label="Vex sells at" value={`${p.ask} cr`} hint={p.buy_10 != null ? `10 for ${p.buy_10}` : 'out of stock'} />
      <Stat label="Vex buys at" value={`${p.bid} cr`} hint={p.sell_10 != null ? `10 for ${p.sell_10}` : 'not buying'} />
      <div className="flex items-center gap-2">
        <input
          type="number" min={1} max={500} value={qty}
          onChange={(e) => setQty(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
          className="w-16 rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm tabular-nums outline-none focus:border-cyan-500"
          aria-label={`${p.resource} quantity`}
        />
        <button disabled={!canTrade || busy} onClick={() => onQuote(p.resource, 'buy', qty)} className="rounded bg-cyan-500 px-3 py-1.5 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-40">Buy</button>
        <button disabled={!canTrade || busy || p.sell_10 == null} onClick={() => onQuote(p.resource, 'sell', qty)} className="rounded border border-cyan-600 px-3 py-1.5 text-sm font-semibold text-cyan-300 hover:bg-cyan-950 disabled:opacity-40">Sell</button>
      </div>
    </div>
  )
}

export default function Exchange() {
  const qc = useQueryClient()
  const [wallet, setWallet] = useState<string | null>(null)
  const [typed, setTyped] = useState<string | null>(null)
  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    setTyped(loadPlayer())
    restore().then(setWallet)
    const off = onAccount(setWallet)
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => { off(); clearInterval(t) }
  }, [])

  const player = wallet ?? typed
  const ex = useQuery({ queryKey: ['exchange', player], queryFn: () => api.exchange(player), refetchInterval: 5_000 })
  const onChain = ex.data?.settlement === 'near'
  const canTrade = !!player && (!onChain || !!wallet)
  const holdings = onChain ? ex.data?.chain_holdings : ex.data?.engine_holdings

  // Resume an open quote after a reload.
  const open = ex.data?.open_quote
  useEffect(() => {
    if (!open || ticket) return
    api.quoteState(open.id).then((s) => {
      if (s.status !== 'open') return
      const receiver = 'world2.contract-zero.testnet'
      setTicket({ quote: s.quote, call: s.chain_quote ? callFor(s.quote, s.chain_quote, receiver) : null, expiresAt: Date.now() + s.expires_in_secs * 1000, phase: 'ready', txs: s.tx_hashes })
    }).catch(() => {})
  }, [open, ticket])

  async function requestQuote(r: ResourceName, side: 'buy' | 'sell', qty: number) {
    if (!player) return
    setError(null)
    try {
      const q = await api.quote(player, r, side, qty)
      setTicket({ quote: q.quote, call: q.chain, expiresAt: Date.now() + q.expires_in_secs * 1000, phase: 'ready', txs: q.posted ? [q.posted.tx_hash] : [] })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function accept() {
    if (!ticket) return
    const id = ticket.quote.id
    try {
      if (!ticket.call) {
        const s = await api.acceptOffChain(id)
        setTicket({ ...ticket, phase: s.status === 'settled' ? 'settled' : 'error', message: 'Settled in the economy only (off-chain mode).' })
      } else {
        setTicket({ ...ticket, phase: 'signing' })
        const { hash, result } = await signCall(ticket.call)
        if (result === 'false') throw new Error('the ledger refused the trade (callback returned false); nothing moved')
        setTicket((t) => t && { ...t, phase: 'confirming', txs: [...t.txs, hash] })
        let s = await api.confirmQuote(id, hash || undefined)
        for (let i = 0; i < 10 && s.status === 'open'; i++) {
          await new Promise((res) => setTimeout(res, 3000))
          s = await api.confirmQuote(id)
        }
        setTicket((t) => t && { ...t, phase: s.status === 'settled' && s.settled_on_chain ? 'settled' : 'error', txs: s.tx_hashes, message: s.status === 'settled' ? undefined : `still ${s.status}` })
      }
    } catch (e) {
      setTicket((t) => t && { ...t, phase: 'ready', message: (e as Error).message })
    }
    qc.invalidateQueries({ queryKey: ['exchange'] })
  }

  const left = ticket ? Math.max(0, Math.round((ticket.expiresAt - now) / 1000)) : 0
  const q = ticket?.quote

  return (
    <Shell title="Exchange" back={{ href: '/', label: 'Main Menu' }}>
      {ex.isError && <p className="mb-4 text-rose-400">The economy server is not reachable.</p>}

      <div className="grid gap-4 md:grid-cols-[1fr_1.4fr]">
        <Panel title="OPERATOR">
          {wallet ? (
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-semibold text-slate-100">{wallet}</div>
                <div className="text-xs text-emerald-400">Wallet connected: you sign your own trades</div>
              </div>
              <button className="text-sm text-slate-400 hover:text-slate-200" onClick={() => disconnect()}>disconnect</button>
            </div>
          ) : (
            <div className="space-y-2">
              <button onClick={() => connect().then(setWallet).catch((e) => setError(String(e?.message ?? e)))} className="w-full rounded bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400">
                Connect NEAR wallet
              </button>
              {typed && <p className="text-xs text-slate-500">Viewing as {typed}. {onChain ? 'Trading on NEAR needs that account\'s wallet.' : ''}</p>}
            </div>
          )}
        </Panel>

        <Panel title={onChain ? 'YOUR HOLDINGS (ON NEAR)' : 'YOUR HOLDINGS'}>
          {holdings ? (
            <>
              <div className="grid grid-cols-4 gap-3">
                <Stat label="Credits" value={holdings.credits} />
                <Stat label="Ammo" value={holdings.ammo} />
                <Stat label="Med" value={holdings.med} />
                <Stat label="Fuel" value={holdings.fuel} />
              </div>
              {onChain && <p className="mt-2 text-xs text-slate-500">NEP-245 tokens on assets.contract-zero.testnet, owned by your account. Any NEP-245 wallet can move them.</p>}
            </>
          ) : (
            <p className="text-sm text-slate-500">Connect a wallet to see what you own.</p>
          )}
        </Panel>
      </div>

      {ex.data && ex.data.shortages.length > 0 && (
        <Panel title="MARKET SIGNALS" className="mt-4">
          <ul className="space-y-1 text-sm">
            {ex.data.shortages.map((s) => (
              <li key={`${s.actor}-${s.resource}`} className="text-slate-300">
                <span className="font-semibold text-amber-400">{s.name}</span> is {s.short} {s.resource} short of its target ({s.have}/{s.target}). Its commander will buy from Vex, pushing the {s.resource} price up.{' '}
                <Link href="/contracts" className="text-cyan-400 hover:underline">Raid its depots</Link> to deepen the shortage, or sell {s.resource} to Vex while the price is high.
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {ticket && q && (
        <Panel title="QUOTE" className="mt-4 border-cyan-800">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="text-lg font-semibold text-slate-100">
                {q.side === 'buy' ? `Vex sells you ${q.qty} ${q.resource} for ${q.total} credits` : `Vex buys ${q.qty} ${q.resource} from you for ${q.total} credits`}
              </div>
              <div className="text-xs text-slate-500">
                {q.unit.toFixed(1)} cr/unit · firm price, held for you{ticket.phase === 'ready' ? ` · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left` : ''}
                {ticket.call ? ' · you sign it with your wallet; nothing moves until you do' : ' · off-chain mode'}
              </div>
            </div>
            {ticket.phase === 'ready' && left > 0 && (
              <button onClick={accept} disabled={onChain && !wallet} className="rounded bg-cyan-500 px-5 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-40">
                {ticket.call ? 'Sign with wallet' : 'Accept (off-chain)'}
              </button>
            )}
            {ticket.phase === 'signing' && <span className="text-sm text-cyan-300">Waiting for your wallet…</span>}
            {ticket.phase === 'confirming' && <span className="text-sm text-cyan-300">Confirming on NEAR…</span>}
            {ticket.phase === 'settled' && <span className="text-sm font-semibold text-emerald-400">{ticket.call ? 'Settled on NEAR' : 'Settled (off-chain)'}</span>}
            {(ticket.phase === 'settled' || left === 0) && (
              <button onClick={() => setTicket(null)} className="text-sm text-slate-400 hover:text-slate-200">close</button>
            )}
          </div>
          {ticket.message && <p className="mt-2 text-sm text-amber-400">{ticket.message}</p>}
          {ticket.txs.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-3 text-xs">
              {ticket.txs.map((h, i) => (
                <a key={h} href={explorer(h)} target="_blank" rel="noreferrer" className="font-mono text-cyan-400 hover:underline">
                  {i === 0 ? 'Vex posted' : i === 1 ? 'you signed' : 'tx'} {h.slice(0, 8)}…
                </a>
              ))}
            </div>
          )}
        </Panel>
      )}

      {error && <p className="mt-4 text-sm text-rose-400">{error}</p>}

      {ex.data && (
        <Panel title={`MARKET · ${ex.data.merchant.name.toUpperCase()}`} className="mt-4">
          {ex.data.merchant.insolvent && <p className="mb-2 text-sm text-amber-400">Vex is below its credit reserve and not buying.</p>}
          {ex.data.prices.map((p) => (
            <Row key={p.resource} p={p} canTrade={canTrade} busy={!!ticket && ticket.phase !== 'settled' && left > 0} onQuote={requestQuote} />
          ))}
          {!canTrade && <p className="mt-2 text-xs text-slate-500">{player ? 'Connect the wallet for this account to trade.' : 'Connect a wallet to trade.'}</p>}
        </Panel>
      )}

      {ex.data && ex.data.trades.length > 0 && (
        <Panel title="YOUR TRADES" className="mt-4">
          <ul className="space-y-1 text-sm tabular-nums text-slate-300">
            {ex.data.trades.map((t) => (
              <li key={t.id}>{t.side === 'buy' ? 'Bought' : 'Sold'} {t.qty} {t.resource} for {t.total} cr <span className="text-slate-500">· tick {t.tick}</span></li>
            ))}
          </ul>
        </Panel>
      )}
    </Shell>
  )
}
