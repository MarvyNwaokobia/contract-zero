// Progressive onboarding: one short tip the first time each thing happens (before the
// first fight, the first pickup, the first medical supplies, the first cargo case, the first extraction, the first
// completed contract). A tip never blocks the fight: it is a line under the objective
// banner that fades on its own, and showing it marks it seen. Tips can be turned off
// (Settings → Interface) and replayed (there, or from How to Play).
'use client'

export type Tip = 'controls' | 'loot' | 'heal' | 'cargo' | 'extract' | 'consequence' | 'intel' | 'exchange' | 'table'
export const TIPS: Tip[] = ['controls', 'loot', 'heal', 'cargo', 'extract', 'consequence', 'intel', 'exchange', 'table']
const KEY = 'cz_tips_seen'

function read(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]) } catch { return new Set() }
}

export function tipSeen(t: Tip): boolean {
  return read().has(t)
}

export function markTipSeen(t: Tip): void {
  const s = read()
  if (s.has(t)) return
  s.add(t)
  try { localStorage.setItem(KEY, JSON.stringify([...s])) } catch { /* private mode */ }
}

export function resetTips(): void {
  try { localStorage.removeItem(KEY) } catch { /* private mode */ }
}
