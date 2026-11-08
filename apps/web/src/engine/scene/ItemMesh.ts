import * as THREE from 'three';

/**
 * Marketplace item props — the non-gun catalogue rendered as real objects.
 *
 * Flat-shaded primitive style so the armory and exchange read
 * as one armoury: a heater shield for decay protection, ammo crates, the four
 * attachment types, and the XP booster canister. Used by the asset-baking page
 * to render catalogue art; guns come from makeGunMesh directly.
 */

export type ItemMeshId =
  | 'shield'
  | 'ammo_standard'
  | 'ammo_incendiary'
  | 'optic'
  | 'barrel'
  | 'grip'
  | 'magazine'
  | 'booster';

const STEEL = 0x39404a;
const STEEL_DARK = 0x252a32;
const POLYMER = 0x424750;
const POLYMER_DARK = 0x2c313a;
const BRASS = 0xc9a24a;
const CRATE = 0x3a4034;

// Smooth-shaded PBR (no flat-shading) with a strong envMapIntensity so steel and
// brass catch the HDRI and read as real material, matching the weapon art.
function mat(color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({ color, metalness: 0.72, roughness: 0.4, envMapIntensity: 1.35, ...opts });
}
function glowMat(color: number, intensity = 1) {
  return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, metalness: 0.2, roughness: 0.3, envMapIntensity: 0.6 });
}

function box(g: THREE.Group, m: THREE.Material, w: number, h: number, d: number,
  x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.rotation.set(rx, ry, rz);
  g.add(mesh);
  return mesh;
}
function cyl(g: THREE.Group, m: THREE.Material, r0: number, r1: number, len: number,
  x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sides = 10): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, len, sides), m);
  mesh.position.set(x, y, z);
  mesh.rotation.set(rx, ry, rz);
  g.add(mesh);
  return mesh;
}

// ── Protection Shield: a heater shield with a glowing ward rim ────────────────
function buildShield(): THREE.Group {
  const g = new THREE.Group();
  const plate = mat(STEEL, { metalness: 0.7, roughness: 0.35 });
  const plateDark = mat(STEEL_DARK);
  const ward = glowMat(0x4a8dff, 1.2);

  // Three-facet body (slight curve, sides swept BACK) + tapering point
  box(g, plate, 0.20, 0.42, 0.024, 0, 0.04, 0.012);
  box(g, plate, 0.13, 0.40, 0.024, -0.150, 0.045, -0.014, 0, -0.30, 0);
  box(g, plate, 0.13, 0.40, 0.024, 0.150, 0.045, -0.014, 0, 0.30, 0);
  // bottom point (diamond)
  box(g, plate, 0.17, 0.17, 0.024, 0, -0.20, 0.012, 0, 0, Math.PI / 4);

  // Glowing ward rim: top edge, two side rails, two point edges
  box(g, ward, 0.42, 0.018, 0.03, 0, 0.255, 0.006);
  box(g, ward, 0.018, 0.40, 0.03, -0.212, 0.05, -0.032, 0, -0.30, 0.06);
  box(g, ward, 0.018, 0.40, 0.03, 0.212, 0.05, -0.032, 0, 0.30, -0.06);
  box(g, ward, 0.018, 0.20, 0.03, -0.062, -0.235, 0.012, 0, 0, 0.66);
  box(g, ward, 0.018, 0.20, 0.03, 0.062, -0.235, 0.012, 0, 0, -0.66);

  // Centre boss + emblem: twin stacked chevrons (the "guard" mark)
  cyl(g, plateDark, 0.062, 0.070, 0.03, 0, 0.05, 0.036, Math.PI / 2);
  for (const dy of [0.075, 0.005]) {
    box(g, ward, 0.075, 0.018, 0.014, -0.030, dy, 0.056, 0, 0, 0.5);
    box(g, ward, 0.075, 0.018, 0.014, 0.030, dy, 0.056, 0, 0, -0.5);
  }

  // Rivets down the facet seams
  for (const sx of [-0.095, 0.095]) {
    for (let i = 0; i < 3; i++) cyl(g, plateDark, 0.01, 0.01, 0.014, sx, 0.20 - i * 0.14, 0.02, Math.PI / 2, 0, 0, 6);
  }
  return g;
}

// ── Ammo crates: brass rounds on an olive crate; incendiary burns orange ─────
function buildAmmo(incendiary: boolean): THREE.Group {
  const g = new THREE.Group();
  const crate = mat(CRATE, { metalness: 0.2, roughness: 0.8 });
  const crateDark = mat(0x2c3128, { metalness: 0.2, roughness: 0.8 });
  const brass = mat(BRASS, { metalness: 0.85, roughness: 0.3 });
  const tip = incendiary ? glowMat(0xff7a2a, 1.1) : mat(0x8a8f96, { metalness: 0.8, roughness: 0.35 });
  const stripe = incendiary ? glowMat(0xff7a2a, 0.8) : mat(0x9aa0a6, { metalness: 0.4 });

  // Crate with lid lip + stencil stripe
  box(g, crate, 0.34, 0.16, 0.22, 0, -0.06, 0);
  box(g, crateDark, 0.35, 0.03, 0.23, 0, 0.035, 0);
  box(g, stripe, 0.342, 0.024, 0.06, 0, -0.055, 0.082);
  // Side handles
  box(g, crateDark, 0.03, 0.02, 0.10, -0.185, -0.03, 0);
  box(g, crateDark, 0.03, 0.02, 0.10, 0.185, -0.03, 0);

  // Rounds standing/leaning on the lid
  const spots: [number, number, number][] = [[-0.08, 0, -0.02], [0, 0.02, 0.03], [0.09, -0.01, -0.03]];
  spots.forEach(([x, , z], i) => {
    const lean = (i - 1) * 0.16;
    cyl(g, brass, 0.021, 0.023, 0.12, x, 0.11, z, 0, 0, lean, 8);
    cyl(g, tip, 0.004, 0.019, 0.05, x - lean * 0.085, 0.195, z, 0, 0, lean, 8);
  });
  return g;
}

// ── Optic: a standalone scope on its mount plate ─────────────────────────────
function buildOptic(): THREE.Group {
  const g = new THREE.Group();
  const body = mat(STEEL_DARK, { metalness: 0.7, roughness: 0.35 });
  const metal = mat(STEEL);
  const lens = glowMat(0x66ccff, 0.8);

  box(g, metal, 0.06, 0.02, 0.30, 0, -0.09, 0); // rail plate
  box(g, body, 0.036, 0.07, 0.05, 0, -0.045, -0.06);
  box(g, body, 0.036, 0.07, 0.05, 0, -0.045, 0.05);
  cyl(g, body, 0.038, 0.038, 0.20, 0, 0.01, 0, Math.PI / 2);      // main tube
  cyl(g, body, 0.055, 0.046, 0.07, 0, 0.01, 0.125, Math.PI / 2);  // objective bell
  cyl(g, body, 0.046, 0.042, 0.06, 0, 0.01, -0.125, Math.PI / 2); // ocular
  const l = new THREE.Mesh(new THREE.CircleGeometry(0.048, 14), lens);
  l.position.set(0, 0.01, 0.161);
  g.add(l);
  cyl(g, metal, 0.02, 0.02, 0.03, 0, 0.075, 0, 0, 0, 0, 8);       // elevation turret
  cyl(g, metal, 0.02, 0.02, 0.03, 0.065, 0.01, 0, 0, 0, Math.PI / 2, 8); // windage
  return g;
}

// ── Barrel: a suppressor with thread collar and heat vents ───────────────────
function buildBarrel(): THREE.Group {
  const g = new THREE.Group();
  const body = mat(POLYMER_DARK, { metalness: 0.6, roughness: 0.45 });
  const metal = mat(STEEL);
  const accentM = glowMat(0xffaa33, 0.4);

  cyl(g, body, 0.045, 0.045, 0.34, 0, 0, 0, Math.PI / 2);
  cyl(g, metal, 0.03, 0.03, 0.05, 0, 0, -0.19, Math.PI / 2);  // thread collar
  cyl(g, metal, 0.047, 0.04, 0.03, 0, 0, 0.175, Math.PI / 2); // end cap
  // vent rings
  for (let i = 0; i < 3; i++) cyl(g, accentM, 0.047, 0.047, 0.008, 0, 0, -0.08 + i * 0.08, Math.PI / 2);
  return g;
}

// ── Grip: vertical foregrip with finger grooves + rail clamp ─────────────────
function buildGrip(): THREE.Group {
  const g = new THREE.Group();
  const furn = mat(POLYMER, { metalness: 0.15, roughness: 0.7 });
  const dark = mat(POLYMER_DARK);
  const accentM = glowMat(0x33cc66, 0.4);

  box(g, dark, 0.07, 0.035, 0.14, 0, 0.10, 0);       // rail clamp
  box(g, accentM, 0.074, 0.008, 0.03, 0, 0.10, 0);   // clamp lever accent
  box(g, furn, 0.045, 0.19, 0.055, 0, -0.02, 0.01, 0.12); // grip body
  for (let i = 0; i < 3; i++) box(g, dark, 0.048, 0.016, 0.058, 0, 0.015 - i * 0.05, 0.014, 0.12); // grooves
  box(g, furn, 0.05, 0.03, 0.06, 0, -0.125, 0.024, 0.12);  // flared base
  return g;
}

// ── Magazine: extended curved mag with a chambered round showing ─────────────
function buildMagazine(): THREE.Group {
  const g = new THREE.Group();
  const metal = mat(STEEL);
  const dark = mat(STEEL_DARK);
  const brass = mat(BRASS, { metalness: 0.85, roughness: 0.3 });
  const accentM = glowMat(0x06b6d4, 0.5);

  box(g, dark, 0.055, 0.045, 0.10, 0, 0.135, 0.005);          // feed collar
  cyl(g, brass, 0.016, 0.016, 0.07, 0, 0.155, 0.01, 0, 0, Math.PI / 2, 8); // chambered round
  box(g, metal, 0.05, 0.15, 0.085, 0, 0.045, 0, 0.18);        // upper body
  box(g, metal, 0.05, 0.13, 0.08, 0, -0.075, -0.035, 0.42);   // curved lower
  box(g, dark, 0.052, 0.02, 0.082, 0, 0.045, 0.002, 0.18);    // witness band
  box(g, accentM, 0.054, 0.02, 0.078, 0, -0.135, -0.065, 0.42); // baseplate accent
  return g;
}

// ── Booster: an XP canister, glowing charge behind a bolt emblem ─────────────
function buildBooster(): THREE.Group {
  const g = new THREE.Group();
  const metal = mat(STEEL_DARK, { metalness: 0.7, roughness: 0.35 });
  const charge = glowMat(0xffc72a, 1.3);
  const frame = mat(STEEL);

  cyl(g, charge, 0.075, 0.075, 0.22, 0, 0, 0, 0, 0, 0, 12); // glowing core
  cyl(g, metal, 0.09, 0.09, 0.05, 0, 0.135, 0, 0, 0, 0, 12); // cap
  cyl(g, metal, 0.02, 0.02, 0.03, 0, 0.175, 0, 0, 0, 0, 8);  // valve
  cyl(g, metal, 0.09, 0.095, 0.05, 0, -0.135, 0, 0, 0, 0, 12); // base
  // cage struts
  for (const a of [0.6, 2.2, 4.0, 5.6]) {
    box(g, frame, 0.018, 0.24, 0.018, Math.cos(a) * 0.082, 0, Math.sin(a) * 0.082);
  }
  // bolt emblem (zigzag) on the glass
  const bolt = mat(0x1b1e23, { metalness: 0.3, roughness: 0.5 });
  box(g, bolt, 0.02, 0.07, 0.012, -0.012, 0.045, 0.078, 0, 0, 0.5);
  box(g, bolt, 0.02, 0.07, 0.012, 0.006, 0, 0.08, 0, 0, -0.35);
  box(g, bolt, 0.02, 0.07, 0.012, -0.006, -0.048, 0.078, 0, 0, 0.5);
  return g;
}

const BUILDERS: Record<ItemMeshId, () => THREE.Group> = {
  shield: buildShield,
  ammo_standard: () => buildAmmo(false),
  ammo_incendiary: () => buildAmmo(true),
  optic: buildOptic,
  barrel: buildBarrel,
  grip: buildGrip,
  magazine: buildMagazine,
  booster: buildBooster,
};

export function makeItemMesh(id: ItemMeshId): THREE.Group {
  const g = BUILDERS[id]();
  g.name = `item-${id}`;
  g.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) mesh.castShadow = true;
  });
  return g;
}

export const ITEM_MESH_IDS: ItemMeshId[] = [
  'shield', 'ammo_standard', 'ammo_incendiary', 'optic', 'barrel', 'grip', 'magazine', 'booster',
];
