/**
 * @module campaign/missions
 * @description Walk-to-find mission staging for campaign levels.
 *
 * A mission wraps a campaign level in PLACE and MOVEMENT: you spawn at the
 * village edge, walk the level (full collision, enterable ruins), follow the
 * objective marker to wherever the enemy is holed up, and the fight starts
 * THERE — the combat zone centres on the encounter, not the world origin.
 * Missions with several encounters chain: drop the target, push forward,
 * find the next one.
 *
 * Levels without an entry here (zones 2-3 until their environments land, and
 * all quick fights) keep the classic instant duel.
 *
 * Positions are Ashfall village coordinates (see arenas/ashfallLayout.ts):
 * square r<=13 is open ground, street mouths run east/west along the X axis,
 * houses ring r=16-23, the well sits at (13.5, 5.5), the cart at (-14.5,-3.8).
 */

export interface MissionEncounter {
  /** Where the enemy waits (world XZ). */
  pos: [number, number];
  /** Combat zone radius once the fight starts. */
  zoneRadius: number;
  /** Objective line shown on the HUD while roaming. */
  objective: string;
  /** What the enemy says when you find them. */
  bark: string;
}

export interface MissionConfig {
  /** First-attempt spawn — the walk in is part of the level. */
  playerSpawn: [number, number];
  /** Retry/replay spawn — closer, so repeat attempts skip the hike. */
  retrySpawn: [number, number];
  encounters: MissionEncounter[];
}

const MISSIONS: Record<number, MissionConfig> = {
  // Zone 1 · Ashfall — the burned village.
  1: {
    playerSpawn: [-23, 0],
    retrySpawn: [-13, 0],
    encounters: [
      {
        pos: [3, 0], zoneRadius: 10,
        objective: 'Find the guard in the village square',
        bark: "So you crawled out of the ashes. I'll put you back in them.",
      },
    ],
  },
  2: {
    playerSpawn: [23, 0],
    retrySpawn: [12, 3],
    encounters: [
      {
        pos: [-1, 8.5], zoneRadius: 8,
        objective: 'Hunt the scout hiding by the north ruins',
        bark: "You weren't supposed to make it this far.",
      },
    ],
  },
  // Level 3 chains two encounters — drop the roadblock, push into the square.
  3: {
    playerSpawn: [-23, 0],
    retrySpawn: [-20, 0],
    encounters: [
      {
        pos: [-14.5, 0.5], zoneRadius: 6.5,
        objective: 'Break the roadblock on the west road',
        bark: 'The road is closed. Permanently.',
      },
      {
        pos: [3, -2], zoneRadius: 10,
        objective: 'Push forward: their second gun holds the square',
        bark: 'You got lucky once. Luck runs out.',
      },
    ],
  },
  4: {
    playerSpawn: [23, 0],
    retrySpawn: [15, 2],
    encounters: [
      {
        pos: [11, 4.5], zoneRadius: 8,
        objective: 'Take out the gunman camped at the well',
        bark: 'Nothing left to drink here but ash. Come get yours.',
      },
    ],
  },
  5: {
    playerSpawn: [-23, 0],
    retrySpawn: [-13, 0],
    encounters: [
      {
        pos: [0, 0], zoneRadius: 10,
        objective: 'Cinder is waiting in the square. End this.',
        bark: 'I burned this place once. Burning you will be easier.',
      },
    ],
  },
};

export function getMission(level: number): MissionConfig | undefined {
  return MISSIONS[level];
}
