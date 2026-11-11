// Reading the operator's service record: only what the server recorded, no scoring of our own.

import type { Career } from '@/lib/api'
import { IDENTITY } from '@/lib/factions'

type Mission = Career['missions'][number]

/** Extractions as a share of finished runs (extracted + killed). Null until there is one: no rate is made up. */
export function extractionRate(t: Career['totals']): number | null {
  const done = t.extracted + t.lost
  return done > 0 ? Math.round((100 * t.extracted) / done) : null
}

const pretty = (id: string) => IDENTITY[id]?.name ?? id.charAt(0).toUpperCase() + id.slice(1)

/** "Raid on Vanguard's ammo · 20 units · 120 cr", leaving out whatever the record does not have (an operation still in the field has no target yet). */
export function missionLine(m: Mission): string {
  const kind = m.kind ? m.kind.charAt(0).toUpperCase() + m.kind.slice(1) : null
  const what = m.target ? `${kind ?? 'Operation'} on ${pretty(m.target)}${m.resource ? `'s ${m.resource}` : ''}` : kind
  return [what, m.units ? `${m.units} units` : null, m.fee ? `${m.fee} cr` : null].filter(Boolean).join(' · ')
}

export const OUTCOME_LABEL: Record<string, string> = { extracted: 'Extracted', killed: 'Killed in action', expired: 'Abandoned', rejected: 'Rejected', in_progress: 'In the field' }
