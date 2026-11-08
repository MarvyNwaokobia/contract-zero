import * as THREE from 'three';

/**
 * Pooled tracer beams + muzzle flashes for gunfire.
 *
 * Add `group` to the scene and call `update(dt)` each frame. `fire(origin, target)`
 * draws a bright additive streak from muzzle to target that fades fast (reads as a
 * tracer round on a fast projectile) plus a brief muzzle flash + point light at the
 * origin. Everything is pooled — no per-shot allocation during a firefight.
 */

const BEAM_LIFE = 0.09;   // seconds the streak stays visible
const FLASH_LIFE = 0.06;  // seconds the muzzle flash stays visible

/** Per-gun look of a shot — thicker tracers and brighter flashes on big guns. */
export interface TracerVisual {
  beamScale?: number;      // tracer thickness multiplier (1 = sidearm)
  flashScale?: number;     // muzzle flash size multiplier
  lightIntensity?: number; // muzzle point-light peak intensity
}

interface Beam { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; life: number }
interface Flash {
  mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; light: THREE.PointLight; life: number;
  baseScale: number; peakIntensity: number;
}

export class TracerFX {
  readonly group = new THREE.Group();

  private beams: Beam[] = [];
  private flashes: Flash[] = [];

  // Scratch vectors so `fire` never allocates.
  private readonly dir = new THREE.Vector3();
  private readonly mid = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly quat = new THREE.Quaternion();

  private acquireBeam(): Beam {
    let b = this.beams.find((x) => x.life <= 0);
    if (!b) {
      const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      // Unit cylinder along +Y; scaled to the shot length and oriented per-fire.
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1, 6), mat);
      mesh.visible = false;
      this.group.add(mesh);
      b = { mesh, mat, life: 0 };
      this.beams.push(b);
    }
    return b;
  }

  private acquireFlash(): Flash {
    let f = this.flashes.find((x) => x.life <= 0);
    if (!f) {
      const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), mat);
      mesh.visible = false;
      // Distance 7 + decay 1.6 so the flash genuinely licks the shooter's body
      // and nearby cover for a frame or two, instead of being a private glow.
      const light = new THREE.PointLight(0xffffff, 0, 7, 1.6);
      this.group.add(mesh);
      this.group.add(light);
      f = { mesh, mat, light, life: 0, baseScale: 1, peakIntensity: 6 };
      this.flashes.push(f);
    }
    return f;
  }

  fire(origin: THREE.Vector3, target: THREE.Vector3, color = 0xffdd88, vis: TracerVisual = {}) {
    const beamScale = vis.beamScale ?? 1;
    const flashScale = vis.flashScale ?? 1;
    const lightIntensity = vis.lightIntensity ?? 6;

    // Streak.
    const b = this.acquireBeam();
    this.dir.subVectors(target, origin);
    const len = this.dir.length() || 0.01;
    this.mid.copy(origin).addScaledVector(this.dir, 0.5);
    this.dir.multiplyScalar(1 / len);
    this.quat.setFromUnitVectors(this.up, this.dir);
    b.mesh.position.copy(this.mid);
    b.mesh.quaternion.copy(this.quat);
    b.mesh.scale.set(beamScale, len, beamScale);
    b.mat.color.setHex(color);
    b.mat.opacity = 0.9;
    b.mesh.visible = true;
    b.life = BEAM_LIFE;

    // Muzzle flash + light pop.
    const f = this.acquireFlash();
    f.mesh.position.copy(origin);
    f.light.position.copy(origin);
    f.mat.color.setHex(color);
    f.mat.opacity = 1;
    f.baseScale = flashScale;
    f.peakIntensity = lightIntensity;
    f.mesh.scale.setScalar(flashScale);
    f.mesh.visible = true;
    f.light.color.setHex(color);
    f.light.intensity = lightIntensity;
    f.life = FLASH_LIFE;
  }

  update(dt: number) {
    for (const b of this.beams) {
      if (b.life <= 0) continue;
      b.life -= dt;
      const t = Math.max(0, b.life / BEAM_LIFE);
      b.mat.opacity = 0.9 * t;
      if (b.life <= 0) b.mesh.visible = false;
    }
    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      const t = Math.max(0, f.life / FLASH_LIFE);
      f.mat.opacity = t;
      f.light.intensity = f.peakIntensity * t;
      f.mesh.scale.setScalar(f.baseScale * (0.6 + 0.8 * (1 - t))); // pops outward as it fades
      if (f.life <= 0) {
        f.mesh.visible = false;
        f.light.intensity = 0;
      }
    }
  }
}
