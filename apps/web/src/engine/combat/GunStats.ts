/**
 * @module GunStats
 * @description Weapon stat blocks for the ranged stat-duel.
 *
 * In the shooter pivot, a fighter's GUN — not their class — is the primary source
 * of combat power. The headless CombatSim resolver consumes these numbers to drive
 * fire cadence, projectile travel, hit chance and damage; class becomes flavour
 * layered on top (e.g. Phantom = longer dodge i-frames, Sentinel = more HP).
 *
 * Guns are class-AGNOSTIC: any fighter can equip any gun. The marketplace sells
 * them by tier, and the PvE Campaign (engine/campaign/levels.ts) gates progression
 * behind acquiring stronger tiers — that demand is the core economic loop.
 *
 * All numbers here are FIRST-PASS and meant to be tuned. `gunDps()` is the headline
 * "power" figure the marketplace sorts/level-gates on. Fire is travel-time, not
 * hitscan, so `projectileSpeed` is a real balance lever: slower rounds are more
 * dodgeable.
 */

export type GunId =
  | 'sidearm' | 'smg' | 'assault_rifle' | 'marksman' | 'legendary'
  // ── SEASONAL weapons (tiers 6-10) ──
  // Priced 3,000-10,000 G$, above the Valor Prototype's 6,000, and every one of them
  // is a genuine upgrade on it — a player paying this much must FEEL it, not read it
  // on a card. Their models are built in code (scene/proceduralGuns.ts) rather than
  // loaded as GLBs.
  | 'ashfall_carbine' | 'warden_repeater' | 'rift_lance' | 'seraph_lmg' | 'ember_halo';

export interface GunStats {
  id: GunId;
  name: string;
  tier: number;            // 1..5 — marketplace + level gating
  damage: number;          // HP per landed shot (before crit)
  fireRate: number;        // rounds per minute → shot cooldown = 60 / fireRate
  accuracy: number;        // 0..1 hit chance when the target is NOT dodging
  projectileSpeed: number; // m/s — travel-time, not hitscan; lower = easier to dodge
  range: number;           // m of full damage; damage falls off beyond this
  critChance: number;      // 0..1
  critMult: number;        // damage multiplier on a crit
  magazine: number;        // shots before a reload
  reloadTime: number;      // seconds to reload
}

/**
 * Sustained DPS including reload downtime and expected accuracy/crit — the single
 * "power" number the marketplace sorts and the Campaign gates on.
 */
export function gunDps(g: GunStats): number {
  const secsPerMag = g.magazine / (g.fireRate / 60) + g.reloadTime;
  const expectedPerShot = g.damage * g.accuracy * (1 + g.critChance * (g.critMult - 1));
  return (g.magazine * expectedPerShot) / secsPerMag;
}

export const GUN_CATALOG: Record<GunId, GunStats> = {
  sidearm: {
    id: 'sidearm', name: 'Standard Sidearm', tier: 1,
    damage: 12, fireRate: 180, accuracy: 0.80, projectileSpeed: 22, range: 8,
    critChance: 0.05, critMult: 1.5, magazine: 12, reloadTime: 1.6,
  },
  smg: {
    id: 'smg', name: 'Compact SMG', tier: 2,
    damage: 9, fireRate: 600, accuracy: 0.62, projectileSpeed: 26, range: 7,
    critChance: 0.05, critMult: 1.5, magazine: 30, reloadTime: 2.0,
  },
  assault_rifle: {
    id: 'assault_rifle', name: 'Assault Rifle', tier: 3,
    damage: 18, fireRate: 360, accuracy: 0.72, projectileSpeed: 30, range: 10,
    critChance: 0.08, critMult: 1.6, magazine: 24, reloadTime: 2.2,
  },
  /** Tier 4. Deliberately still slow and per-shot heavy — but it used to sit BELOW
   *  the tier-3 Assault Rifle on sustained damage while costing 2.25x as much, which
   *  in a ranked shop list reads as simply broken. A bigger magazine and a faster
   *  reload lift it above the rifle without touching what makes it a marksman. */
  marksman: {
    id: 'marksman', name: 'Marksman Rifle', tier: 4,
    damage: 52, fireRate: 90, accuracy: 0.90, projectileSpeed: 40, range: 14,
    critChance: 0.15, critMult: 2.0, magazine: 10, reloadTime: 2.2,
  },
  legendary: {
    id: 'legendary', name: 'Valor Prototype', tier: 5,
    damage: 30, fireRate: 480, accuracy: 0.80, projectileSpeed: 34, range: 12,
    critChance: 0.12, critMult: 1.8, magazine: 28, reloadTime: 1.8,
  },

  // ── Seasonal tiers ──────────────────────────────────────────────────────────
  // Each one is BETTER than the Prototype outright, and each is better in a
  // different way, so the choice is a playstyle and not just a bigger number.

  /** 3,000 G$ — bullpup carbine. Fast, accurate, forgiving: the entry seasonal. */
  ashfall_carbine: {
    id: 'ashfall_carbine', name: 'Ashfall Carbine', tier: 6,
    damage: 26, fireRate: 620, accuracy: 0.84, projectileSpeed: 38, range: 13,
    critChance: 0.12, critMult: 1.8, magazine: 32, reloadTime: 1.6,
  },
  /** 4,500 G$ — heavy battle rifle. Hits far harder per shot, slower and deliberate. */
  warden_repeater: {
    id: 'warden_repeater', name: "Warden's Repeater", tier: 7,
    damage: 52, fireRate: 300, accuracy: 0.88, projectileSpeed: 44, range: 18,
    critChance: 0.18, critMult: 2.0, magazine: 20, reloadTime: 2.0,
  },
  /** 6,500 G$ — energy marksman. Enormous per-shot damage at range, punishing to miss. */
  rift_lance: {
    id: 'rift_lance', name: 'Rift Lance', tier: 8,
    damage: 95, fireRate: 150, accuracy: 0.94, projectileSpeed: 60, range: 26,
    critChance: 0.28, critMult: 2.4, magazine: 12, reloadTime: 2.1,
  },
  /** 8,000 G$ — belt-fed LMG. Huge magazine, sustained fire, slow to bring back up. */
  seraph_lmg: {
    id: 'seraph_lmg', name: 'Seraph', tier: 9,
    damage: 34, fireRate: 780, accuracy: 0.80, projectileSpeed: 42, range: 16,
    critChance: 0.14, critMult: 1.8, magazine: 75, reloadTime: 3.4,
  },
  /** 10,000 G$ — the exotic. Best of everything; the reason to save.
   *  Deliberately NOT double the next gun: at 58 damage and a 0.26 crit this landed
   *  near 490 DPS, which killed even deep-wave enemies faster than they can be
   *  reacted to and flattened the whole difficulty curve. Tuned to sit about a third
   *  above the Seraph — clearly the best weapon in the game, without ending it. */
  ember_halo: {
    id: 'ember_halo', name: 'Ember Halo', tier: 10,
    damage: 44, fireRate: 600, accuracy: 0.92, projectileSpeed: 52, range: 22,
    critChance: 0.20, critMult: 2.0, magazine: 40, reloadTime: 1.7,
  },
};

/** The free starter gun every player owns. */
export const STARTER_GUN_ID: GunId = 'sidearm';

export function getGun(id: GunId): GunStats {
  return GUN_CATALOG[id];
}
