import * as THREE from 'three';
import type { CharacterController } from '../character';

export interface KnockbackEvent {
  direction: THREE.Vector3;
  force: number;
  hitType: 'light' | 'heavy' | 'special';
  killed: boolean;
}

export interface KnockbackState {
  velocity: THREE.Vector3;
  angularVelocity: number;
  tiltAngle: number;
  slideTimer: number;
  bounceCount: number;
  recovering: boolean;
  recoveryTimer: number;
}

const FRICTION = 8;
const TILT_RECOVERY_SPEED = 6;
const BOUNCE_DAMPING = 0.4;
const STAGGER_TILT_LIGHT = 0.15;
const STAGGER_TILT_HEAVY = 0.35;
const STAGGER_TILT_SPECIAL = 0.5;
const DEATH_TILT = 1.2;

export class KnockbackPhysics {
  private states: Map<string, KnockbackState> = new Map();

  register(fighterId: string) {
    this.states.set(fighterId, {
      velocity: new THREE.Vector3(),
      angularVelocity: 0,
      tiltAngle: 0,
      slideTimer: 0,
      bounceCount: 0,
      recovering: false,
      recoveryTimer: 0,
    });
  }

  applyKnockback(fighterId: string, event: KnockbackEvent) {
    const state = this.states.get(fighterId);
    if (!state) return;

    state.velocity.copy(event.direction).multiplyScalar(event.force);

    if (event.killed) {
      state.velocity.y += 3;
      state.tiltAngle = DEATH_TILT;
      state.angularVelocity = (Math.random() - 0.5) * 4;
      state.recovering = false;
      return;
    }

    switch (event.hitType) {
      case 'light':
        state.tiltAngle = STAGGER_TILT_LIGHT * (Math.random() > 0.5 ? 1 : -1);
        state.slideTimer = 0.15;
        break;
      case 'heavy':
        state.tiltAngle = STAGGER_TILT_HEAVY * (Math.random() > 0.5 ? 1 : -1);
        state.velocity.y += 1;
        state.slideTimer = 0.3;
        break;
      case 'special':
        state.tiltAngle = STAGGER_TILT_SPECIAL * (Math.random() > 0.5 ? 1 : -1);
        state.velocity.y += 2;
        state.slideTimer = 0.5;
        break;
    }

    state.recovering = false;
    state.recoveryTimer = state.slideTimer + 0.2;
    state.bounceCount = 0;
  }

  update(dt: number, fighterId: string, controller: CharacterController): {
    tilt: number;
    sliding: boolean;
  } {
    const state = this.states.get(fighterId);
    if (!state) return { tilt: 0, sliding: false };

    const sliding = state.slideTimer > 0;

    if (sliding) {
      state.slideTimer -= dt;

      controller.state.position.addScaledVector(state.velocity, dt);
      state.velocity.x *= 1 - FRICTION * dt;
      state.velocity.z *= 1 - FRICTION * dt;

      state.velocity.y -= 20 * dt;
      controller.state.position.y += state.velocity.y * dt;

      if (controller.state.position.y <= 0) {
        controller.state.position.y = 0;

        if (state.velocity.y < -2 && state.bounceCount < 2) {
          state.velocity.y *= -BOUNCE_DAMPING;
          state.bounceCount++;
          state.tiltAngle *= -0.6;
        } else {
          state.velocity.y = 0;
        }
      }
    }

    if (!sliding && !controller.state.isDead) {
      state.recoveryTimer -= dt;
      if (state.recoveryTimer <= 0 && !state.recovering) {
        state.recovering = true;
        controller.clearStagger();
      }

      state.tiltAngle *= 1 - TILT_RECOVERY_SPEED * dt;
      if (Math.abs(state.tiltAngle) < 0.01) {
        state.tiltAngle = 0;
      }
    }

    if (controller.state.isDead) {
      state.tiltAngle += state.angularVelocity * dt;
      state.angularVelocity *= 0.95;

      if (state.tiltAngle > Math.PI * 0.4) {
        state.tiltAngle = Math.PI * 0.4;
        state.angularVelocity = 0;
      }
    }

    return { tilt: state.tiltAngle, sliding };
  }

  getState(fighterId: string): KnockbackState | undefined {
    return this.states.get(fighterId);
  }
}
