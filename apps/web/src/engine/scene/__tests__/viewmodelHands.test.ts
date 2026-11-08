import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildViewmodelHands } from '../viewmodelHands';

/**
 * The grips are MEASURED off each weapon rather than hand-tuned per gun, so the
 * measurement is the thing that can quietly go wrong — and it goes wrong invisibly:
 * a hand ends up inside a receiver or dangling under a magazine, and nothing fails,
 * you just have to notice it on a screenshot.
 *
 * These build weapons whose shape is known exactly and check where the hands land.
 */

const LEN = 0.9;

/** A weapon in the engine's convention: barrel +Z, centred on the origin. `parts`
 *  are [width, height, depth, x, y, z] boxes. */
function gun(parts: [number, number, number, number, number, number][]): THREE.Group {
  const g = new THREE.Group();
  for (const [w, h, d, x, y, z] of parts) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d));
    m.position.set(x, y, z);
    g.add(m);
  }
  g.updateMatrixWorld(true);
  return g;
}

/** A plain rifle: a body along the barrel line, a pistol grip hanging behind centre,
 *  a handguard under the front half. */
function rifle(): THREE.Group {
  return gun([
    [0.06, 0.09, LEN, 0, 0, 0],          // receiver + barrel
    [0.05, 0.11, 0.06, 0, -0.09, -0.08], // pistol grip
    [0.06, 0.05, 0.26, 0, -0.06, 0.14],  // handguard
  ]);
}

const handsOf = (g: THREE.Group) => g.children.filter((c) => c.type === 'Group');

describe('grips are measured off the weapon', () => {
  it('puts one hand behind centre and one forward, both under the barrel line', () => {
    const hands = handsOf(buildViewmodelHands('assault_rifle', rifle(), LEN));
    expect(hands).toHaveLength(2);

    const [fire, support] = hands;
    expect(fire.position.z).toBeLessThan(0);      // firing hand toward the butt
    expect(support.position.z).toBeGreaterThan(0); // support hand toward the muzzle
    for (const h of hands) expect(h.position.y).toBeLessThan(0); // under the weapon
  });

  it('a hand follows the weapon DOWN where the weapon hangs lower', () => {
    // Same rifle, but with a grip that drops much further. The hand on it has to
    // drop with it — that is the whole point of measuring rather than tabulating.
    const shallow = handsOf(buildViewmodelHands('assault_rifle', rifle(), LEN))[0];
    const deep = handsOf(buildViewmodelHands('assault_rifle', gun([
      [0.06, 0.09, LEN, 0, 0, 0],
      [0.05, 0.11, 0.06, 0, -0.05, -0.08],   // grip sits HIGHER
      [0.06, 0.05, 0.26, 0, -0.06, 0.14],
    ]), LEN))[0];

    expect(deep.position.y).toBeGreaterThan(shallow.position.y);
  });

  it('a deep magazine does not drag a hand down with it', () => {
    // The lowest thing on most rifles is the magazine, and it is not a grip. Taken
    // naively, a drum would leave the hand hanging in space below the weapon.
    const withDrum = handsOf(buildViewmodelHands('assault_rifle', gun([
      [0.06, 0.09, LEN, 0, 0, 0],
      [0.05, 0.11, 0.06, 0, -0.09, -0.08],
      [0.08, 0.30, 0.10, 0, -0.22, -0.02],   // a drum hanging far below
      [0.06, 0.05, 0.26, 0, -0.06, 0.14],
    ]), LEN))[0];

    expect(withDrum.position.y).toBeGreaterThan(-0.14);   // clamped to the body line
    expect(withDrum.position.y).toBeLessThan(0);          // still under the weapon
  });

  it('a pistol is held in both hands on the one grip, not out on a handguard', () => {
    const pistol = gun([
      [0.05, 0.07, 0.24, 0, 0, 0],
      [0.04, 0.10, 0.05, 0, -0.08, -0.05],
    ]);
    const hands = handsOf(buildViewmodelHands('sidearm', pistol, 0.26));
    expect(hands).toHaveLength(2);
    // Stacked on the same grip: close together, and BOTH behind centre.
    expect(Math.abs(hands[0].position.z - hands[1].position.z)).toBeLessThan(0.05);
    for (const h of hands) expect(h.position.z).toBeLessThan(0);
  });

  it('works on a weapon it has never seen, with no per-gun entry needed', () => {
    // The failure mode the old hand-tuned table had: an eleventh weapon starts the
    // eyeballing over, and until someone does it the hands sit at the origin.
    const odd = gun([
      [0.09, 0.16, LEN, 0, 0.04, 0],
      [0.06, 0.14, 0.08, 0, -0.13, -0.05],
      [0.07, 0.06, 0.3, 0, -0.05, 0.2],
    ]);
    const hands = handsOf(buildViewmodelHands('assault_rifle', odd, LEN));
    for (const h of hands) {
      expect(h.position.y).toBeLessThan(0);
      expect(h.position.y).toBeGreaterThan(-0.12);
    }
  });

  it('is named so the scene can find it, and holds no loose meshes', () => {
    // ValorScene looks this group up by name every frame to tuck it away at ADS.
    const g = buildViewmodelHands('assault_rifle', rifle(), LEN);
    expect(g.name).toBe('hands');
    // Three materials per hand at most, merged — not twenty boxes each.
    for (const hand of handsOf(g)) expect(hand.children.length).toBeLessThanOrEqual(3);
  });
});
