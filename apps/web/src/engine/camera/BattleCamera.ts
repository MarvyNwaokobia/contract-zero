import * as THREE from 'three';
import { losHit } from '../sim/Cover';

/**
 * duel — cinematic side framing of both fighters (intro countdown).
 * ots  — over-the-shoulder soft-lock behind the local player: the fight is seen
 *        from behind your own gun, enemy tracers fly AT the screen, and W always
 *        walks toward the enemy (the yaw feeds camera-relative movement).
 * killcam — slow orbit around one fighter (the winner) for the KO beat.
 * follow — legacy free-orbit follow (unused in the duel flow, kept for tools).
 */
export type CameraMode = 'duel' | 'ots' | 'killcam' | 'follow';

export interface CameraConfig {
  followDistance: number;
  followHeight: number;
  lookAheadDistance: number;
  smoothSpeed: number;
  lockOnDistance: number;
  lockOnHeight: number;
  otsDistance: number;
  otsHeight: number;
  otsShoulder: number;
  otsLookHeight: number;
  otsSmoothSpeed: number;
  killcamDistance: number;
  /** The orbit slowly dollies in to this — the zoom onto the winner. */
  killcamCloseDistance: number;
  killcamHeight: number;
  killcamOrbitSpeed: number; // rad/s the killcam circles the winner
  fovDefault: number;
  fovCombat: number;
  fovOts: number;
  shakeDecay: number;
}

const DEFAULT_CONFIG: CameraConfig = {
  followDistance: 8,
  followHeight: 4,
  lookAheadDistance: 3,
  smoothSpeed: 5,
  lockOnDistance: 9,
  lockOnHeight: 5.2,
  // OTS: close enough that the fighter reads big in the lower corner, high enough
  // to see over every low/medium cover template (≤1.6m) without a raycast.
  otsDistance: 3.4,
  otsHeight: 2.05,
  otsShoulder: 0.85,
  otsLookHeight: 1.35,
  otsSmoothSpeed: 9,
  killcamDistance: 3.6,
  killcamCloseDistance: 2.6,
  killcamHeight: 2.0,
  killcamOrbitSpeed: 0.4,
  fovDefault: 55,
  fovCombat: 48,
  fovOts: 58,
  shakeDecay: 8,
};

// Only cover at least this tall can occlude the OTS camera (it sits at ~2m and
// looks slightly down); shorter pieces are seen over, no pull-in needed.
const OTS_BLOCK_HEIGHT = 1.6;
// Never spring-arm closer to the player than this (avoids clipping the rig).
const OTS_MIN_DISTANCE = 1.2;

export class BattleCamera {
  private camera: THREE.PerspectiveCamera;
  private config: CameraConfig;

  private currentPosition = new THREE.Vector3();
  private currentLookAt = new THREE.Vector3();
  private targetPosition = new THREE.Vector3();
  private targetLookAt = new THREE.Vector3();

  private yaw = 0;
  private pitch = 0.3;
  private lockedOn = false;
  private mode: CameraMode = 'follow';

  // Killcam: which update() argument to orbit, the current orbit azimuth, and
  // whether the azimuth has been seeded from the camera's live position (so the
  // orbit picks up exactly where the OTS camera was — no cut).
  private killcamFocus: 'player' | 'target' = 'player';
  private killcamAngle = 0;
  private killcamSeeded = false;
  private killcamDist = 3.6;

  private shakeOffset = new THREE.Vector3();
  private shakeIntensity = 0;
  private shakeFrequency = 0;
  private shakeTimer = 0;

  private punchAmt = 0;

  private slowMoFov = 0;

  constructor(camera: THREE.PerspectiveCamera, config?: Partial<CameraConfig>) {
    this.camera = camera;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.camera.fov = this.config.fovDefault;
    this.camera.updateProjectionMatrix();
    this.currentPosition.set(0, this.config.lockOnHeight, this.config.lockOnDistance);
    this.currentLookAt.set(0, 1, 0);
    this.camera.position.copy(this.currentPosition);
    this.camera.lookAt(this.currentLookAt);
  }

  get cameraYaw(): number {
    return this.yaw;
  }

  get isLockedOn(): boolean {
    return this.lockedOn;
  }

  get currentMode(): CameraMode {
    return this.mode;
  }

  setMode(mode: CameraMode) {
    this.mode = mode;
    this.lockedOn = mode === 'duel';
  }

  setLockedOn(locked: boolean) {
    this.setMode(locked ? 'duel' : 'follow');
  }

  /** Enter the KO killcam: slow orbit around `focus` ('player' = the first
   *  position passed to update(), 'target' = the second). */
  startKillcam(focus: 'player' | 'target') {
    this.killcamFocus = focus;
    this.killcamSeeded = false;
    this.setMode('killcam');
  }

  toggleLockOn() {
    this.setLockedOn(!this.lockedOn);
  }

  rotateMouse(dx: number, dy: number, sensitivity = 0.003) {
    if (this.lockedOn) return;
    this.yaw -= dx * sensitivity;
    this.pitch = Math.max(-0.2, Math.min(1.2, this.pitch - dy * sensitivity));
  }

  update(
    dt: number,
    playerPos: THREE.Vector3,
    targetPos?: THREE.Vector3
  ) {
    if (this.mode === 'killcam' && targetPos) {
      this.updateKillcam(dt, this.killcamFocus === 'player' ? playerPos : targetPos);
    } else if (this.mode === 'ots' && targetPos) {
      this.updateOverShoulder(dt, playerPos, targetPos);
    } else if (this.lockedOn && targetPos) {
      this.updateLockedOn(dt, playerPos, targetPos);
    } else {
      this.updateFreeFollow(dt, playerPos);
    }

    this.updateShake(dt);
    this.updatePunch(dt);

    // Never let the camera drop below the arena floor.
    this.currentPosition.y = Math.max(this.currentPosition.y, 1.8);

    const finalPos = this.currentPosition.clone().add(this.shakeOffset);
    this.camera.position.copy(finalPos);
    this.camera.lookAt(this.currentLookAt);

    const targetFov = this.mode === 'ots'
      ? this.config.fovOts
      : this.mode === 'killcam' || this.lockedOn
        ? this.config.fovCombat
        : this.config.fovDefault;
    this.camera.fov = THREE.MathUtils.lerp(
      this.camera.fov,
      targetFov + this.slowMoFov,
      dt * 3
    );
    this.camera.updateProjectionMatrix();
  }

  shake(intensity: number, frequency = 30) {
    this.shakeIntensity = Math.max(this.shakeIntensity, intensity);
    this.shakeFrequency = frequency;
  }

  punch(strength = 0.12) {
    this.punchAmt = strength;
  }

  setSlowMoFov(fovOffset: number) {
    this.slowMoFov = fovOffset;
  }

  private updateFreeFollow(dt: number, playerPos: THREE.Vector3) {
    const dist = this.config.followDistance;
    const height = this.config.followHeight;

    this.targetPosition.set(
      playerPos.x + Math.sin(this.yaw) * Math.cos(this.pitch) * dist,
      playerPos.y + height + Math.sin(this.pitch) * dist * 0.5,
      playerPos.z + Math.cos(this.yaw) * Math.cos(this.pitch) * dist
    );

    this.targetLookAt.copy(playerPos);
    this.targetLookAt.y += 1.2;

    const t = 1 - Math.exp(-this.config.smoothSpeed * dt);
    this.currentPosition.lerp(this.targetPosition, t);
    this.currentLookAt.lerp(this.targetLookAt, t);
  }

  /**
   * Over-the-shoulder soft lock: sit behind the player's right shoulder, aim at
   * the enemy's chest. Purely derived from the two fighter positions (no mouse
   * aiming — the stat-duel stays auto-aim), so `cameraYaw` always means
   * "W walks at the enemy" for camera-relative movement in the sim.
   */
  private updateOverShoulder(
    dt: number,
    playerPos: THREE.Vector3,
    targetPos: THREE.Vector3
  ) {
    const fwd = new THREE.Vector3().subVectors(targetPos, playerPos).setY(0);
    if (fwd.lengthSq() < 1e-6) {
      // Degenerate (stacked fighters) — keep the previous heading.
      fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    }
    fwd.normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);

    this.targetPosition.copy(playerPos)
      .addScaledVector(fwd, -this.config.otsDistance)
      .addScaledVector(right, this.config.otsShoulder);
    this.targetPosition.y = playerPos.y + this.config.otsHeight;

    // Spring arm: if tall cover crosses the player→camera line, pull the camera
    // in just in front of the blocking face so the player is never occluded.
    const block = losHit(
      playerPos.x, playerPos.z,
      this.targetPosition.x, this.targetPosition.z,
      OTS_BLOCK_HEIGHT,
    );
    if (block) {
      const arm = new THREE.Vector3(
        this.targetPosition.x - playerPos.x, 0, this.targetPosition.z - playerPos.z);
      const full = arm.length() || 1e-3;
      const hitDist = Math.hypot(block.x - playerPos.x, block.z - playerPos.z);
      const pulled = Math.max(OTS_MIN_DISTANCE, hitDist - 0.35);
      if (pulled < full) {
        arm.multiplyScalar(pulled / full);
        this.targetPosition.x = playerPos.x + arm.x;
        this.targetPosition.z = playerPos.z + arm.z;
      }
    }

    this.targetLookAt.set(targetPos.x, this.config.otsLookHeight, targetPos.z);

    // Movement yaw: controller forward is (-sin yaw, -cos yaw) — solve so that
    // "forward" is exactly the player→enemy direction.
    this.yaw = Math.atan2(-fwd.x, -fwd.z);

    const t = 1 - Math.exp(-this.config.otsSmoothSpeed * dt);
    this.currentPosition.lerp(this.targetPosition, t);
    this.currentLookAt.lerp(this.targetLookAt, t);
  }

  /**
   * KO killcam: a slow, level orbit around the winner at portrait distance.
   * The azimuth is seeded from wherever the camera already is, so entering the
   * killcam is a continuous move (the OTS shot melts into the orbit, no cut).
   */
  private updateKillcam(dt: number, focus: THREE.Vector3) {
    if (!this.killcamSeeded) {
      this.killcamSeeded = true;
      this.killcamAngle = Math.atan2(
        this.currentPosition.x - focus.x,
        this.currentPosition.z - focus.z,
      );
      // Start the orbit at whatever radius the live shot already has…
      this.killcamDist = THREE.MathUtils.clamp(
        Math.hypot(this.currentPosition.x - focus.x, this.currentPosition.z - focus.z),
        this.config.killcamCloseDistance,
        6,
      );
    }
    this.killcamAngle += dt * this.config.killcamOrbitSpeed;
    // …then dolly slowly in on the winner over the beat.
    this.killcamDist = THREE.MathUtils.lerp(
      this.killcamDist,
      this.config.killcamCloseDistance,
      1 - Math.exp(-0.7 * dt),
    );

    this.targetPosition.set(
      focus.x + Math.sin(this.killcamAngle) * this.killcamDist,
      focus.y + this.config.killcamHeight,
      focus.z + Math.cos(this.killcamAngle) * this.killcamDist,
    );
    this.targetLookAt.set(focus.x, focus.y + 1.15, focus.z);
    this.yaw = this.killcamAngle;

    const t = 1 - Math.exp(-this.config.smoothSpeed * dt);
    this.currentPosition.lerp(this.targetPosition, t);
    this.currentLookAt.lerp(this.targetLookAt, t);
  }

  private updateLockedOn(
    dt: number,
    playerPos: THREE.Vector3,
    targetPos: THREE.Vector3
  ) {
    const midpoint = new THREE.Vector3()
      .addVectors(playerPos, targetPos)
      .multiplyScalar(0.5);

    const separation = playerPos.distanceTo(targetPos);
    const dynamicDist = Math.max(
      this.config.lockOnDistance,
      separation * 0.6 + 2
    );

    const toPlayer = new THREE.Vector3()
      .subVectors(playerPos, targetPos)
      .setY(0)
      .normalize();

    const perpendicular = new THREE.Vector3(
      -toPlayer.z,
      0,
      toPlayer.x
    );

    const cameraDir = perpendicular.clone()
      .add(toPlayer.clone().multiplyScalar(0.3))
      .normalize();

    this.targetPosition.copy(midpoint)
      .addScaledVector(cameraDir, dynamicDist)
      .setY(midpoint.y + this.config.lockOnHeight + separation * 0.18);

    this.targetLookAt.copy(midpoint);
    this.targetLookAt.y += 1.2;

    this.yaw = Math.atan2(
      this.targetPosition.x - midpoint.x,
      this.targetPosition.z - midpoint.z
    );

    const t = 1 - Math.exp(-this.config.smoothSpeed * dt);
    this.currentPosition.lerp(this.targetPosition, t);
    this.currentLookAt.lerp(this.targetLookAt, t);
  }

  private updateShake(dt: number) {
    if (this.shakeIntensity <= 0.001) {
      this.shakeOffset.set(0, 0, 0);
      return;
    }

    this.shakeTimer += dt;
    const t = this.shakeTimer * this.shakeFrequency;

    this.shakeOffset.set(
      Math.sin(t * 1.1) * this.shakeIntensity,
      Math.cos(t * 1.3) * this.shakeIntensity * 0.7,
      Math.sin(t * 0.9) * this.shakeIntensity * 0.5
    );

    this.shakeIntensity *= 1 - this.config.shakeDecay * dt;
  }

  private updatePunch(dt: number) {
    const k = 1 - Math.exp(-12 * dt);
    this.punchAmt = THREE.MathUtils.lerp(this.punchAmt, 0, k);
    const dir = new THREE.Vector3()
      .subVectors(this.currentLookAt, this.currentPosition)
      .normalize();
    this.currentPosition.addScaledVector(
      dir, this.punchAmt * this.config.followDistance
    );
  }
}
