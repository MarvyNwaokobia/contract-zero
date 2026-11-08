import * as THREE from 'three';
import { Action, type InputSystem } from '../input/InputSystem';

export interface CharacterState {
  position: THREE.Vector3;
  rotation: number;
  velocity: THREE.Vector3;
  isGrounded: boolean;
  isAttacking: boolean;
  isBlocking: boolean;
  isDodging: boolean;
  isStaggered: boolean;
  isRunning: boolean;
  isDead: boolean;
  facingRight: boolean;
  health: number;
  maxHealth: number;
  specialMeter: number;
  comboCount: number;
  /** VFX-only: 0..1 squash-and-stretch impulse set on being hit, decayed by the renderer. */
  impactPulse: number;
  /** VFX-only: 0..1 recoil impulse set when this fighter fires, decayed by the renderer. */
  recoilPulse: number;
}

export interface CharacterConfig {
  moveSpeed: number;
  runSpeed: number;
  jumpForce: number;
  dodgeDistance: number;
  dodgeDuration: number;
  dodgeCooldown: number;
  turnSpeed: number;
  gravity: number;
  arenaRadius: number;
  /** Centre of the circular clamp — missions fight where the enemy was FOUND,
   *  so the zone is not always the world origin. */
  arenaCenter: [number, number];
  arenaMinX: number;
  arenaMaxX: number;
  arenaMinZ: number;
  arenaMaxZ: number;
}

// A hit landing within this many seconds of raising the guard is a parry.
const PARRY_WINDOW = 0.18;

// Seconds of continuous movement before a walk breaks into a run.
const RUN_DELAY = 0.4;

const DEFAULT_CONFIG: CharacterConfig = {
  // Tuned to the walk/run cycles so the feet track the ground (no skating).
  moveSpeed: 2.0,
  runSpeed: 4.8,
  jumpForce: 7.5,
  dodgeDistance: 1.9,
  dodgeDuration: 0.42,
  dodgeCooldown: 0.8,
  turnSpeed: 10,
  gravity: -20,
  // Combat zone: fighters are clamped to this circle. Deliberately smaller than the
  // visual platform — the stage stays spacious, but the fight (and the cover) stays
  // in a readable ~20m zone the camera can frame closely, so characters read big.
  arenaRadius: 10,
  arenaCenter: [0, 0],
  arenaMinX: -12,
  arenaMaxX: 12,
  arenaMinZ: -8,
  arenaMaxZ: 8,
};

export class CharacterController {
  state: CharacterState;
  config: CharacterConfig;

  private dodgeTimer = 0;
  private dodgeCooldownTimer = 0;
  private dodgeDirection = new THREE.Vector3();
  private targetRotation = 0;
  private lockOnTarget: CharacterController | null = null;

  // Stagger split into hard hitstun (locked) then a tech tail where a block or
  // dodge can cancel the recovery — so trading hits isn't a pure lockout.
  private staggerTimer = 0;
  private staggerTechTime = 0;

  // How long the guard has been raised. A hit caught in the first PARRY_WINDOW
  // of a fresh block is a parry (perfect guard) rather than a normal block.
  private blockHeldTime = PARRY_WINDOW + 1;
  private wasBlocking = false;

  // Committed forward step of an attack (replaces the old velocity slide).
  private lungeDir = new THREE.Vector3();
  private lungeDist = 0;
  private lungeElapsed = 0;
  private lungeDuration = 0;

  // How long movement has been held (walk breaks into a run past RUN_DELAY),
  // and the eased progress of the current dodge roll.
  private moveHoldTime = 0;
  private dodgeElapsed = 0;

  constructor(
    startPosition: THREE.Vector3,
    config?: Partial<CharacterConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = {
      position: startPosition.clone(),
      rotation: 0,
      velocity: new THREE.Vector3(),
      isGrounded: true,
      isAttacking: false,
      isBlocking: false,
      isDodging: false,
      isStaggered: false,
      isRunning: false,
      isDead: false,
      facingRight: true,
      health: 100,
      maxHealth: 100,
      specialMeter: 0,
      comboCount: 0,
      impactPulse: 0,
      recoilPulse: 0,
    };
  }

  setLockOnTarget(target: CharacterController | null) {
    this.lockOnTarget = target;
  }

  update(dt: number, input: InputSystem, cameraYaw: number) {
    if (this.state.isDead) return;

    this.updateTimers(dt);

    if (this.state.isAttacking) {
      // Committed step that front-loads its travel then hard-plants — the step
      // into a strike, not a long velocity slide (root-motion-style commit).
      if (this.lungeElapsed < this.lungeDuration && this.lungeDist > 0) {
        const e0 = easeOutCubic(this.lungeElapsed / this.lungeDuration);
        this.lungeElapsed = Math.min(this.lungeDuration, this.lungeElapsed + dt);
        const e1 = easeOutCubic(this.lungeElapsed / this.lungeDuration);
        this.state.position.addScaledVector(this.lungeDir, this.lungeDist * (e1 - e0));
      }
      // Face lock-on target during attacks
      if (this.lockOnTarget) {
        const toTarget = new THREE.Vector3()
          .subVectors(this.lockOnTarget.state.position, this.state.position)
          .setY(0);
        this.targetRotation = Math.atan2(toTarget.x, toTarget.z);
        this.state.rotation = lerpAngle(this.state.rotation, this.targetRotation, this.config.turnSpeed * dt);
      }
      // An airborne attack (jump-attack) keeps falling — it's a dive, not a hover.
      if (!this.state.isGrounded) this.applyGravity(dt);
      this.clampToArena();
      return;
    }

    if (this.state.isStaggered) {
      // Hard hitstun — fully locked, knockback carries the body.
      if (this.staggerTimer > this.staggerTechTime) return;

      // Tech tail — a dodge escapes, or block raises the guard, cancelling
      // the rest of the recovery. Anything else stays committed to the flinch.
      if (input.consumeBuffered(Action.Dodge) && this.dodgeCooldownTimer <= 0) {
        this.clearStagger();
        this.startDodge();
        // fall through into dodge movement below
      } else if (input.getAction(Action.Block).held) {
        this.clearStagger();
        this.state.isBlocking = true;
        return;
      } else {
        return;
      }
    }

    if (this.state.isDodging) {
      this.applyDodgeMovement(dt);
    } else {
      this.handleMovement(dt, input, cameraYaw);
      this.handleActions(input);
    }

    this.applyGravity(dt);
    this.clampToArena();
  }

  // Commit a forward step for an attack — travels `distance` metres along
  // `direction`, front-loaded over `duration`, then plants. Cancels any prior
  // planar drift so there's no residual slide.
  applyLunge(direction: THREE.Vector3, distance: number, duration = 0.14) {
    this.lungeDir.copy(direction).setY(0);
    if (this.lungeDir.lengthSq() > 1e-6) this.lungeDir.normalize();
    this.lungeDist = Math.max(0, distance);
    this.lungeDuration = duration;
    this.lungeElapsed = 0;
    this.state.velocity.x = 0;
    this.state.velocity.z = 0;
  }

  // Begin a stagger of `duration` seconds; the last `techFraction` of it is the
  // tech window where the fighter can cancel into block or dodge.
  applyStagger(duration: number, techFraction = 0.45) {
    this.state.isStaggered = true;
    this.state.isAttacking = false;
    this.staggerTimer = duration;
    this.staggerTechTime = duration * (1 - techFraction);
  }

  // `blockable: false` = the hit ignores the guard entirely (bullets — the
  // stat-duel's only defense is dodge i-frames; block must not chip-reduce shots).
  applyDamage(amount: number, knockbackDir: THREE.Vector3, knockbackForce: number, blockable = true) {
    if (this.state.isDodging) return;

    const blocked = blockable && this.state.isBlocking;
    const actualDamage = blocked ? Math.floor(amount * 0.25) : amount;

    this.state.health = Math.max(0, this.state.health - actualDamage);

    if (!blocked) {
      this.state.velocity.addScaledVector(knockbackDir, knockbackForce);
      // Stagger timing is set by applyStagger() from the hit handler; here we
      // only break the attack/combo so the flinch can take over.
      this.state.isAttacking = false;
      this.state.comboCount = 0;
    }

    if (this.state.health <= 0) {
      this.state.isDead = true;
      this.state.isAttacking = false;
      this.state.isBlocking = false;
      this.clearStagger();
    }

    return { blocked, actualDamage };
  }

  clearStagger() {
    this.state.isStaggered = false;
    this.staggerTimer = 0;
    this.staggerTechTime = 0;
  }

  // Push two fighters apart so their bodies never overlap/clip.
  // Resolves mutually — each is shoved half the penetration depth.
  separateFrom(other: CharacterController, minDist: number) {
    const delta = new THREE.Vector3()
      .subVectors(other.state.position, this.state.position)
      .setY(0);
    const dist = delta.length();

    if (dist < minDist) {
      // Degenerate case: exactly stacked — pick an arbitrary axis to split them
      const dir = dist > 1e-4
        ? delta.multiplyScalar(1 / dist)
        : new THREE.Vector3(1, 0, 0);
      const push = (minDist - dist) * 0.5;
      this.state.position.addScaledVector(dir, -push);
      other.state.position.addScaledVector(dir, push);
      this.clampToArena();
      other.clampToArena();
    }
  }

  private updateTimers(dt: number) {
    if (this.dodgeTimer > 0) {
      this.dodgeTimer -= dt;
      if (this.dodgeTimer <= 0) {
        this.state.isDodging = false;
      }
    }
    if (this.dodgeCooldownTimer > 0) {
      this.dodgeCooldownTimer -= dt;
    }
    if (this.staggerTimer > 0) {
      this.staggerTimer -= dt;
      if (this.staggerTimer <= 0) this.clearStagger();
    }

    // Track how long the guard has been up (resets on a fresh press) so a hit
    // caught right after raising block counts as a parry.
    if (this.state.isBlocking) {
      this.blockHeldTime = this.wasBlocking ? this.blockHeldTime + dt : 0;
      this.wasBlocking = true;
    } else {
      this.wasBlocking = false;
      this.blockHeldTime = PARRY_WINDOW + 1;
    }
  }

  // True if a hit landing right now would be a perfect parry rather than a
  // chip-damage block.
  canParry(): boolean {
    return this.state.isBlocking && this.blockHeldTime <= PARRY_WINDOW;
  }

  private handleMovement(dt: number, input: InputSystem, cameraYaw: number) {
    const move = input.moveAxis;
    const hasInput = Math.abs(move.x) > 0.1 || Math.abs(move.y) > 0.1;

    if (!hasInput) {
      this.moveHoldTime = 0;
      this.state.isRunning = false;
      const decay = Math.exp(-15 * dt);
      this.state.velocity.x *= decay;
      this.state.velocity.z *= decay;
      if (Math.abs(this.state.velocity.x) < 0.01) this.state.velocity.x = 0;
      if (Math.abs(this.state.velocity.z) < 0.01) this.state.velocity.z = 0;
      // A gunfighter squares up: keep turning to face the opponent even while
      // standing still (previously idle fighters froze at their last heading —
      // invisible from the old side camera, obviously wrong over the shoulder).
      this.faceLockOn(dt);
      return;
    }

    // Hold a direction long enough and the walk breaks into a run.
    this.moveHoldTime += dt;
    this.state.isRunning = this.moveHoldTime > RUN_DELAY;

    const forward = new THREE.Vector3(
      -Math.sin(cameraYaw),
      0,
      -Math.cos(cameraYaw)
    );
    const right = new THREE.Vector3(
      Math.cos(cameraYaw),
      0,
      -Math.sin(cameraYaw)
    );

    const moveDir = new THREE.Vector3()
      .addScaledVector(right, move.x)
      .addScaledVector(forward, move.y)
      .normalize();

    const speed = this.state.isRunning ? this.config.runSpeed : this.config.moveSpeed;
    this.state.velocity.x = moveDir.x * speed;
    this.state.velocity.z = moveDir.z * speed;

    if (this.lockOnTarget) {
      const toTarget = new THREE.Vector3()
        .subVectors(this.lockOnTarget.state.position, this.state.position)
        .setY(0);
      this.targetRotation = Math.atan2(toTarget.x, toTarget.z);
    } else {
      this.targetRotation = Math.atan2(moveDir.x, moveDir.z);
    }

    this.state.rotation = lerpAngle(
      this.state.rotation,
      this.targetRotation,
      this.config.turnSpeed * dt
    );

    this.state.position.addScaledVector(this.state.velocity, dt);
    this.state.facingRight = Math.sin(this.state.rotation) > 0;
  }

  private faceLockOn(dt: number) {
    if (!this.lockOnTarget) return;
    const toTarget = new THREE.Vector3()
      .subVectors(this.lockOnTarget.state.position, this.state.position)
      .setY(0);
    if (toTarget.lengthSq() < 1e-6) return;
    this.targetRotation = Math.atan2(toTarget.x, toTarget.z);
    this.state.rotation = lerpAngle(this.state.rotation, this.targetRotation, this.config.turnSpeed * dt);
    this.state.facingRight = Math.sin(this.state.rotation) > 0;
  }

  private handleActions(input: InputSystem) {
    if (this.state.isGrounded && input.consumeBuffered(Action.Jump)) {
      this.state.velocity.y = this.config.jumpForce;
      this.state.isGrounded = false;
    }

    if (input.consumeBuffered(Action.Dodge) && this.dodgeCooldownTimer <= 0) {
      this.startDodge();
    }

    this.state.isBlocking = input.getAction(Action.Block).held;
  }

  private startDodge() {
    this.state.isDodging = true;
    this.state.isRunning = false;
    this.moveHoldTime = 0;
    this.dodgeTimer = this.config.dodgeDuration;
    this.dodgeElapsed = 0;
    this.dodgeCooldownTimer = this.config.dodgeCooldown;

    // Dodge where you're moving; with no input, step back away from the
    // opponent (a backstep) rather than lunging into them.
    const forward = new THREE.Vector3(
      Math.sin(this.state.rotation),
      0,
      Math.cos(this.state.rotation)
    );
    if (this.state.velocity.lengthSq() > 0.5) {
      this.dodgeDirection.copy(this.state.velocity).setY(0).normalize();
    } else {
      this.dodgeDirection.copy(forward).negate();
    }
  }

  // A short, front-loaded roll that covers a set distance over the dodge
  // duration, then plants — reads as an evasive roll, not a long glide.
  private applyDodgeMovement(dt: number) {
    if (this.dodgeElapsed >= this.config.dodgeDuration) return;
    const e0 = easeOutCubic(this.dodgeElapsed / this.config.dodgeDuration);
    this.dodgeElapsed = Math.min(this.config.dodgeDuration, this.dodgeElapsed + dt);
    const e1 = easeOutCubic(this.dodgeElapsed / this.config.dodgeDuration);
    this.state.position.addScaledVector(this.dodgeDirection, this.config.dodgeDistance * (e1 - e0));
  }

  private applyGravity(dt: number) {
    if (!this.state.isGrounded) {
      this.state.velocity.y += this.config.gravity * dt;
      this.state.position.y += this.state.velocity.y * dt;
    }

    if (this.state.position.y <= 0) {
      this.state.position.y = 0;
      this.state.velocity.y = 0;
      this.state.isGrounded = true;
    }
  }

  // Public arena clamp — re-pin a fighter inside the pit after an external
  // displacement (knockback slide) that bypasses the in-update clamp.
  clampToBounds() {
    this.clampToArena();
  }

  // Keep the fighter inside the circular zone — the floor is round, so a
  // rectangular clamp let them walk off the edge into the void/terraces.
  private clampToArena() {
    const p = this.state.position;
    const r = this.config.arenaRadius;
    const [cx, cz] = this.config.arenaCenter;
    const dx = p.x - cx, dz = p.z - cz;
    const distSq = dx * dx + dz * dz;
    if (distSq > r * r) {
      const d = Math.sqrt(distSq) || 1;
      p.x = cx + (dx / d) * r;
      p.z = cz + (dz / d) * r;
    }
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * Math.min(t, 1);
}

// Fast start, settling to a stop — front-loads the lunge so the step lands
// early and the body plants for the rest of the swing.
function easeOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - x, 3);
}
