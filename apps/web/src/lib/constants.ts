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

// G$ for REACHING a rank — it GROWS with the rank (500 more each step): the higher you
// climb, the bigger the payout. Mirrors the server's rank_up_reward_g (STEP × ordinal)
// in apps/api battles.rs. Iron is the start (never reached via a rank-up).
export const RANK_G_REWARD: Record<Rank, number> = {
  Iron: 500,       // unused (you start here)
  Bronze: 500,     // 1st rank-up
  Silver: 1000,    // 2nd
  Gold: 1500,      // 3rd
  Platinum: 2000,  // 4th
  Emerald: 2500,   // 5th
  Diamond: 3000,   // 6th
}

// XP to REACH each rank: the size of the bar you fill while sitting at the rank below.
// PROGRESSIVE, so the first rank stays cheap (it carries retention) while the top stays
// rare (it carries prestige). A flat cost was the old design error: at 5000 flat, the
// entire 15-op campaign played perfectly (~2610 XP) could not buy even one rank.
// Calibrated so Bronze lands in the first session and one full campaign clear lands Gold.
// MUST match RANK_STEP_XP in apps/api battles.rs.
export const RANK_STEP_XP: Record<Rank, number> = {
  Iron: 0,          // the floor — never reached via a rank-up
  Bronze: 400,      // 1st rank-up, ~op 3 of the first run
  Silver: 900,      // 2nd, mid-campaign
  Gold: 1300,       // 3rd, one full campaign clear
  Platinum: 2500,   // 4th
  Emerald: 4500,    // 5th
  Diamond: 8000,    // 6th
}

// Past Diamond every prestige costs this, forever (uncapped).
export const PRESTIGE_STEP_XP = 8000

/** Size of the XP bar for a player currently AT `rank` — what they must fill to advance. */
export function xpForNextRank(rank: Rank): number {
  const next = RANKS[RANKS.indexOf(rank) + 1]
  return next ? RANK_STEP_XP[next] : PRESTIGE_STEP_XP
}

/**
 * G$ paid for the player's NEXT promotion. RANK_G_REWARD is keyed by the rank being
 * REACHED, so reading it with the player's current rank shows what they were already
 * paid, not what they are climbing toward (a Bronze player saw "next rank reward: 500"
 * when Silver actually pays 1000). At the top the next step is a prestige, which pays
 * the Diamond rate.
 */
export function nextRankReward(rank: Rank): number {
  const next = RANKS[RANKS.indexOf(rank) + 1]
  return RANK_G_REWARD[next ?? 'Diamond']
}

/** Total career XP needed to legitimately hold `rank` (cumulative down the curve). */
export function cumulativeXpForRank(rank: Rank): number {
  const i = RANKS.indexOf(rank)
  return RANKS.slice(0, i + 1).reduce((sum, r) => sum + RANK_STEP_XP[r], 0)
}
export const XP_WIN = 100
export const XP_LOSS = 30
export const XP_IDLE_COLLECT = 50
export const DAILY_CLAIM_G = 5

export const BATTLE_ROUNDS = 5
export const MISSION_DURATION_MS = 30 * 60 * 1000 // 30 minutes
export const DECAY_WARNING_HOURS = 48
export const DECAY_PENALIZE_HOURS = 72
export const DECAY_FREEZE_DAYS = 7

export const ITEM_RARITY_COLORS = {
  common: '#9ca3af',
  rare: '#3b82f6',
  epic: '#a855f7',
  legendary: '#eab308',
} as const

export const PLAY_STYLES = ['Wanderer', 'Fighter', 'Champion'] as const
export type PlayStyle = (typeof PLAY_STYLES)[number]

/** The community group. Announcements, season news and payout updates land here
 *  first. Defined once because it is linked from onboarding, the Help Center and
 *  the profile, and three copies of a URL drift the moment one changes. */
export const TELEGRAM_URL = 'https://t.me/playvalor'
