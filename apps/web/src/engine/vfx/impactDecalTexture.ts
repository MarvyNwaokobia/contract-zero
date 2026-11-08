import * as THREE from 'three';

/**
 * The decal sheets: 2x2 atlases of four hand-drawn stamps each — bullet-hole
 * scars for hard surfaces, blood splats for what comes out of a body.
 *
 * Drawn on a canvas rather than shipped as an image, unlike the particle sprites
 * next door. A hole is the one part of an impact that is NOT soft: it wants a hard
 * dark core, crisp radial cracks and a bright chipped rim, and every free particle
 * sprite is a soft blob by design (they are built to be blurred and tinted). Baking
 * it here also lets the light and dark parts live in the SAME texture — a tinted
 * white sprite can only ever be one or the other, and a hole needs both.
 *
 * Four variants so a wall taking a burst doesn't show the same stamp four times;
 * ImpactFX picks one per hit and rolls it to a random angle on top.
 */

// 192, not the 128 this started at: a hole is stamped at up to ~0.36m and you can
// walk right up to one, so at 128 the crisp core it is built around was the first
// thing to turn to mush. The whole sheet is still under half a megabyte on the GPU.
const TILE = 192;           // px per variant
const ATLAS = TILE * 2;     // 2x2
export const DECAL_TILES = 4;

/** Deterministic PRNG — the sheet is identical every session, so a hole that looks
 *  wrong on a screenshot can be reproduced. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A closed jagged ring of `points` vertices with radius wobbling in [rMin, rMax]. */
function jaggedPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, rMin: number, rMax: number, points: number, rnd: () => number) {
  ctx.beginPath();
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    const r = rMin + (rMax - rMin) * rnd();
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawHole(ctx: CanvasRenderingContext2D, ox: number, oy: number, rnd: () => number) {
  const c = TILE / 2;
  const cx = ox + c;
  const cy = oy + c;
  ctx.save();
  // Keep every variant inside its own tile: at low mip levels neighbouring tiles
  // bleed into each other, and a 10% margin is what stops that reading as a
  // faint square around distant holes.
  ctx.beginPath();
  ctx.rect(ox, oy, TILE, TILE);
  ctx.clip();

  // 1. Scorch — the soot ring a round burns into whatever it goes through, drawn
  //    FIRST so everything else sits on top of it. This is the layer that makes a
  //    hole read as a hole from across the room: the bright dust bloom and the dark
  //    core are both small and both wash out at range, and without something dirty
  //    and wide underneath them a wall taking a magazine looked freckled rather
  //    than shot up. Deliberately ragged and off-centre, because a clean grey
  //    circle reads as a sticker.
  const soot = ctx.createRadialGradient(cx, cy, c * 0.1, cx, cy, c * 0.98);
  soot.addColorStop(0, 'rgba(38,32,28,0.42)');
  soot.addColorStop(0.42, 'rgba(46,39,34,0.22)');
  soot.addColorStop(0.75, 'rgba(52,45,39,0.08)');
  soot.addColorStop(1, 'rgba(52,45,39,0)');
  ctx.fillStyle = soot;
  ctx.save();
  ctx.translate(cx + (rnd() - 0.5) * c * 0.16, cy + (rnd() - 0.5) * c * 0.16);
  ctx.rotate(rnd() * Math.PI);
  ctx.scale(1, 0.78 + rnd() * 0.3);
  jaggedPath(ctx, 0, 0, c * 0.6, c * 0.98, 26, rnd);
  ctx.fill();
  ctx.restore();

  // 2. Dust bloom — pale powdered material thrown out around the hole.
  const dust = ctx.createRadialGradient(cx, cy, c * 0.06, cx, cy, c * 0.9);
  dust.addColorStop(0, 'rgba(206,199,185,0.34)');
  dust.addColorStop(0.5, 'rgba(196,189,176,0.17)');
  dust.addColorStop(1, 'rgba(190,183,170,0)');
  ctx.fillStyle = dust;
  jaggedPath(ctx, cx, cy, c * 0.52, c * 0.86, 22, rnd);
  ctx.fill();

  // 3. Cracks — short radial splits, tapering and fading as they run out.
  const cracks = 7 + Math.floor(rnd() * 5);
  for (let i = 0; i < cracks; i++) {
    const a = (i / cracks) * Math.PI * 2 + (rnd() - 0.5) * 0.5;
    const len = c * (0.3 + rnd() * 0.5);
    let x = cx + Math.cos(a) * c * 0.16;
    let y = cy + Math.sin(a) * c * 0.16;
    const steps = 4;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const seg = len / steps;
      const wob = (rnd() - 0.5) * 0.45;
      const nx = x + Math.cos(a + wob) * seg;
      const ny = y + Math.sin(a + wob) * seg;
      ctx.strokeStyle = `rgba(26,22,19,${0.6 * (1 - t)})`;
      ctx.lineWidth = 2.4 * (1 - t) + 0.4;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(nx, ny);
      ctx.stroke();
      x = nx; y = ny;
    }
  }

  // 4. Chipped rim — the bright lip of fresh material around the crater, drawn
  //    before the core so the core covers its inner half.
  jaggedPath(ctx, cx, cy, c * 0.2, c * 0.3, 14, rnd);
  ctx.strokeStyle = 'rgba(232,226,212,0.5)';
  ctx.lineWidth = 3;
  ctx.stroke();

  // 5. Core — the hole itself. Nearly opaque, so it reads as a void at any range.
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, c * 0.26);
  core.addColorStop(0, 'rgba(10,9,8,0.98)');
  core.addColorStop(0.62, 'rgba(22,19,16,0.92)');
  core.addColorStop(1, 'rgba(34,29,25,0.55)');
  ctx.fillStyle = core;
  jaggedPath(ctx, cx, cy, c * 0.16, c * 0.26, 16, rnd);
  ctx.fill();

  // 6. Spall — a few dark flecks so the edge isn't a clean silhouette.
  for (let i = 0; i < 14; i++) {
    const a = rnd() * Math.PI * 2;
    const r = c * (0.28 + rnd() * 0.45);
    ctx.fillStyle = `rgba(30,26,22,${0.15 + rnd() * 0.3})`;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 1 + rnd() * 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/**
 * One blood splat: a ragged pool with a directional throw, satellite droplets and
 * a darker centre. Painted in near-white with alpha, because the decal material
 * tints per instance — that keeps one sheet usable for fresh red and dried brown.
 */
function drawSplat(ctx: CanvasRenderingContext2D, ox: number, oy: number, rnd: () => number) {
  const c = TILE / 2;
  const cx = ox + c;
  const cy = oy + c;
  // Every splat gets thrown in some direction; the pool elongates along it and the
  // droplets scatter downstream, so a stamp never reads as a tidy circle.
  const throwAngle = rnd() * Math.PI * 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, TILE, TILE);
  ctx.clip();

  // 1. Main pool — a lobed blob, stretched along the throw.
  ctx.translate(cx, cy);
  ctx.rotate(throwAngle);
  ctx.scale(1, 0.72);
  ctx.beginPath();
  const lobes = 9 + Math.floor(rnd() * 4);
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2;
    // Fatter on the downstream side (cos(a) > 0), so the pool has a direction.
    const bias = 1 + Math.max(0, Math.cos(a)) * 0.5;
    const r = c * (0.24 + rnd() * 0.2) * bias;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else {
      // Quadratic between lobes so the edge is wet and rounded, not a polygon.
      const pa = ((i - 0.5) / lobes) * Math.PI * 2;
      const pr = c * (0.3 + rnd() * 0.3) * bias;
      ctx.quadraticCurveTo(Math.cos(pa) * pr, Math.sin(pa) * pr, x, y);
    }
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,244,244,0.93)';
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, TILE, TILE);
  ctx.clip();

  // 2. Droplets thrown downstream, tapering off with distance.
  const dx = Math.cos(throwAngle);
  const dy = Math.sin(throwAngle);
  for (let i = 0; i < 26; i++) {
    const t = rnd();
    const dist = c * (0.28 + t * 0.68);
    const spread = (rnd() - 0.5) * c * 0.6 * (0.3 + t);
    const x = cx + dx * dist - dy * spread;
    const y = cy + dy * dist + dx * spread;
    const r = (1 + rnd() * 3.6) * (1 - t * 0.55);
    ctx.fillStyle = `rgba(255,240,240,${0.5 + rnd() * 0.45})`;
    ctx.beginPath();
    // Slightly elliptical, long side along the throw — a drop that was moving.
    ctx.ellipse(x, y, r * (1 + rnd() * 0.7), r, throwAngle, 0, Math.PI * 2);
    ctx.fill();
  }

  // 3. A darker heart, so the pool has depth instead of reading as flat paint.
  const deep = ctx.createRadialGradient(cx, cy, 0, cx, cy, c * 0.3);
  deep.addColorStop(0, 'rgba(120,60,60,0.55)');
  deep.addColorStop(1, 'rgba(160,90,90,0)');
  ctx.fillStyle = deep;
  ctx.beginPath();
  ctx.arc(cx, cy, c * 0.3, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function buildAtlas(draw: (ctx: CanvasRenderingContext2D, ox: number, oy: number, rnd: () => number) => void, seed: number): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = ATLAS;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  for (let i = 0; i < DECAL_TILES; i++) {
    draw(ctx, (i % 2) * TILE, Math.floor(i / 2) * TILE, mulberry32(seed + i * 977));
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  // Clamped: a decal quad samples one tile and must never wrap into its neighbour.
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/** The 2x2 bullet-hole sheet. Client-only (needs a canvas); null under SSR. */
export function makeImpactDecalAtlas(): THREE.CanvasTexture | null {
  return buildAtlas(drawHole, 0x5eed);
}

/** The 2x2 blood-splat sheet. Client-only (needs a canvas); null under SSR. */
export function makeBloodDecalAtlas(): THREE.CanvasTexture | null {
  return buildAtlas(drawSplat, 0xb100d);
}
