// A merchant's position in plain language, from the same rules the engine uses when it
// answers a supply order (policy.rs merchant_proposals) and prices a shelf (pricing.rs).
// Only effects the engine really has are stated; each statement carries its exact figures.

import type { MarketMerchant, ResourceName } from '@/lib/api'
import type { Factor, Severity, Statement } from './economy'
import { merchantCommit, merchantRoom, scarcityBp, spendable } from './rules'

export type MerchantState = 'trading' | 'stretched' | 'constrained' | 'insolvent'
export const MERCHANT_LABEL: Record<MerchantState, string> = { trading: 'Trading', stretched: 'Stretched', constrained: 'Constrained', insolvent: 'Insolvent' }

export interface MerchantPicture { state: MerchantState; summary: string; statements: Statement[] }

const NAME: Record<ResourceName, string> = { ammo: 'ammunition', med: 'medical supplies', fuel: 'fuel' }
const RES: ResourceName[] = ['ammo', 'med', 'fuel']
const n = (x: number) => x.toLocaleString('en-US')

function shelf(m: MarketMerchant, r: ResourceName): Statement | null {
  const s = m.shelves[r]
  const commit = merchantCommit(s.stock, m.max_commit_bp)
  const room = merchantRoom(s.target, s.stock)
  const scarcity = scarcityBp(s.stock, s.target)
  const factors: Factor[] = [
    { label: `${NAME[r]} on the shelf`, value: `${n(s.stock)} of ${n(s.target)} target` },
    { label: 'It will commit to one order', value: `${n(commit)} (${m.max_commit_bp / 100}% of the shelf)` },
    { label: 'Room it will fill by buying', value: n(room) },
    { label: 'Price multiplier from scarcity', value: `×${(scarcity / 10_000).toFixed(2)}` },
  ]
  const head = NAME[r].toUpperCase()
  if (commit <= 0) return { topic: r, severity: 'critical', headline: `${head} SHELF EMPTY`, effect: `Cannot answer a supply order for ${NAME[r]}: nothing to commit.`, factors }
  if (s.stock < s.target) {
    return { topic: r, severity: 'warn', headline: `${head} SHELF LOW`, effect: `Prices run ${scarcity > 10_000 ? `up to ×${(scarcity / 10_000).toFixed(2)}` : 'higher'} while the shelf is under target.`, factors }
  }
  if (room <= 0) return { topic: r, severity: 'warn', headline: `${head} SHELF FULL`, effect: `Will not bid on supply orders that sell ${NAME[r]} to it.`, factors }
  return null
}

/** Whether it can pay for what it buys: credits above its reserve (policy.rs spendable). */
function treasury(m: MarketMerchant): Statement | null {
  const free = spendable(m.credits, m.credit_reserve)
  const factors: Factor[] = [{ label: 'Credits', value: n(m.credits) }, { label: 'Reserve it will not spend', value: n(m.credit_reserve) }, { label: 'Spendable', value: n(free) }]
  if (m.credits < m.credit_reserve && m.instant_market) {
    return { topic: 'credits', severity: 'critical', headline: 'INSOLVENT', effect: 'Below its credit reserve: it is not buying or restocking until sales recover.', factors }
  }
  if (free === 0) return { topic: 'credits', severity: 'critical', headline: 'CANNOT BID', effect: 'At its credit reserve: it cannot bid on supply orders that sell to it.', factors }
  return null
}

export function describeMerchant(m: MarketMerchant): MerchantPicture {
  const statements = [treasury(m), ...RES.map((r) => shelf(m, r))].filter((s): s is Statement => !!s)
  const worst = (sev: Severity) => statements.some((s) => s.severity === sev)
  let state: MerchantState = 'trading'
  if (m.instant_market && m.credits < m.credit_reserve) state = 'insolvent'
  else if (worst('critical')) state = 'constrained'
  else if (worst('warn')) state = 'stretched'
  const summary = state === 'trading' ? 'Shelves stocked and able to pay: answering supply orders both ways.' : statements.find((s) => s.severity === 'critical')?.effect ?? statements[0].effect
  return { state, summary, statements }
}
