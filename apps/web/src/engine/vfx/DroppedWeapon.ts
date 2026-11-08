import * as THREE from 'three';

/**
 * The weapon you were holding when you went down: thrown clear, tumbling, then
 * clattering to a stop on the deck.
 *
 * Lives outside the scene component so the physics can be tested — the interesting
 * cases (does it come to rest, can it be thrown through a wall, does a shallow
 * landing skip the bounce) are all pure motion, and none of them are reachable
 * through a React scene without dying in a real firefight first.
 *
 * Collision is injected: the caller passes the same `slideMove` the player walks
 * with, so the gun is stopped by exactly the geometry the player is.
 */

/** Slide a point from (x,z) toward (nx,nz), stopping against level geometry. */
export type SlideFn = (x: number, z: number, nx: number, nz: number) => [number, number];

export interface DroppedWeaponOptions {
  /** Where it comes to rest. Not 0: the models are centred on the gun's body, so a
   *  receiver lying on the deck sits a few centimetres up. */
  restY?: number;
  /** Downward acceleration. Under real gravity on purpose: the drop is a beat you
   *  are meant to WATCH — the weapon leaving your hands is how the death reads —
   *  and at true 9.8 (let alone the 15 this used to run) it is on the deck before
   *  the camera has finished falling with you. */
  gravity?: number;
  rng?: () => number;
}

export class DroppedWeapon {
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();

  /** True from the moment it leaves your hands until it is picked back up. */
  active = false;
  /** True once it has stopped moving. */
  landed = false;

  private readonly restY: number;
  private readonly gravity: number;
  private readonly rng: () => number;

  private readonly vel = new THREE.Vector3();
  private readonly spin = new THREE.Vector3();
  private readonly rest = new THREE.Quaternion();
  private settle = 0;

  private readonly right = new THREE.Vector3();
  private readonly euler = new THREE.Euler();

  constructor(opts: DroppedWeaponOptions = {}) {
    this.restY = opts.restY ?? 0.07;
    this.gravity = opts.gravity ?? 6.5;
    this.rng = opts.rng ?? Math.random;
  }

  /**
   * Let go of it. Thrown roughly the way you were facing, because a rifle dropped
   * by a falling body carries their momentum rather than landing on their boots.
   */
  throwFrom(eye: THREE.Vector3, forward: THREE.Vector3, orientation: THREE.Quaternion) {
    this.right.crossVectors(forward, UP).normalize();
    this.active = true;
    this.landed = false;
    this.settle = 0;
    // Starts where the weapon actually was: out in front of the eye, a little low.
    this.position.copy(eye).addScaledVector(forward, 0.45).addScaledVector(UP, -0.22);
    this.quaternion.copy(orientation);
    const drift = (this.rng() - 0.5) * 1.2;
    this.vel.set(
      forward.x * 1.5 + this.right.x * drift,
      0.9,
      forward.z * 1.5 + this.right.z * drift,
    );
    this.spin.set(
      (this.rng() - 0.5) * 9,
      (this.rng() - 0.5) * 7,
      (this.rng() - 0.5) * 11,
    );
  }

  /** Back in your hands: a restart, a new wave, a new op. */
  clear() {
    this.active = false;
    this.landed = false;
    this.settle = 0;
    this.vel.set(0, 0, 0);
  }

  /**
   * Advance one frame. `onClatter` fires when it strikes the deck (once on a
   * bounce, once when it finally settles) so the caller can play a sound there.
   */
  step(dt: number, slide: SlideFn, onClatter?: (x: number, y: number, z: number) => void) {
    if (!this.active) return;

    if (this.landed) {
      // Ease out of the tumble into the resting pose instead of snapping flat.
      if (this.settle < 1) {
        this.settle = Math.min(1, this.settle + dt * 4);
        this.quaternion.slerp(this.rest, this.settle);
      }
      return;
    }

    this.vel.y -= this.gravity * dt;
    const [x, z] = slide(
      this.position.x, this.position.z,
      this.position.x + this.vel.x * dt, this.position.z + this.vel.z * dt,
    );
    this.position.set(x, this.position.y + this.vel.y * dt, z);

    this.euler.set(this.spin.x * dt, this.spin.y * dt, this.spin.z * dt);
    this.quaternion.multiply(TUMBLE.setFromEuler(this.euler));

    if (this.position.y > this.restY) return;

    this.position.y = this.restY;
    onClatter?.(this.position.x, this.position.y, this.position.z);
    if (this.vel.y < -2.2) {
      // Enough speed left for a real clatter: one bounce, then it settles.
      this.vel.y *= -0.28;
      this.vel.x *= 0.55;
      this.vel.z *= 0.55;
      this.spin.multiplyScalar(0.5);
      return;
    }
    this.landed = true;
    this.vel.set(0, 0, 0);
    // Lie flat, keeping whichever way it was pointing, tipped onto one side.
    this.euler.setFromQuaternion(this.quaternion, 'YXZ');
    this.rest.setFromEuler(FLAT.set(0, this.euler.y, (this.rng() - 0.5) * 1.4, 'YXZ'));
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const TUMBLE = new THREE.Quaternion();
const FLAT = new THREE.Euler();
