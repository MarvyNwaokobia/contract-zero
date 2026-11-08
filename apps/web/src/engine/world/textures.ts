import * as THREE from 'three';

// All textures are generated on a canvas at runtime — the project ships no image
// assets, so this is how the arena stops looking like flat-shaded geometry.

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

// Rough stone blocks: noisy base, mortar lines, a few cracks. Returns a tiling
// colour map plus a matching bump map for cheap surface relief.
export function makeStoneTexture(base: string): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const [r, g, b] = hexToRgb(base);

  // grainy base
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const n = (Math.random() - 0.5) * 36;
    img.data[i * 4] = Math.max(0, Math.min(255, r + n));
    img.data[i * 4 + 1] = Math.max(0, Math.min(255, g + n));
    img.data[i * 4 + 2] = Math.max(0, Math.min(255, b + n));
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  // mortar lines — offset brick courses
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 2;
  const rows = 4;
  const rh = size / rows;
  for (let row = 0; row <= rows; row++) {
    const y = row * rh;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke();
    const offset = (row % 2) * (size / 8);
    for (let x = offset; x < size + offset; x += size / 4) {
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + rh); ctx.stroke();
    }
  }

  // a few cracks + highlights
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 14; i++) {
    ctx.beginPath();
    let x = Math.random() * size, y = Math.random() * size;
    ctx.moveTo(x, y);
    for (let s = 0; s < 4; s++) { x += (Math.random() - 0.5) * 40; y += (Math.random() - 0.5) * 40; ctx.lineTo(x, y); }
    ctx.stroke();
  }

  const map = new THREE.CanvasTexture(canvas);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 4;

  // bump = grayscale of the same canvas (mortar/cracks read as grooves)
  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = bumpCanvas.height = size;
  const bctx = bumpCanvas.getContext('2d')!;
  bctx.drawImage(canvas, 0, 0);
  const bump = new THREE.CanvasTexture(bumpCanvas);
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping;

  return { map, bump };
}

// Soft round blob for a grounded contact shadow under a fighter.
export function makeBlobShadowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(0.6, 'rgba(0,0,0,0.28)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  return tex;
}
