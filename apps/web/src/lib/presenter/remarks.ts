// What each voice says about its own position, in its own manner. Authored dialogue, built
// only from the presenters' real statements (what the engine's rules say about the faction or
// merchant right now). A remark explains a state; it never announces a decision or an
// intention ("we will", "I decided"): the economy decides, and the log records it.
// "Resupply is under way" is said only when a real order or convoy is.

import type { FactionPicture, Statement } from './economy'
import type { MerchantPicture } from './merchant'

const first = (s: Statement[]) => s.find((x) => x.severity === 'critical') ?? s.find((x) => x.severity === 'warn') ?? null
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

/** A faction's remark on its own readiness. `resupplying` is true only with a real order or convoy behind it. */
export function factionRemark(id: string, p: FactionPicture, resupplying: boolean): string {
  const worst = first(p.statements)
  const tail = resupplying ? ' Resupply is under way.' : ''
  if (!worst) {
    return id === 'ashen' ? 'Stocked and armed. The yard is running.' : 'All guards armed. Stocks logged and within need.'
  }
  if (id === 'vanguard') return `Logged. ${worst.effect}${tail}`
  if (id === 'ashen') return `${worst.headline.charAt(0) + worst.headline.slice(1).toLowerCase()}. ${worst.effect}${tail}`
  return `${worst.effect}${tail}`
}

/** A merchant's remark on its own trading position. */
export function merchantRemark(id: string, p: MerchantPicture): string {
  const worst = first(p.statements)
  if (p.state === 'insolvent') return id === 'vex' ? `${worst!.effect} That is the market.` : `Status: ${lower(worst!.effect)}`
  if (!worst) return id === 'vex' ? 'Shelves are stocked, and prices follow them.' : 'We can fill orders in both directions.'
  if (id === 'vex') return `${worst.effect} That is the market.`
  return `Note: ${lower(worst.effect)}`
}
