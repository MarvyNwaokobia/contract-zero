import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { DroppedWeapon, type SlideFn } from '../DroppedWeapon';

const REST_Y = 0.07;
const EYE = new THREE.Vector3(0, 1.6, 0);
const FWD = new THREE.Vector3(0, 0, -1);
const LEVEL = new THREE.Quaternion();

/** No geometry in the way. */
const freeSlide: SlideFn = (_x, _z, nx, nz) => [nx, nz];

function drop(rng = () => 0.5) {
  const w = new DroppedWeapon({ restY: REST_Y, rng });
  w.throwFrom(EYE, FWD, LEVEL);
  return w;
}

/** Run a fixed 60Hz simulation for `seconds`, returning how many clatters fired. */
function run(w: DroppedWeapon, seconds: number, slide: SlideFn = freeSlide): number {
  let clatters = 0;
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    w.step(1 / 60, slide, () => { clatters++; });
  }
  return clatters;
}

describe('DroppedWeapon', () => {
  it('leaves your hands in front of the eye, not on top of it', () => {
    const w = drop();
    expect(w.active).toBe(true);
    expect(w.landed).toBe(false);
    expect(w.position.z).toBeLessThan(EYE.z - 0.3);   // thrown forward (-Z)
    expect(w.position.y).toBeLessThan(EYE.y);          // and a little low
  });

  it('falls slowly enough to be watched, not straight onto the deck', () => {
    // The drop is a beat you are meant to SEE, so half a second in it should still
    // be in the air. Pins the gentle gravity: at a realistic 9.8 (or the 15 this
    // once used) it has already landed by here.
    const w = drop();
    run(w, 0.5);
    expect(w.landed).toBe(false);
    expect(w.position.y).toBeGreaterThan(0.5);
  });

  it('falls, lands on the deck and comes to a complete stop', () => {
    const w = drop();
    run(w, 4);
    expect(w.landed).toBe(true);
    expect(w.position.y).toBeCloseTo(REST_Y, 5);
  });

  it('stays exactly where it landed once it has settled', () => {
    const w = drop();
    run(w, 4);
    const resting = w.position.clone();
    run(w, 3);
    expect(w.position.distanceTo(resting)).toBe(0);
  });

  it('clatters on the way down: it bounces once before it settles', () => {
    // Dropped from eye height, it is doing well over the 2.2m/s bounce threshold
    // when it first strikes, so the landing should read as bounce-then-settle.
    const w = drop();
    const clatters = run(w, 4);
    expect(clatters).toBeGreaterThanOrEqual(2);
  });

  it('is stopped by geometry instead of sliding through it', () => {
    // A wall across the throw at z = -0.8: the slide pins z and lets x pass.
    const wall: SlideFn = (_x, _z, nx, nz) => [nx, Math.max(nz, -0.8)];
    const w = drop();
    run(w, 4, wall);
    expect(w.position.z).toBeGreaterThanOrEqual(-0.8);
    expect(w.landed).toBe(true);
  });

  it('settles level rather than face-planting at whatever angle it was tumbling', () => {
    const w = drop();
    run(w, 5);
    // Lying flat means its own up axis still points broadly upward.
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(w.quaternion);
    expect(Math.abs(up.y)).toBeGreaterThan(0.3);
  });

  it('clear() takes it out of the world so the viewmodel comes back', () => {
    const w = drop();
    run(w, 1);
    w.clear();
    expect(w.active).toBe(false);
    expect(w.landed).toBe(false);
    const parked = w.position.clone();
    run(w, 1);
    expect(w.position.equals(parked)).toBe(true); // a cleared weapon does not fall
  });

  it('tumbles on the way down', () => {
    // rng 0.9 puts real spin on every axis (0.5 is the no-spin midpoint).
    const w = drop(() => 0.9);
    const start = w.quaternion.clone();
    run(w, 0.3);
    expect(w.quaternion.angleTo(start)).toBeGreaterThan(0.2);
  });
});
