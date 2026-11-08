import { describe, it, expect } from 'vitest';
import {
  xpForKill, rankForXp, rankIndexForXp, xpIntoRank, xpBarSize, rankUpsBetween,
  gReward, careerXpFor, XP_REWARD, RANK_STEP_XP, PRESTIGE_STEP_XP, xpForNextRank,
} from '../xp';

// Career XP at which each rank is reached, walked down the progressive curve.
// These MUST equal cumulative_xp_for_rank() in apps/api battles.rs.
const AT = {
  Iron: 0,
  Bronze: 400,
  Silver: 1_300,
  Gold: 2_600,
  Platinum: 5_100,
  Emerald: 9_600,
  Diamond: 17_600,
} as const;

describe('earn loop: XP per kill', () => {
  it('a body kill is worth the base, a headshot kill more', () => {
    expect(xpForKill('torso')).toBe(XP_REWARD.KILL);
    expect(xpForKill('leg')).toBe(XP_REWARD.KILL);
    expect(xpForKill('arm')).toBe(XP_REWARD.KILL);
    expect(xpForKill('head')).toBe(XP_REWARD.KILL + XP_REWARD.HEADSHOT_BONUS);
    expect(xpForKill('head')).toBeGreaterThan(xpForKill('torso'));
  });

  it('the kills in a level sum to the level XP', () => {
    const kills: Array<Parameters<typeof xpForKill>[0]> = ['torso', 'head', 'leg', 'torso', 'head'];
    const total = kills.reduce((sum, p) => sum + xpForKill(p), 0);
    expect(total).toBe(3 * XP_REWARD.KILL + 2 * (XP_REWARD.KILL + XP_REWARD.HEADSHOT_BONUS));
  });
});

describe('the ladder is progressive', () => {
  it('each rank costs strictly more than the one below it', () => {
    const steps = [
      RANK_STEP_XP.Bronze, RANK_STEP_XP.Silver, RANK_STEP_XP.Gold,
      RANK_STEP_XP.Platinum, RANK_STEP_XP.Emerald, RANK_STEP_XP.Diamond,
    ];
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThan(steps[i - 1]);
  });

  it('the client curve matches the server cumulative thresholds', () => {
    // Drift here is the bug that silently withholds rank-up money, so pin it.
    expect(careerXpFor('Bronze', 0)).toBe(AT.Bronze);
    expect(careerXpFor('Silver', 0)).toBe(AT.Silver);
    expect(careerXpFor('Gold', 0)).toBe(AT.Gold);
    expect(careerXpFor('Platinum', 0)).toBe(AT.Platinum);
    expect(careerXpFor('Emerald', 0)).toBe(AT.Emerald);
    expect(careerXpFor('Diamond', 0)).toBe(AT.Diamond);
  });

  it('sizes the bar by the rank you are currently filling', () => {
    expect(xpForNextRank('Iron')).toBe(RANK_STEP_XP.Bronze);
    expect(xpForNextRank('Gold')).toBe(RANK_STEP_XP.Platinum);
    expect(xpForNextRank('Emerald')).toBe(RANK_STEP_XP.Diamond);
    // At the top the bar becomes the prestige step, not a dead full bar.
    expect(xpForNextRank('Diamond')).toBe(PRESTIGE_STEP_XP);
  });
});

describe('earn loop: rank from XP', () => {
  it('starts at Iron and climbs the curve', () => {
    expect(rankForXp(0)).toBe('Iron');
    expect(rankForXp(AT.Bronze - 1)).toBe('Iron');
    expect(rankForXp(AT.Bronze)).toBe('Bronze');
    expect(rankForXp(AT.Silver)).toBe('Silver');
    expect(rankForXp(AT.Gold)).toBe('Gold');
    expect(rankForXp(AT.Platinum)).toBe('Platinum');
    expect(rankForXp(AT.Emerald)).toBe('Emerald');
    expect(rankForXp(AT.Diamond)).toBe('Diamond');
  });

  it('one full campaign clear lands Gold, the calibration anchor', () => {
    // 15 ops at their kill caps, body shots only.
    const FULL_CAMPAIGN_XP = 2_610;
    expect(rankForXp(FULL_CAMPAIGN_XP)).toBe('Gold');
  });

  it('caps at the top rank instead of overflowing', () => {
    expect(rankForXp(999_999)).toBe('Diamond');
    expect(rankIndexForXp(999_999)).toBe(6);
  });

  it('reports progress into the current rank', () => {
    expect(xpIntoRank(0)).toBe(0);
    expect(xpIntoRank(340)).toBe(340);                       // 340 into Iron's 400 bar
    expect(xpIntoRank(AT.Bronze + 120)).toBe(120);           // 120 into Bronze's 900 bar
    expect(xpIntoRank(AT.Emerald + 4_499)).toBe(4_499);
  });

  it('keeps counting past Diamond instead of pinning the bar full', () => {
    // The old flat ladder read a maxed player as permanently full, which is what hid
    // the Diamond XP-delete bug. Progress past Diamond now cycles the prestige bar.
    expect(xpIntoRank(AT.Diamond)).toBe(0);
    expect(xpIntoRank(AT.Diamond + 250)).toBe(250);
    expect(xpIntoRank(AT.Diamond + PRESTIGE_STEP_XP)).toBe(0);
    expect(xpIntoRank(AT.Diamond + PRESTIGE_STEP_XP + 7)).toBe(7);
    expect(xpBarSize(AT.Diamond + 250)).toBe(PRESTIGE_STEP_XP);
  });

  it('names every rank crossed, including several at once', () => {
    expect(rankUpsBetween(AT.Bronze - 20, AT.Bronze + 5)).toEqual(['Bronze']);
    expect(rankUpsBetween(0, AT.Bronze - 1)).toEqual([]);
    // A full campaign dropped on a fresh player crosses three ranks at once.
    expect(rankUpsBetween(0, 2_610)).toEqual(['Bronze', 'Silver', 'Gold']);
  });

  it('pays more G$ the higher the rank', () => {
    expect(gReward('Bronze')).toBe(500);
    expect(gReward('Silver')).toBe(1_000);
    expect(gReward('Diamond')).toBe(3_000);
    expect(gReward('Diamond')).toBeGreaterThan(gReward('Bronze'));
  });
});

describe('seeding the HUD from the server account', () => {
  it('careerXpFor round-trips back to the account rank + progress', () => {
    for (const [rank, into] of [
      ['Iron', 0], ['Iron', 399], ['Bronze', 750], ['Silver', 120], ['Platinum', 999],
      ['Emerald', 4_499], ['Diamond', 500],
    ] as const) {
      const seed = careerXpFor(rank, into);
      expect(rankForXp(seed)).toBe(rank);
      expect(xpIntoRank(seed)).toBe(into);
    }
  });

  it('is robust to junk input', () => {
    expect(careerXpFor('Iron', -50)).toBe(0);
    // Progress beyond the rank's own bar clamps into the band rather than leaking
    // the player into a rank the server never granted them.
    expect(careerXpFor('Iron', 99_999)).toBe(AT.Bronze);
    expect(careerXpFor('Diamond', 300)).toBe(AT.Diamond + 300);
  });
});
