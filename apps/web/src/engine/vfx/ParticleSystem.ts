import * as THREE from 'three';

interface Particle {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
  size: number;
  color: THREE.Color;
  gravity: number;
  drag: number;
}

export interface ParticleEmission {
  position: THREE.Vector3;
  direction: THREE.Vector3;
  count: number;
  speed: [number, number];
  spread: number;
  life: [number, number];
  size: [number, number];
  color: string;
  colorEnd?: string;
  gravity: number;
  drag: number;
}

export class ParticleSystem {
  private particles: Particle[] = [];
  private geometry: THREE.BufferGeometry;
  private material: THREE.PointsMaterial;
  private points: THREE.Points;
  private maxParticles: number;

  private posArray: Float32Array;
  private colorArray: Float32Array;
  private sizeArray: Float32Array;
  private lastDrawCount = 0;

  constructor(maxParticles = 800) {
    this.maxParticles = maxParticles;

    this.posArray = new Float32Array(maxParticles * 3);
    this.colorArray = new Float32Array(maxParticles * 3);
    this.sizeArray = new Float32Array(maxParticles);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.posArray, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colorArray, 3));
    this.geometry.setAttribute('size', new THREE.BufferAttribute(this.sizeArray, 1));

    this.material = new THREE.PointsMaterial({
      size: 0.15,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      blending: THREE.NormalBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
  }

  get mesh(): THREE.Points {
    return this.points;
  }

  emit(config: ParticleEmission) {
    for (let i = 0; i < config.count; i++) {
      if (this.particles.length >= this.maxParticles) break;

      const speed = lerp(config.speed[0], config.speed[1], Math.random());
      const life = lerp(config.life[0], config.life[1], Math.random());
      const size = lerp(config.size[0], config.size[1], Math.random());

      const dir = config.direction.clone();
      dir.x += (Math.random() - 0.5) * config.spread;
      dir.y += (Math.random() - 0.5) * config.spread;
      dir.z += (Math.random() - 0.5) * config.spread;
      dir.normalize();

      this.particles.push({
        position: config.position.clone().add(
          new THREE.Vector3(
            (Math.random() - 0.5) * 0.2,
            (Math.random() - 0.5) * 0.2,
            (Math.random() - 0.5) * 0.2
          )
        ),
        velocity: dir.multiplyScalar(speed),
        life,
        maxLife: life,
        size,
        color: new THREE.Color(config.color),
        gravity: config.gravity,
        drag: config.drag,
      });
    }
  }

  emitBlood(position: THREE.Vector3, direction: THREE.Vector3, intensity: number) {
    this.emit({
      position,
      direction,
      count: Math.floor(12 + intensity * 18),
      speed: [3, 8],
      spread: 0.6,
      life: [0.2, 0.6],
      size: [0.05, 0.14],
      color: '#990000',
      gravity: -18,
      drag: 0.92,
    });
    this.emit({
      position,
      direction: new THREE.Vector3(0, -1, 0),
      count: Math.floor(4 + intensity * 6),
      speed: [0.5, 2],
      spread: 1.5,
      life: [0.4, 1.0],
      size: [0.08, 0.2],
      color: '#660000',
      gravity: -25,
      drag: 0.88,
    });
  }

  emitSparks(position: THREE.Vector3, direction: THREE.Vector3, intensity: number) {
    this.emit({
      position,
      direction,
      count: Math.floor(8 + intensity * 14),
      speed: [5, 12],
      spread: 0.8,
      life: [0.05, 0.25],
      size: [0.03, 0.07],
      color: '#ffcc44',
      gravity: -8,
      drag: 0.88,
    });
  }

  emitDust(position: THREE.Vector3, intensity: number) {
    this.emit({
      position: position.clone().setY(0.05),
      direction: new THREE.Vector3(0, 1, 0),
      count: Math.floor(4 + intensity * 6),
      speed: [0.5, 2],
      spread: 2,
      life: [0.5, 1.2],
      size: [0.05, 0.15],
      color: '#886644',
      gravity: -1,
      drag: 0.92,
    });
  }

  emitEnergy(position: THREE.Vector3, color: string, intensity: number) {
    this.emit({
      position,
      direction: new THREE.Vector3(0, 1, 0),
      count: Math.floor(10 + intensity * 15),
      speed: [1, 4],
      spread: 2,
      life: [0.3, 0.8],
      size: [0.04, 0.1],
      color,
      gravity: 2,
      drag: 0.88,
    });
  }

  /** A single brass casing kicked out of the breech — arcs, drops, bounces on
   *  the floor (the existing y<0 bounce handles the clink-and-settle). */
  emitCasing(position: THREE.Vector3, sideDir: THREE.Vector3) {
    this.emit({
      position,
      direction: new THREE.Vector3(sideDir.x * 0.8, 1.4, sideDir.z * 0.8),
      count: 1,
      speed: [1.6, 2.6],
      spread: 0.3,
      life: [0.8, 1.2],
      size: [0.045, 0.055],
      color: '#d9a441',
      gravity: -12,
      drag: 0.995,
    });
  }

  emitImpact(position: THREE.Vector3, direction: THREE.Vector3, hitType: 'light' | 'heavy' | 'special') {
    const intensity = hitType === 'light' ? 0.3 : hitType === 'heavy' ? 0.7 : 1;

    this.emitSparks(position, direction, intensity);

    if (hitType !== 'light') {
      this.emitBlood(position, direction, intensity);
    }

    this.emitDust(position, intensity);

    if (hitType === 'special') {
      this.emitEnergy(position, '#aa44ff', intensity);
    }

    // Shockwave ring for heavy/special
    if (hitType !== 'light') {
      const ringCount = hitType === 'special' ? 24 : 12;
      for (let i = 0; i < ringCount; i++) {
        const angle = (i / ringCount) * Math.PI * 2;
        const ringDir = new THREE.Vector3(Math.cos(angle), 0.2, Math.sin(angle));
        this.emit({
          position,
          direction: ringDir,
          count: 1,
          speed: [3, 5],
          spread: 0.1,
          life: [0.2, 0.4],
          size: [0.03, 0.06],
          color: '#ffffff',
          gravity: 0,
          drag: 0.85,
        });
      }
    }
  }

  emitKillBurst(position: THREE.Vector3, classColor: string) {
    this.emitEnergy(position, classColor, 2);
    this.emitBlood(position, new THREE.Vector3(0, 1, 0), 2);
    this.emitSparks(position, new THREE.Vector3(0, 1, 0), 2);

    for (let i = 0; i < 36; i++) {
      const angle = (i / 36) * Math.PI * 2;
      this.emit({
        position,
        direction: new THREE.Vector3(Math.cos(angle), 0.5, Math.sin(angle)),
        count: 2,
        speed: [5, 10],
        spread: 0.3,
        life: [0.4, 1],
        size: [0.04, 0.1],
        color: classColor,
        gravity: -3,
        drag: 0.9,
      });
    }
  }

  update(dt: number) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;

      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }

      p.velocity.y += p.gravity * dt;
      p.velocity.multiplyScalar(p.drag);
      p.position.addScaledVector(p.velocity, dt);

      if (p.position.y < 0) {
        p.position.y = 0;
        p.velocity.y *= -0.3;
        p.velocity.x *= 0.8;
        p.velocity.z *= 0.8;
      }
    }

    this.updateBuffers();
  }

  private updateBuffers() {
    const count = this.particles.length;

    // Idle early-out: when there's nothing to draw and nothing was drawn last
    // frame, skip flagging needsUpdate — otherwise THREE re-uploads the full
    // (empty) buffers to the GPU every frame, which was the prior slowdown.
    if (count === 0 && this.lastDrawCount === 0) return;

    for (let i = 0; i < count; i++) {
      const p = this.particles[i];
      const lifeRatio = p.life / p.maxLife;

      this.posArray[i * 3] = p.position.x;
      this.posArray[i * 3 + 1] = p.position.y;
      this.posArray[i * 3 + 2] = p.position.z;

      this.colorArray[i * 3] = p.color.r * lifeRatio;
      this.colorArray[i * 3 + 1] = p.color.g * lifeRatio;
      this.colorArray[i * 3 + 2] = p.color.b * lifeRatio;

      this.sizeArray[i] = p.size * lifeRatio;
    }

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
    this.geometry.attributes.size.needsUpdate = true;
    this.geometry.setDrawRange(0, count);
    this.lastDrawCount = count;
  }

  get particleCount(): number {
    return this.particles.length;
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
