export const RANKS = ['Iron', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Emerald', 'Diamond'] as const
export type Rank = (typeof RANKS)[number]

export const RANK_COLORS: Record<Rank, string> = {
  Iron: '#8a8f98',
  Bronze: '#cd7f32',
  Silver: '#c0c0c0',
  Gold: '#ffd700',
  Platinum: '#e5e4e2',
  Emerald: '#34d399',
  Diamond: '#b9f2ff',
}

// XP to REACH each rank: the size of the bar you fill while sitting at the rank below.
// Progressive, so the first rank stays cheap and the top stays rare. Rank is
// reputation only: it never pays currency. Credits come from contracts.
export const RANK_STEP_XP: Record<Rank, number> = {
  Iron: 0,          // the floor, never reached via a rank-up
  Bronze: 400,
  Silver: 900,
  Gold: 1300,
  Platinum: 2500,
  Emerald: 4500,
  Diamond: 8000,
}

// Past Diamond every prestige costs this, forever (uncapped).
export const PRESTIGE_STEP_XP = 8000

/** Size of the XP bar for a player currently AT `rank`: what they must fill to advance. */
export function xpForNextRank(rank: Rank): number {
  const next = RANKS[RANKS.indexOf(rank) + 1]
  return next ? RANK_STEP_XP[next] : PRESTIGE_STEP_XP
}
