import * as THREE from 'three';
import type { GunId } from '../combat/GunStats';

/**
 * The armoury — every purchasable gun as a real, distinct model.
 *
 * Each tier is a hand-built low-poly weapon in the game's flat-shaded style:
 * a compact pistol, a stubby suppressed SMG, a full assault rifle, a scoped
 * marksman rifle, and the exotic energy prototype. Built from primitives at
 * runtime (no binaries), so the SAME meshes render in the fighter's hands,
 * in marketplace art, and anywhere else the catalogue shows a weapon.
 *
 * Conventions (shared with FighterModel's GUN_GRIP socket):
 *   - local +Z is the firing direction, +Y is up,
 *   - the ORIGIN sits at the pistol grip (where the palm wraps),
 *   - a `muzzle` anchor (named Object3D) marks the barrel tip for VFX.
 */

// ── Shared palette ────────────────────────────────────────────────────────────
// Real gunmetal is near-black with a cold blue cast; the polymer furniture is a
// desaturated graphite. The realism comes less from colour than from PBR values
// + an environment map (set via scene.environment) that these surfaces reflect.
const METAL_DARK = 0x2b313a; // receivers, slides — blued steel that catches light
const METAL = 0x3c434e;      // secondary metal — parkerised grey
const POLYMER = 0x363b43;    // furniture: grips, stocks, handguards
const POLYMER_DARK = 0x21252b;

interface GunKit {
  body: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  furn: THREE.MeshStandardMaterial;
  furnDark: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  glow: THREE.MeshStandardMaterial;
  group: THREE.Group;
}

// Restrained, tactical accents — desaturated tones, low glow. Candy-bright neon
// on grey plastic is the #1 "kids' toy" tell; a real weapon shows its tier
// through finish and a single disciplined accent, not a glowing stripe. Only the
// exotic prototype keeps a real emissive (it's an energy weapon).
const ACCENTS: Record<GunId, { color: number; glow: number }> = {
  sidearm:       { color: 0x8b9096, glow: 0.0 },  // plain steel
  smg:           { color: 0xa8763f, glow: 0.06 }, // muted amber
  assault_rifle: { color: 0x5c7f63, glow: 0.06 }, // field green
  marksman:      { color: 0x6d8aa8, glow: 0.08 }, // steel blue
  legendary:     { color: 0x8f6fc4, glow: 0.75 }, // exotic violet — still glows
  ashfall_carbine: { color: 0xb08a4a, glow: 0.10 }, // brass
  warden_repeater: { color: 0x7a6350, glow: 0.06 }, // walnut + steel
  rift_lance:      { color: 0x37d0e0, glow: 0.85 }, // rift cyan — an energy weapon
  seraph_lmg:      { color: 0x8e949c, glow: 0.08 }, // gunmetal
  ember_halo:      { color: 0xff8a3a, glow: 0.9 },  // ember — the exotic
};

/** Molded-polymer furniture: matte with a faint clearcoat sheen, not shiny. */
function polymer(color: number, roughness: number): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color, metalness: 0.0, roughness,
    clearcoat: 0.35, clearcoatRoughness: 0.55, envMapIntensity: 0.8,
  });
}

function makeKit(gunId: GunId): GunKit {
  const a = ACCENTS[gunId];
  return {
    // Blued/parkerised steel: high metalness, mid-low roughness, and a strong
    // envMapIntensity so it actually catches reflections and reads as metal.
    body: new THREE.MeshStandardMaterial({ color: METAL_DARK, metalness: 0.95, roughness: 0.3, envMapIntensity: 1.8 }),
    metal: new THREE.MeshStandardMaterial({ color: METAL, metalness: 0.9, roughness: 0.4, envMapIntensity: 1.5 }),
    furn: polymer(POLYMER, 0.58),
    furnDark: polymer(POLYMER_DARK, 0.62),
    accent: new THREE.MeshStandardMaterial({ color: a.color, metalness: 0.55, roughness: 0.35, emissive: a.color, emissiveIntensity: a.glow * 0.4, envMapIntensity: 1.0 }),
    glow: new THREE.MeshStandardMaterial({ color: a.color, emissive: a.color, emissiveIntensity: a.glow, metalness: 0.2, roughness: 0.3, envMapIntensity: 0.6 }),
    group: new THREE.Group(),
  };
}

// Positioned box/cylinder helpers keep the builders readable.
function box(k: GunKit, mat: THREE.Material, w: number, h: number, d: number,
  x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  k.group.add(m);
  return m;
}

/** Cylinder whose axis runs along local +Z (the barrel direction). Default sides
 *  are high so barrels/suppressors read as round steel, not faceted toys. */
function zCyl(k: GunKit, mat: THREE.Material, r0: number, r1: number, len: number,
  x: number, y: number, z: number, sides = 24): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, len, sides), mat);
  m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  k.group.add(m);
  return m;
}

function finish(k: GunKit, gunId: GunId, muzzleY: number, muzzleZ: number): THREE.Group {
  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.set(0, muzzleY, muzzleZ);
  k.group.add(muzzle);
  k.group.name = `gun-${gunId}`;
  k.group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) mesh.castShadow = true;
  });
  return k.group;
}

// ── Tier 1 · Standard Sidearm: compact service pistol ────────────────────────
function buildSidearm(): THREE.Group {
  const k = makeKit('sidearm');

  // frame + slide
  box(k, k.metal, 0.032, 0.030, 0.160, 0, 0.046, 0.024);
  box(k, k.body, 0.034, 0.032, 0.190, 0, 0.076, 0.028);
  // slide serrations (rear grip cuts)
  box(k, k.furnDark, 0.036, 0.024, 0.030, 0, 0.076, -0.052);
  // ejection port
  box(k, k.accent, 0.002, 0.014, 0.034, 0.018, 0.080, 0.012);
  // sights
  box(k, k.body, 0.024, 0.012, 0.010, 0, 0.098, -0.058);
  box(k, k.body, 0.006, 0.012, 0.008, 0, 0.098, 0.108);
  // barrel stub
  zCyl(k, k.metal, 0.0085, 0.0085, 0.024, 0, 0.076, 0.132);
  // grip (raked back), palm at origin
  box(k, k.furn, 0.030, 0.112, 0.044, 0, -0.048, -0.014, 0.16);
  box(k, k.furnDark, 0.032, 0.030, 0.046, 0, -0.098, -0.022, 0.16); // mag base flare
  box(k, k.accent, 0.026, 0.008, 0.040, 0, -0.112, -0.024, 0.16);   // baseplate accent
  // trigger guard (D-shape from two bars) + trigger
  box(k, k.metal, 0.006, 0.006, 0.052, 0, -0.004, 0.046);
  box(k, k.metal, 0.006, 0.034, 0.006, 0, 0.012, 0.070);
  box(k, k.body, 0.005, 0.022, 0.006, 0, 0.012, 0.036, 0.25);

  return finish(k, 'sidearm', 0.076, 0.146);
}

// ── Tier 2 · Compact SMG: stubby, suppressed, mag-forward ────────────────────
function buildSmg(): THREE.Group {
  const k = makeKit('smg');

  // receiver + top rail
  box(k, k.body, 0.050, 0.060, 0.300, 0, 0.052, 0.020);
  box(k, k.furnDark, 0.022, 0.012, 0.270, 0, 0.088, 0.020);
  // rail notches
  for (let i = 0; i < 5; i++) box(k, k.body, 0.024, 0.004, 0.010, 0, 0.096, -0.08 + i * 0.05);
  // sights
  box(k, k.metal, 0.020, 0.018, 0.008, 0, 0.104, -0.098);
  box(k, k.metal, 0.006, 0.018, 0.008, 0, 0.104, 0.128);
  // barrel + suppressor
  zCyl(k, k.metal, 0.011, 0.011, 0.070, 0, 0.052, 0.205);
  zCyl(k, k.furnDark, 0.017, 0.017, 0.115, 0, 0.052, 0.288);
  box(k, k.accent, 0.002, 0.010, 0.090, 0.017, 0.052, 0.288); // suppressor accent line
  // magazine, raked slightly forward of the grip
  box(k, k.metal, 0.028, 0.140, 0.050, 0, -0.055, 0.075, -0.14);
  box(k, k.accent, 0.030, 0.014, 0.052, 0, -0.122, 0.085, -0.14);
  // pistol grip at origin
  box(k, k.furn, 0.032, 0.105, 0.046, 0, -0.044, -0.026, 0.14);
  // forward grip
  box(k, k.furn, 0.028, 0.072, 0.036, 0, -0.028, 0.150, -0.10);
  // trigger guard
  box(k, k.metal, 0.006, 0.006, 0.055, 0, -0.006, 0.026);
  box(k, k.metal, 0.006, 0.030, 0.006, 0, 0.008, 0.052);
  // collapsed wire stock: twin rods + butt plate
  zCyl(k, k.metal, 0.006, 0.006, 0.130, 0.014, 0.052, -0.195, 16);
  zCyl(k, k.metal, 0.006, 0.006, 0.130, -0.014, 0.052, -0.195, 16);
  box(k, k.furnDark, 0.052, 0.072, 0.016, 0, 0.044, -0.266);
  // ejection port
  box(k, k.accent, 0.002, 0.016, 0.040, 0.026, 0.058, -0.020);

  return finish(k, 'smg', 0.052, 0.348);
}

// ── Tier 3 · Assault Rifle: full-size, curved mag, fixed stock ───────────────
function buildAssaultRifle(): THREE.Group {
  const k = makeKit('assault_rifle');

  // lower + upper receiver
  box(k, k.metal, 0.042, 0.050, 0.240, 0, 0.040, 0.010);
  box(k, k.body, 0.044, 0.046, 0.260, 0, 0.086, 0.020);
  // carry rail
  box(k, k.furnDark, 0.020, 0.012, 0.240, 0, 0.116, 0.020);
  // handguard with side rails + vents
  box(k, k.furn, 0.046, 0.052, 0.200, 0, 0.072, 0.250);
  box(k, k.accent, 0.002, 0.010, 0.160, 0.024, 0.072, 0.250);
  box(k, k.accent, 0.002, 0.010, 0.160, -0.024, 0.072, 0.250);
  for (let i = 0; i < 3; i++) box(k, k.furnDark, 0.048, 0.010, 0.026, 0, 0.052, 0.185 + i * 0.055);
  // barrel + muzzle brake
  zCyl(k, k.metal, 0.010, 0.010, 0.120, 0, 0.072, 0.408);
  box(k, k.body, 0.024, 0.024, 0.050, 0, 0.072, 0.478);
  box(k, k.furnDark, 0.028, 0.006, 0.036, 0, 0.084, 0.478);
  // sights: front post + rear
  box(k, k.metal, 0.008, 0.026, 0.008, 0, 0.128, 0.330);
  box(k, k.metal, 0.022, 0.016, 0.010, 0, 0.128, -0.070);
  // curved magazine (two angled segments) + accent baseplate
  box(k, k.metal, 0.030, 0.090, 0.056, 0, -0.070, 0.078, 0.22);
  box(k, k.metal, 0.030, 0.072, 0.050, 0, -0.140, 0.048, 0.46);
  box(k, k.accent, 0.032, 0.014, 0.052, 0, -0.172, 0.030, 0.46);
  // pistol grip at origin
  box(k, k.furn, 0.032, 0.108, 0.048, 0, -0.046, -0.024, 0.22);
  // trigger guard
  box(k, k.metal, 0.006, 0.006, 0.056, 0, -0.008, 0.030);
  box(k, k.metal, 0.006, 0.032, 0.006, 0, 0.008, 0.056);
  // buffer tube + fixed stock with cheek riser + butt pad
  zCyl(k, k.metal, 0.015, 0.015, 0.100, 0, 0.070, -0.160, 16);
  box(k, k.furn, 0.040, 0.088, 0.140, 0, 0.036, -0.262);
  box(k, k.furn, 0.036, 0.026, 0.110, 0, 0.094, -0.256);
  box(k, k.furnDark, 0.046, 0.104, 0.016, 0, 0.032, -0.336);
  box(k, k.accent, 0.012, 0.020, 0.060, 0, 0.086, -0.150); // tier tag on the tube

  return finish(k, 'assault_rifle', 0.072, 0.504);
}

// ── Tier 4 · Marksman Rifle: long barrel, scope, precision stock ─────────────
function buildMarksman(): THREE.Group {
  const k = makeKit('marksman');

  // receiver
  box(k, k.body, 0.045, 0.055, 0.300, 0, 0.058, -0.010);
  box(k, k.furnDark, 0.020, 0.010, 0.280, 0, 0.094, -0.010);
  // long vented handguard
  box(k, k.furn, 0.048, 0.050, 0.260, 0, 0.058, 0.270);
  for (let i = 0; i < 4; i++) {
    box(k, k.furnDark, 0.050, 0.010, 0.028, 0, 0.040, 0.185 + i * 0.058);
    box(k, k.furnDark, 0.050, 0.010, 0.028, 0, 0.076, 0.185 + i * 0.058);
  }
  // barrel + brake
  zCyl(k, k.metal, 0.009, 0.009, 0.280, 0, 0.058, 0.540);
  zCyl(k, k.body, 0.014, 0.014, 0.055, 0, 0.058, 0.702);
  box(k, k.furnDark, 0.032, 0.005, 0.040, 0, 0.070, 0.702);
  // scope: mounts, tube, bells, glinting objective lens, turrets
  box(k, k.metal, 0.014, 0.034, 0.022, 0, 0.112, -0.048);
  box(k, k.metal, 0.014, 0.034, 0.022, 0, 0.112, 0.030);
  zCyl(k, k.body, 0.018, 0.018, 0.150, 0, 0.146, -0.008);
  zCyl(k, k.body, 0.027, 0.023, 0.045, 0, 0.146, 0.082);
  zCyl(k, k.body, 0.023, 0.020, 0.038, 0, 0.146, -0.096);
  const lens = new THREE.Mesh(
    new THREE.CircleGeometry(0.023, 12),
    new THREE.MeshStandardMaterial({ color: 0x66ccff, emissive: 0x66ccff, emissiveIntensity: 0.7, metalness: 0.1, roughness: 0.2 }),
  );
  lens.position.set(0, 0.146, 0.1052);
  k.group.add(lens);
  zCyl(k, k.metal, 0.010, 0.010, 0.016, 0, 0.178, -0.008, 16); // elevation turret
  box(k, k.metal, 0.030, 0.012, 0.014, 0.012, 0.146, -0.008); // windage turret
  // straight precision mag + accent base
  box(k, k.metal, 0.032, 0.100, 0.060, 0, -0.075, 0.060, 0.10);
  box(k, k.accent, 0.034, 0.014, 0.056, 0, -0.128, 0.052, 0.10);
  // grip at origin
  box(k, k.furn, 0.032, 0.105, 0.048, 0, -0.045, -0.026, 0.24);
  // trigger guard
  box(k, k.metal, 0.006, 0.006, 0.052, 0, -0.008, 0.026);
  box(k, k.metal, 0.006, 0.030, 0.006, 0, 0.008, 0.050);
  // precision stock: body, cheek riser, butt pad, bottom hook
  box(k, k.furn, 0.042, 0.075, 0.220, 0, 0.040, -0.230);
  box(k, k.accent, 0.036, 0.028, 0.120, 0, 0.100, -0.230);
  box(k, k.furnDark, 0.046, 0.115, 0.018, 0, 0.024, -0.346);
  box(k, k.furn, 0.030, 0.050, 0.045, 0, -0.026, -0.290);
  // folded bipod legs under the handguard
  zCyl(k, k.metal, 0.005, 0.005, 0.110, 0.016, 0.026, 0.320, 16);
  zCyl(k, k.metal, 0.005, 0.005, 0.110, -0.016, 0.026, 0.320, 16);

  return finish(k, 'marksman', 0.058, 0.730);
}

// ── Tier 5 · Valor Prototype: exotic energy rifle, glowing core + coils ──────
function buildLegendary(): THREE.Group {
  const k = makeKit('legendary');

  // angular core receiver + canted top plates
  box(k, k.body, 0.050, 0.068, 0.300, 0, 0.056, 0.000);
  box(k, k.metal, 0.044, 0.020, 0.240, 0, 0.104, -0.010, 0.10);
  box(k, k.metal, 0.044, 0.020, 0.120, 0, 0.108, 0.110, -0.14);
  // exposed energy cell riding the spine
  zCyl(k, k.glow, 0.019, 0.019, 0.095, 0, 0.096, -0.052, 16);
  box(k, k.body, 0.050, 0.016, 0.020, 0, 0.096, -0.108);
  box(k, k.body, 0.050, 0.016, 0.020, 0, 0.096, 0.004);
  // spine fin
  box(k, k.metal, 0.008, 0.040, 0.120, 0, 0.130, -0.160, -0.10);
  // emissive barrel rod inside a finned shroud
  zCyl(k, k.glow, 0.0075, 0.0075, 0.360, 0, 0.056, 0.300, 16);
  for (const ang of [0.785, 2.356, 3.927, 5.498]) {
    const fin = box(k, k.body, 0.006, 0.034, 0.130, 0, 0.056, 0.170);
    fin.position.x = Math.cos(ang) * 0.020;
    fin.position.y = 0.056 + Math.sin(ang) * 0.020;
    fin.rotation.z = ang;
  }
  // coil rings along the barrel
  for (let i = 0; i < 3; i++) {
    zCyl(k, k.accent, 0.024, 0.024, 0.016, 0, 0.056, 0.240 + i * 0.085, 16);
  }
  // muzzle emitter ring
  zCyl(k, k.glow, 0.019, 0.014, 0.035, 0, 0.056, 0.470, 16);
  // underslung capacitor with charge strip
  box(k, k.metal, 0.032, 0.052, 0.110, 0, -0.048, 0.100, 0.12);
  box(k, k.glow, 0.034, 0.010, 0.080, 0, -0.052, 0.096, 0.12);
  // grip at origin
  box(k, k.furn, 0.032, 0.105, 0.048, 0, -0.046, -0.026, 0.22);
  // trigger guard
  box(k, k.metal, 0.006, 0.006, 0.052, 0, -0.008, 0.028);
  box(k, k.metal, 0.006, 0.030, 0.006, 0, 0.008, 0.052);
  // skeletal stock: twin angled struts to a butt frame
  box(k, k.metal, 0.010, 0.014, 0.200, 0, 0.078, -0.190, 0.14);
  box(k, k.metal, 0.010, 0.014, 0.190, 0, -0.006, -0.180, -0.20);
  box(k, k.furnDark, 0.040, 0.120, 0.018, 0, 0.028, -0.296);
  box(k, k.glow, 0.012, 0.060, 0.010, 0, 0.028, -0.306);

  return finish(k, 'legendary', 0.056, 0.492);
}

const BUILDERS: Record<GunId, () => THREE.Group> = {
  sidearm: buildSidearm,
  smg: buildSmg,
  assault_rifle: buildAssaultRifle,
  marksman: buildMarksman,
  legendary: buildLegendary,
  // The seasonal weapons reuse the closest silhouette for the low-poly crate icon;
  // their real, fully-detailed models live in scene/proceduralGuns.ts.
  ashfall_carbine: buildAssaultRifle,
  warden_repeater: buildMarksman,
  rift_lance: buildLegendary,
  seraph_lmg: buildAssaultRifle,
  ember_halo: buildLegendary,
};

/** Build the real model for a gun tier, with a `muzzle` anchor at the barrel tip. */
export function makeGunMesh(gunId: GunId): THREE.Group {
  return (BUILDERS[gunId] ?? BUILDERS.sidearm)();
}
