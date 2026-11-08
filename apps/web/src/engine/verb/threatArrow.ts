/**
 * Off-screen threat arrow math (CLONE_PLAN.md slice 4) — pure, so the GoW
 * readability rule is unit-tested instead of eyeballed.
 *
 * Given an attacker's position in CAMERA SPACE (x right, y up, -z forward)
 * and, when in front, its NDC projection, decide whether an edge arrow is
 * needed and where it sits: percentages into the viewport plus the rotation
 * (degrees) for a '▲' glyph so it points outward at the threat.
 */

export interface EdgeArrow {
  leftPct: number;
  topPct: number;
  deg: number;
}

/** Inside this NDC box the enemy is visibly on screen: no arrow. */
const VISIBLE_X = 0.95;
const VISIBLE_Y = 0.9;
/** Arrow ring, in NDC fractions (y tighter: leave room for top/bottom HUD). */
const RING_X = 0.86;
const RING_Y = 0.78;

export function computeEdgeArrow(
  camSpace: { x: number; y: number; z: number },
  ndc: { x: number; y: number } | null,
): EdgeArrow | null {
  const behind = camSpace.z > 0;
  if (!behind && ndc && Math.abs(ndc.x) <= VISIBLE_X && Math.abs(ndc.y) <= VISIBLE_Y) {
    return null; // the player can already see them
  }

  // Camera space is already the truth for sides: x<0 IS the player's left.
  // Behind-ness gets encoded as a pull toward the bottom edge, so a threat
  // behind-left reads as a lower-left arrow (the GoW convention).
  const len3 = Math.hypot(camSpace.x, camSpace.y, camSpace.z) || 1;
  let dx = camSpace.x / len3;
  let dy = camSpace.y / len3 - Math.max(0, camSpace.z / len3) * 1.2;
  const len = Math.hypot(dx, dy);
  if (len < 0.15) {
    dx = 0;
    dy = -1;
  } else {
    dx /= len;
    dy /= len;
  }

  return {
    leftPct: (dx * RING_X * 0.5 + 0.5) * 100,
    topPct: (-dy * RING_Y * 0.5 + 0.5) * 100,
    // '▲' points up at 0°; rotate so it aims outward toward the threat.
    deg: (Math.atan2(-dy, dx) * 180) / Math.PI + 90,
  };
}
