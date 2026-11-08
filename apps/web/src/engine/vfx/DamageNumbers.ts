import * as THREE from 'three';

/**
 * Pooled floating combat text — damage numbers, crits, DODGE tags.
 *
 * Each entry is a THREE.Sprite whose CanvasTexture is redrawn on spawn (bold
 * outlined text), so there are no font files, no troika, no DOM projection —
 * it renders inside the scene and works everywhere the renderer does (incl.
 * iOS Safari). depthTest is off so a number is never hidden behind a body or
 * cover: if damage happened, the player reads it.
 *
 * Add `group` to the scene and call `update(dt)` each frame.
 */

const LIFE = 0.8;        // seconds on screen
const RISE = 0.9;        // metres risen over the lifetime (eased out)
const CANVAS_W = 256;
const CANVAS_H = 128;

export interface FloatTextOptions {
  color?: string;  // fill colour
  scale?: number;  // 1 = normal hit; crits go bigger
}

interface Entry {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  tex: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  life: number;
  baseY: number;
  drift: number;   // small horizontal drift so stacked numbers separate
  scale: number;
}

export class DamageNumbers {
  readonly group = new THREE.Group();
  private pool: Entry[] = [];

  private acquire(): Entry | null {
    let e = this.pool.find((x) => x.life <= 0);
    if (!e) {
      if (this.pool.length >= 16) return null; // cap — drop rather than grow forever
      const canvas = document.createElement('canvas');
      canvas.width = CANVAS_W;
      canvas.height = CANVAS_H;
      const tex = new THREE.CanvasTexture(canvas);
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.renderOrder = 999;
      this.group.add(sprite);
      e = { sprite, mat, tex, canvas, life: 0, baseY: 0, drift: 0, scale: 1 };
      this.pool.push(e);
    }
    return e;
  }

  /** Show `text` rising from `position` (world space). */
  spawn(position: THREE.Vector3, text: string, opts: FloatTextOptions = {}) {
    const e = this.acquire();
    if (!e) return;
    const color = opts.color ?? '#ffffff';
    const scale = opts.scale ?? 1;

    const ctx = e.canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.font = '900 76px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Heavy dark outline first so the text reads on any background.
    ctx.lineWidth = 14;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(text, CANVAS_W / 2, CANVAS_H / 2);
    ctx.fillStyle = color;
    ctx.fillText(text, CANVAS_W / 2, CANVAS_H / 2);
    e.tex.needsUpdate = true;

    e.sprite.position.copy(position);
    // Slight random offset so a stream of hits doesn't stamp one spot.
    e.sprite.position.x += (Math.random() - 0.5) * 0.25;
    e.sprite.position.y += 0.25;
    e.baseY = e.sprite.position.y;
    e.drift = (Math.random() - 0.5) * 0.4;
    e.scale = scale;
    e.life = LIFE;
    e.mat.opacity = 1;
    e.sprite.visible = true;
    this.applyTransform(e, 0);
  }

  private applyTransform(e: Entry, t: number) {
    // t: 0 → 1 over the lifetime. Pop in slightly large, rise with ease-out.
    const rise = 1 - Math.pow(1 - t, 3);
    const pop = t < 0.12 ? 1.25 - (t / 0.12) * 0.25 : 1;
    const w = 0.9 * e.scale * pop;
    e.sprite.scale.set(w, w * (CANVAS_H / CANVAS_W), 1);
    e.sprite.position.y = e.baseY + rise * RISE;
    e.sprite.position.x += e.drift * 0.004;
  }

  update(dt: number) {
    for (const e of this.pool) {
      if (e.life <= 0) continue;
      e.life -= dt;
      const t = 1 - Math.max(0, e.life / LIFE);
      this.applyTransform(e, t);
      e.mat.opacity = t > 0.6 ? 1 - (t - 0.6) / 0.4 : 1;
      if (e.life <= 0) e.sprite.visible = false;
    }
  }
}
