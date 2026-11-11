'use client'

import { useMusicState } from '@/components/audio/AudioProvider'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Panel, Shell, Stat } from '@/components/ui/Shell'
import { NewSupplyOrder, OrderBoard, TradingPartners, useMarket } from '@/components/market/SupplyOrders'
import { GunStatBars } from '@/components/armory/GunStatBars'
import { Tabs } from '@/components/ui/Tabs'
import { countOrders } from '@/lib/market/orders'
import { ScreenTip } from '@/components/help/ScreenTip'
import { AdvancedSwitch, ExchangeAdvanced } from '@/components/help/AdvancedView'
import { IntentsPanel } from '@/components/market/IntentsPanel'
import dynamic from 'next/dynamic'
import { api, RESOURCE_LABEL, type ArmoryItem, type ExchangePrice, type PlayerQuote, type ResourceName, type Standing } from '@/lib/api'
import type { GunId } from '@/engine/combat/GunStats'
import { ItemInspector } from '@/components/inspect/ItemInspector'
import { acceptQuote, disableQuickTrade, enableQuickTrade, loadSessionKey } from '@/lib/auth'
import { useSession } from '@/lib/useSession'
import type { ChainCall } from '@/lib/wallet'

const GunTurntable = dynamic(() => import('@/components/armory/GunTurntable'), { ssr: false })

const ACCEPT_GAS = '60000000000000'

/** Vex's armory: guns as tokens the player owns, at their standing price. */
function Armory({ items, canTrade, busy, onBuy }: { items: ArmoryItem[]; canTrade: boolean; busy: boolean; onBuy: (id: string) => void }) {
  const [inspect, setInspect] = useState<ArmoryItem | null>(null)
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {inspect && <ItemInspector item={{ type: 'weapon', gun: inspect.id as GunId, status: inspect.owned > 0 ? 'owned' : 'locked', owned: inspect.owned, price: inspect.price }} onClose={() => setInspect(null)} />}
      {items.map((g) => (
        <div key={g.id} className="flex flex-col border border-line" data-testid="armory-item">
          <div className="h-32" style={{ background: 'radial-gradient(ellipse at 50% 55%, #23272e 0%, #0e1013 70%)' }}>
            <GunTurntable gunId={g.id as GunId} className="h-full w-full" />
          </div>
          <div className="flex flex-1 flex-col gap-1 p-3">
            <div className="flex items-baseline justify-between">
              <span className="font-display text-lg font-bold uppercase tracking-wider text-fog">{g.title}</span>
              {g.owned > 0 && <span className="text-xs font-semibold uppercase tracking-wider text-friendly">Owned</span>}
            </div>
            <div className="text-sm">
              <span className="cz-num font-semibold text-fog">{g.price.toLocaleString()} cr</span>
              {g.price < g.list_price && <span className="ml-2 text-xs text-muted line-through">{g.list_price.toLocaleString()}</span>}
              <span className="ml-2 text-xs text-muted">{g.stock > 0 ? `${g.stock} in the armory` : 'sold out · restocks within 12 hours'}</span>
            </div>
            <GunStatBars gun={g.id as GunId} compact />
            <div className="text-[11px] text-dim">token <code>{g.token}</code></div>
            <div className="mt-auto flex gap-2">
              <button className="cz-btn cz-btn-primary flex-1 px-4 py-1.5 text-sm" disabled={!canTrade || busy || g.stock < 1} onClick={() => onBuy(g.id)}>
                {g.owned > 0 ? 'Buy another' : 'Buy'}
              </button>
              <button className="cz-btn cz-btn-ghost px-3 py-1.5 text-sm" onClick={() => setInspect(g)} data-testid={`inspect-${g.id}`}>Inspect</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

/** How the region regards the player, from the engine's record of what they did. */
function StandingPanel({ s }: { s: Standing }) {
  const tone = (t: string) => (t === 'Hostile' || t === 'Wary' ? 'text-hostile' : t === 'Neutral' || t === 'Unknown' ? 'text-muted' : 'text-friendly')
  return (
    <div className="grid gap-3 sm:grid-cols-3" data-testid="standing">
      <div>
        <div className="cz-label !text-[10px]">Vex Exchange</div>
        <div className={`font-display text-xl font-bold ${tone(s.vex_tier)}`}>{s.vex_tier}</div>
        <div className="text-xs text-muted">{s.vex_discount_bp > 0 ? `${s.vex_discount_bp / 100}% better prices` : 'list prices'} · {s.vex_traded.toLocaleString()} cr traded</div>
      </div>
      {s.factions.map((f) => (
        <div key={f.actor}>
          <div className="cz-label !text-[10px]">{f.name}</div>
          <div className={`font-display text-xl font-bold ${tone(f.tier)}`}>{f.tier}</div>
          <div className="text-xs text-muted">{f.jobs_for} job{f.jobs_for === 1 ? '' : 's'} for them · {f.operations_against} against them</div>
        </div>
      ))}
    </div>
  )
}
const explorer = (h: string) => `https://testnet.nearblocks.io/txns/${h}`

function QuickTrade({ enabled, onChange }: { enabled: boolean; onChange: () => void }) {
  const { session } = useSession()
  const [credits, setCredits] = useState(500)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  if (!session) return null
  async function go(f: () => Promise<void>) {
    setBusy(true); setErr(null)
    try { await f(); onChange() } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Panel title="QUICK TRADE" className="mt-4">
      {enabled ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-friendly">On: trades go through without a confirmation, within the limits you set.</p>
          <button disabled={busy} onClick={() => go(() => disableQuickTrade(session))} className="text-sm text-slate-400 hover:text-slate-200">turn off</button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-400">
            Skip the confirmation on every trade for 24 hours, spending at most
            <input type="number" min={50} max={10000} step={50} value={credits} onChange={(e) => setCredits(Math.max(50, Number(e.target.value) || 50))} className="mx-2 w-20 rounded border border-line-strong bg-ink-2 px-2 py-0.5 text-sm tabular-nums" aria-label="credit limit" />
            credits and selling at most 50 units. The limits are enforced by the game contract, and you can turn it off anytime.
          </p>
          <button disabled={busy} onClick={() => go(() => enableQuickTrade(session, { credits, units: 50, hours: 24 }))} className="cz-btn cz-btn-ghost px-4 py-1.5 text-sm">
            {busy ? 'Approving…' : 'Turn on'}
          </button>
        </div>
      )}
      {err && <p className="mt-2 text-sm text-hostile">{err}</p>}
    </Panel>
  )
}

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
  const tone = pct < 50 ? 'bg-hostile' : pct < 90 ? 'bg-amber' : 'bg-friendly'
  return (
    <div className="h-1.5 w-full bg-line">
      <div className={`h-1.5 rounded ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

function Row({ p, canTrade, busy, onQuote }: { p: ExchangePrice; canTrade: boolean; busy: boolean; onQuote: (r: ResourceName, side: 'buy' | 'sell', qty: number) => void }) {
  const [qty, setQty] = useState(10)
  const premium = p.scarcity_bp / 10_000
  return (
    <div className="grid items-center gap-3 border-t border-line py-3 first:border-t-0 sm:grid-cols-[1.4fr_1fr_1fr_auto]">
      <div>
        <div className="font-semibold text-slate-100">{RESOURCE_LABEL[p.resource]}</div>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted">
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
          className="w-16 rounded border border-line-strong bg-ink-2 px-2 py-1.5 text-sm tabular-nums outline-none focus:border-amber"
          aria-label={`${p.resource} quantity`}
        />
        <button disabled={!canTrade || busy} onClick={() => onQuote(p.resource, 'buy', qty)} className="cz-btn cz-btn-primary px-3 py-1.5 text-sm">Buy</button>
        <button disabled={!canTrade || busy || p.sell_10 == null} onClick={() => onQuote(p.resource, 'sell', qty)} className="cz-btn cz-btn-ghost px-3 py-1.5 text-sm">Sell</button>
      </div>
    </div>
  )
}

export default function Exchange() {
  useMusicState('table')
  const qc = useQueryClient()
  const { session, loading } = useSession()
  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [quick, setQuick] = useState(false)
  const market = useMarket()
  const [orderMsg, setOrderMsg] = useState<string | null>(null)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const player = session?.account ?? null
  useEffect(() => { setQuick(!!player && !!loadSessionKey(player)) }, [player])
  const ex = useQuery({ queryKey: ['exchange', player], queryFn: () => api.exchange(player), refetchInterval: 5_000 })
  const onChain = ex.data?.settlement === 'near'
  const canTrade = !!session
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
      const q = await api.quote(r, side, qty)
      setTicket({ quote: q.quote, call: q.chain, expiresAt: Date.now() + q.expires_in_secs * 1000, phase: 'ready', txs: q.posted ? [q.posted.tx_hash] : [] })
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function requestGear(id: string) {
    if (!player) return
    setError(null)
    try {
      const q = await api.quoteGear(id)
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
        const { hash } = await acceptQuote(session!, ticket.call)
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
    <Shell title="Exchange" back={{ href: '/', label: 'Hub' }}>
      <ScreenTip tip="exchange" title="How the Exchange works">
        <p>Quick trade sells your haul at once at the posted price. <b className="text-fog">Supply orders</b> are different: a faction short of stock posts an order, and the trading partners each answer with their own offer from their own shelves. Only real offers are listed.</p>
        <p>Open any order to follow it: shortage, order, bids, winner, settlement, arrival, readiness. A step that has not happened yet says it is waiting, and a payment is only marked confirmed when the chain says so.</p>
      </ScreenTip>
      <div className="mb-3 flex justify-end"><AdvancedSwitch /></div>
      {ex.isError && <p className="mb-4 text-hostile">The economy server is not reachable.</p>}

      {!session && (
        <Panel className="mb-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-slate-400">{loading ? 'Checking your sign-in…' : 'Sign in to buy and sell. Prices are live either way.'}</p>
            <Link href="/signin" className="cz-btn cz-btn-primary px-4 py-2 text-sm">Sign in</Link>
          </div>
        </Panel>
      )}

      {session && (
        <Panel title="YOUR STASH">
          {holdings ? (
            <>
              <div className="grid grid-cols-4 gap-3">
                <Stat label="Credits" value={holdings.credits} />
                <Stat label="Ammo" value={holdings.ammo} />
                <Stat label="Med" value={holdings.med} />
                <Stat label="Fuel" value={holdings.fuel} />
              </div>
              {onChain && <p className="mt-2 text-xs text-muted">Owned by your account and recorded on-chain: only you can trade it.</p>}
              {ex.data?.standing && <div className="mt-4 border-t border-line pt-3"><StandingPanel s={ex.data.standing} /></div>}
            </>
          ) : (
            <p className="text-sm text-muted">Loading…</p>
          )}
        </Panel>
      )}

      {session && onChain && session.method !== 'dev' && <QuickTrade enabled={quick} onChange={() => setQuick(!!loadSessionKey(session.account))} />}

      {ticket && q && (
        <Panel title="QUOTE" className="mt-4 !border-amber/50">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="text-lg font-semibold text-slate-100">
                {q.gear ? `Vex sells you a ${q.gear.title} for ${q.total} credits` : q.side === 'buy' ? `Vex sells you ${q.qty} ${q.resource} for ${q.total} credits` : `Vex buys ${q.qty} ${q.resource} from you for ${q.total} credits`}
              </div>
              <div className="text-xs text-muted">
                {q.unit.toFixed(1)} cr/unit · firm price, held for you{ticket.phase === 'ready' ? ` · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left` : ''}
                {ticket.call ? (quick ? ' · quick trade: no confirmation needed' : ' · nothing moves until you confirm') : ' · off-chain mode'}
              </div>
            </div>
            {ticket.phase === 'ready' && left > 0 && (
              <button onClick={accept} disabled={!session} className="cz-btn cz-btn-primary px-5 py-2 text-sm">
                {ticket.call ? (quick ? 'Trade' : 'Confirm trade') : 'Accept (off-chain)'}
              </button>
            )}
            {ticket.phase === 'signing' && <span className="text-sm text-amber-hi">{quick ? 'Trading…' : 'Waiting for your confirmation…'}</span>}
            {ticket.phase === 'confirming' && <span className="text-sm text-amber-hi">Settling…</span>}
            {ticket.phase === 'settled' && <span className="text-sm font-semibold text-friendly">{ticket.call ? 'Done · settled on-chain' : 'Done (off-chain)'}</span>}
            {(ticket.phase === 'settled' || left === 0) && (
              <button onClick={() => setTicket(null)} className="text-sm text-slate-400 hover:text-slate-200">close</button>
            )}
          </div>
          {ticket.message && <p className="mt-2 text-sm text-amber-400">{ticket.message}</p>}
          {ticket.txs.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-3 text-xs">
              {ticket.txs.map((h, i) => (
                <a key={h} href={explorer(h)} target="_blank" rel="noreferrer" className="font-mono text-amber-hi hover:underline">
                  {i === 0 ? 'Vex\'s quote' : i === 1 ? 'your trade' : 'receipt'} {h.slice(0, 8)}…
                </a>
              ))}
            </div>
          )}
        </Panel>
      )}

      {error && <p className="mt-4 text-sm text-hostile">{error}</p>}

      <Tabs label="Exchange sections" tabs={[
        { id: 'trade', label: 'Trade', panel: <>
      {ex.data && ex.data.shortages.length > 0 && (
        <Panel title="MARKET SIGNALS" className="mt-4">
          <ul className="space-y-1 text-sm">
            {ex.data.shortages.map((s) => (
              <li key={`${s.actor}-${s.resource}`} className="text-slate-300">
                <span className="font-semibold text-amber-400">{s.name}</span> is {s.short} {s.resource} short of its target ({s.have}/{s.target}). Its commander will buy from Vex, pushing the {s.resource} price up.{' '}
                <Link href="/contracts" className="text-amber-hi hover:underline">Raid its depots</Link> to deepen the shortage, or sell {s.resource} to Vex while the price is high.
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {ex.data && (
        <Panel title={`MARKET · ${ex.data.merchant.name.toUpperCase()}`} className="mt-4">
          {ex.data.merchant.insolvent && <p className="mb-2 text-sm text-amber-400">Vex is below its credit reserve and not buying.</p>}
          {ex.data.prices.map((p) => (
            <Row key={p.resource} p={p} canTrade={canTrade} busy={!!ticket && ticket.phase !== 'settled' && left > 0} onQuote={requestQuote} />
          ))}
          {!canTrade && <p className="mt-2 text-xs text-muted">Sign in to trade.</p>}
        </Panel>
      )}

      {ex.data && ex.data.trades.length > 0 && (
        <Panel title="YOUR TRADES" className="mt-4">
          <ul className="space-y-1 text-sm tabular-nums text-slate-300">
            {ex.data.trades.map((t) => (
              <li key={t.id}>{t.side === 'buy' ? 'Bought' : 'Sold'} {t.gear ? `a ${ex.data!.armory?.find((g) => g.id === t.gear)?.title ?? t.gear}` : `${t.qty} ${t.resource}`} for {t.total} cr <span className="text-muted">· tick {t.tick}</span></li>
            ))}
          </ul>
        </Panel>
      )}
        </> },
        { id: 'orders', label: 'Supply orders', badge: market.data ? countOrders(market.data.orders).open : undefined, panel: <>
      {market.data && <NewSupplyOrder m={market.data} session={session} onDone={(m) => { setOrderMsg(m); market.refetch() }} />}
      {orderMsg && <p className="mt-2 text-sm text-friendly" role="status" data-testid="order-msg">{orderMsg}</p>}
      {market.data && <OrderBoard m={market.data} session={session} onDone={(m) => { setOrderMsg(m); market.refetch() }} />}
      <IntentsPanel />

        </> },
        { id: 'partners', label: 'Trading partners', panel: <>
      {market.data && <ExchangeAdvanced m={market.data} />}
      {market.data && <TradingPartners m={market.data} />}
        </> },
        { id: 'armory', label: 'Armory', panel: <>
      {ex.data?.armory && (
        <Panel title="ARMORY · OWNED GEAR" className="mt-4">
          <p className="mb-3 text-sm text-muted">Guns you buy here are yours: a token in your account, carried into any contract from the loadout. Standard issue (SMG, assault rifle) is always free.</p>
          <Armory items={ex.data.armory} canTrade={canTrade} busy={!!ticket && ticket.phase !== 'settled' && left > 0} onBuy={requestGear} />
        </Panel>
      )}

        </> },
      ]} />
    </Shell>
  )
}
