/**
 * @module scene/proceduralGuns
 * @description The SEASONAL weapons, built in code rather than loaded as GLBs.
 *
 * The original five guns are authored/generated GLB assets. These five are assembled
 * from primitives at runtime, which means a new weapon costs a function rather than a
 * modelling pipeline — and, because every part is parameterised, a whole family can
 * share anatomy while reading as clearly different objects in the hand.
 *
 * What makes them not look like stacked boxes:
 *
 *  • REAL ANATOMY. Each gun is composed of the parts an actual weapon has — receiver,
 *    barrel, handguard, gas block, muzzle device, magazine, pistol grip, stock, optic
 *    — at believable relative proportions. Silhouette is what reads at viewmodel size,
 *    and silhouette comes from anatomy.
 *  • CHAMFERS, NOT CUBES. Bodies are built from a rounded-box helper, so every edge
 *    catches a highlight instead of dying into a flat facet.
 *  • MATERIAL SEPARATION. Polymer, machined alloy, blued steel and glass each get
 *    their own roughness/metalness, so the eye reads several materials rather than
 *    one tinted block. That contrast is most of "expensive-looking".
 *  • CUT LINES. Vents, rail slots and panel gaps are thin dark insets — cheap
 *    geometry that reads as manufactured precision.
 *  • ONE EMISSIVE ACCENT. Exotic tiers get a single glowing element, never more; the
 *    restraint is what keeps it looking premium instead of like a toy.
 *
 * Everything is returned in the engine's weapon convention: barrel along +Z, up +Y,
 * origin centred on the receiver, with a `muzzle` anchor at the barrel tip.
 */

import * as THREE from 'three';

// ── Materials ────────────────────────────────────────────────────────────────
// Shared instances: five guns using one polymer material is one shader program.

const MAT = {
  /** Matte polymer — furniture, grips, handguards. Absorbs light, reads as plastic. */
  polymer: (color: number) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.02 }),
  /** Machined aluminium — receivers and rails. Semi-gloss, clearly metal. */
  alloy: (color: number) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.34, metalness: 0.9 }),
  /** Blued steel — barrels, bolts. Darker and glossier than the receiver. */
  steel: (color = 0x1c1d21) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.22, metalness: 1 }),
  /** The dark inset used for vents, panel gaps and rail slots. */
  cut: () => new THREE.MeshStandardMaterial({ color: 0x08090b, roughness: 1, metalness: 0 }),
  /** Optic glass — a touch of transparency and a tint. */
  glass: (color: number) =>
    new THREE.MeshPhysicalMaterial({
      color, roughness: 0.08, metalness: 0, transmission: 0.5,
      transparent: true, opacity: 0.75, ior: 1.45,
    }),
  /** The single glowing accent an exotic is allowed. */
  glow: (color: number, strength = 2.2) =>
    new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: strength, roughness: 0.4, metalness: 0.1,
    }),
};

// ── Primitive helpers ────────────────────────────────────────────────────────

/**
 * A box with bevelled edges. Real objects have no perfectly sharp corners, and the
 * thin bevel is what gives every edge a specular line under a moving light — the
 * single biggest difference between "modelled" and "programmer art".
 */
function roundedBox(w: number, h: number, d: number, r = 0.006, mat?: THREE.Material): THREE.Mesh {
  const radius = Math.min(r, w / 2.2, h / 2.2, d / 2.2);
  const shape = new THREE.Shape();
  const x = w / 2 - radius, y = h / 2 - radius;
  shape.moveTo(-x, -h / 2);
  shape.lineTo(x, -h / 2);
  shape.quadraticCurveTo(w / 2, -h / 2, w / 2, -y);
  shape.lineTo(w / 2, y);
  shape.quadraticCurveTo(w / 2, h / 2, x, h / 2);
  shape.lineTo(-x, h / 2);
  shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, y);
  shape.lineTo(-w / 2, -y);
  shape.quadraticCurveTo(-w / 2, -h / 2, -x, -h / 2);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: d, bevelEnabled: true, bevelSize: radius * 0.5,
    bevelThickness: radius * 0.5, bevelSegments: 2, curveSegments: 3,
  });
  geo.translate(0, 0, -d / 2);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, mat);
}

function tube(rTop: number, rBot: number, len: number, mat: THREE.Material, seg = 12): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, len, seg), mat);
  m.rotation.x = Math.PI / 2; // cylinders are Y-up; the weapon axis is +Z
  return m;
}

function place(o: THREE.Object3D, x: number, y: number, z: number): THREE.Object3D {
  o.position.set(x, y, z);
  return o;
}

/** A run of evenly spaced cut lines — vents, cooling slots, rail teeth. */
function slots(count: number, gap: number, w: number, h: number, d: number, z0: number, y: number, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < count; i++) g.add(place(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat), 0, y, z0 + i * gap));
  return g;
}

// ── Shared sub-assemblies ────────────────────────────────────────────────────

/** Pistol grip, raked back like a real one rather than a vertical slab. */
function pistolGrip(mat: THREE.Material, rake = 0.32): THREE.Group {
  const g = new THREE.Group();
  const body = roundedBox(0.036, 0.115, 0.05, 0.014, mat);
  body.rotation.x = rake;
  g.add(body);
  const flare = roundedBox(0.04, 0.018, 0.055, 0.008, mat);
  flare.rotation.x = rake;
  g.add(place(flare, 0, -0.058, -0.019));
  return g;
}

/** Box magazine with the forward curve a real one has. */
function magazine(mat: THREE.Material, len = 0.14, curve = 0.05): THREE.Group {
  const g = new THREE.Group();
  const seg = 5;
  const step = len / seg;
  for (let i = 0; i < seg; i++) {
    const t = i / (seg - 1);
    // Each segment is TALLER than the step between them, so consecutive blocks
    // overlap into one continuous body. Spacing them exactly a segment apart left
    // hairline gaps that read on screen as a magazine falling apart in mid-air.
    const s = roundedBox(0.03, step * 1.5, 0.044, 0.006, mat);
    g.add(place(s, 0, -i * step, t * t * curve));
  }
  return g;
}

/** Optic: a tube sight on a riser, with tinted glass front and back. */
function opticTube(bodyMat: THREE.Material, glassMat: THREE.Material, len = 0.1, r = 0.02): THREE.Group {
  const g = new THREE.Group();
  g.add(tube(r, r, len, bodyMat));
  g.add(tube(r * 1.12, r * 1.12, 0.012, bodyMat)); // objective bell
  const front = tube(r * 0.86, r * 0.86, 0.004, glassMat);
  g.add(place(front, 0, 0, len / 2 - 0.004));
  const rear = tube(r * 0.86, r * 0.86, 0.004, glassMat);
  g.add(place(rear, 0, 0, -len / 2 + 0.004));
  g.add(place(roundedBox(0.02, 0.026, 0.03, 0.004, bodyMat), 0, -r - 0.01, 0)); // riser
  return g;
}

/** Top rail — the toothed strip that reads instantly as "modern weapon". */
function rail(len: number, z0: number, y: number, alloyMat: THREE.Material, cutMat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const base = roundedBox(0.026, 0.008, len, 0.003, alloyMat);
  g.add(place(base, 0, y, z0));
  const teeth = Math.max(3, Math.floor(len / 0.018));
  g.add(slots(teeth, 0.018, 0.028, 0.004, 0.004, z0 - len / 2 + 0.012, y + 0.005, cutMat));
  return g;
}

/** Muzzle device: a braked, ported barrel tip rather than a flat cut-off. */
function muzzleBrake(mat: THREE.Material, cutMat: THREE.Material, r = 0.014): THREE.Group {
  const g = new THREE.Group();
  g.add(tube(r, r * 1.05, 0.05, mat));
  for (let i = 0; i < 3; i++) {
    g.add(place(new THREE.Mesh(new THREE.BoxGeometry(r * 2.4, 0.004, 0.006), cutMat), 0, 0, -0.014 + i * 0.012));
  }
  return g;
}

// ── The weapons ──────────────────────────────────────────────────────────────

export type ProceduralGunId =
  | 'ashfall_carbine' | 'warden_repeater' | 'rift_lance' | 'seraph_lmg' | 'ember_halo';

/**
 * ASHFALL CARBINE — a compact bullpup. Magazine BEHIND the grip, which is what makes
 * a bullpup read as one: short overall, mass carried at the shoulder. Burnt gunmetal
 * with brass furniture, tying it to the Ashfall zone.
 */
function ashfallCarbine(): THREE.Group {
  const g = new THREE.Group();
  const shell = MAT.polymer(0x3a332c);
  const metal = MAT.alloy(0x6b5a3e);   // brass-ish
  const barrel = MAT.steel(0x201f1d);
  const cut = MAT.cut();

  g.add(place(roundedBox(0.052, 0.096, 0.34, 0.012, shell), 0, 0, -0.02));      // bullpup shell
  g.add(place(roundedBox(0.05, 0.03, 0.1, 0.008, metal), 0, 0.052, -0.02));     // receiver top
  g.add(rail(0.16, -0.03, 0.07, metal, cut));
  g.add(place(tube(0.011, 0.011, 0.26, barrel), 0, 0.012, 0.24));               // barrel
  g.add(place(roundedBox(0.042, 0.05, 0.12, 0.01, shell), 0, 0.006, 0.19));     // handguard
  g.add(slots(4, 0.02, 0.05, 0.005, 0.006, 0.155, 0.03, cut));                  // vents
  g.add(place(muzzleBrake(metal, cut, 0.013), 0, 0.012, 0.38));
  g.add(place(pistolGrip(shell, 0.3), 0, -0.078, 0.06));
  g.add(place(magazine(shell, 0.1, 0.02), 0, -0.05, -0.1));                     // behind grip
  g.add(place(opticTube(metal, MAT.glass(0xffb066), 0.09, 0.018), 0, 0.098, -0.02));
  g.add(place(roundedBox(0.03, 0.055, 0.05, 0.012, shell), 0, -0.02, -0.19));   // butt pad
  return g;
}

/**
 * WARDEN'S REPEATER — a heavy battle rifle. Long receiver, thick barrel, a stock with
 * an actual comb. Blued steel over dark walnut-toned furniture: the oldest, most
 * deliberate-looking weapon in the set.
 */
function wardenRepeater(): THREE.Group {
  const g = new THREE.Group();
  const wood = MAT.polymer(0x4a3527);
  const metal = MAT.alloy(0x4c5058);
  const barrel = MAT.steel(0x17181b);
  const cut = MAT.cut();

  g.add(place(roundedBox(0.048, 0.078, 0.26, 0.01, metal), 0, 0, 0.02));        // receiver
  g.add(place(roundedBox(0.05, 0.026, 0.09, 0.008, metal), 0, 0.05, 0.02));     // top cover
  g.add(rail(0.12, 0.0, 0.066, metal, cut));
  g.add(place(tube(0.0135, 0.0125, 0.42, barrel), 0, 0.01, 0.36));              // long barrel
  g.add(place(tube(0.019, 0.019, 0.06, metal), 0, 0.01, 0.21));                 // gas block
  g.add(place(roundedBox(0.044, 0.046, 0.2, 0.012, wood), 0, -0.002, 0.24));    // wood handguard
  g.add(slots(5, 0.026, 0.048, 0.005, 0.007, 0.17, 0.022, cut));
  g.add(place(muzzleBrake(metal, cut, 0.015), 0, 0.01, 0.55));
  g.add(place(pistolGrip(wood, 0.34), 0, -0.07, -0.02));
  g.add(place(magazine(metal, 0.16, 0.14), 0, -0.04, 0.07));
  g.add(place(opticTube(metal, MAT.glass(0x8fd6ff), 0.13, 0.022), 0, 0.094, 0.02));
  // Stock with a comb — the profile that says "rifle" from any angle.
  g.add(place(roundedBox(0.036, 0.06, 0.2, 0.014, wood), 0, -0.012, -0.19));
  g.add(place(roundedBox(0.034, 0.03, 0.09, 0.01, wood), 0, 0.026, -0.15));
  g.add(place(roundedBox(0.038, 0.076, 0.026, 0.01, metal), 0, -0.02, -0.29));  // butt plate
  return g;
}

/**
 * RIFT LANCE — an energy marksman rifle. Skeletal alloy frame, an exposed coil down
 * the spine, and a single cyan emissive run. Reads as Rift-tech next to the others
 * without being a different genre.
 */
function riftLance(): THREE.Group {
  const g = new THREE.Group();
  // Light enough to read against a dark card and a night compound. At 0x2b3038 the
  // whole weapon vanished into the background and only the coil was visible.
  const frame = MAT.alloy(0x5a6675);
  const dark = MAT.polymer(0x2e343d);
  const glow = MAT.glow(0x37d0e0, 2.6);
  const cut = MAT.cut();

  g.add(place(roundedBox(0.05, 0.082, 0.32, 0.014, frame), 0, 0, 0.0));         // receiver
  g.add(place(roundedBox(0.054, 0.024, 0.18, 0.007, dark), 0, 0.052, 0.02));
  g.add(rail(0.18, 0.02, 0.068, frame, cut));
  // A solid shroud carries the barrel forward, so the coil sits ON a body instead of
  // hanging in space — the frame was so dark it read as nothing at all.
  g.add(place(roundedBox(0.038, 0.042, 0.26, 0.014, frame), 0, 0.008, 0.24));
  g.add(slots(5, 0.024, 0.042, 0.005, 0.007, 0.15, 0.03, cut));
  g.add(place(tube(0.012, 0.012, 0.4, dark), 0, 0.008, 0.3));                   // barrel
  // Exposed coil: rings encircling the barrel, alternating alloy and light.
  const coil = new THREE.Group();
  for (let i = 0; i < 7; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.023, 0.005, 8, 18), i % 2 ? glow : frame);
    coil.add(place(ring, 0, 0, i * 0.04));
  }
  g.add(place(coil, 0, 0.008, 0.3));
  g.add(place(tube(0.016, 0.009, 0.06, glow), 0, 0.008, 0.53));                 // emitter tip
  g.add(place(roundedBox(0.012, 0.012, 0.2, 0.004, glow), 0, 0.036, 0.0));      // spine light
  g.add(place(pistolGrip(dark, 0.3), 0, -0.07, -0.03));
  g.add(place(magazine(frame, 0.11, 0.03), 0, -0.042, 0.06));
  g.add(place(opticTube(frame, MAT.glass(0x37d0e0), 0.15, 0.024), 0, 0.092, 0.02));
  g.add(place(roundedBox(0.03, 0.05, 0.14, 0.012, dark), 0, -0.006, -0.2));     // skeleton stock
  g.add(place(roundedBox(0.026, 0.012, 0.1, 0.005, frame), 0, 0.022, -0.2));
  return g;
}

/**
 * SERAPH — a belt-fed light machine gun. Drum magazine, carry handle, bipod. The
 * heaviest silhouette in the set: it should look like a burden as much as a gun.
 */
function seraphLmg(): THREE.Group {
  const g = new THREE.Group();
  const shell = MAT.polymer(0x3a3e46);
  const metal = MAT.alloy(0x717884);
  const barrel = MAT.steel(0x141518);
  const cut = MAT.cut();

  g.add(place(roundedBox(0.07, 0.112, 0.34, 0.016, shell), 0, 0, 0.0));         // big receiver
  g.add(place(roundedBox(0.074, 0.034, 0.24, 0.009, metal), 0, 0.07, 0.0));     // top cover
  g.add(slots(6, 0.026, 0.06, 0.006, 0.008, -0.06, 0.086, cut));                // cover ribs
  g.add(rail(0.16, 0.0, 0.082, metal, cut));
  g.add(place(roundedBox(0.018, 0.036, 0.12, 0.008, metal), 0, 0.098, -0.02));  // carry handle
  g.add(place(roundedBox(0.018, 0.012, 0.03, 0.005, metal), 0, 0.082, 0.04));
  g.add(place(tube(0.016, 0.015, 0.44, barrel), 0, 0.008, 0.36));               // heavy barrel
  g.add(slots(7, 0.022, 0.04, 0.006, 0.008, 0.19, 0.028, cut));                 // barrel shroud vents
  g.add(place(tube(0.023, 0.023, 0.16, metal), 0, 0.008, 0.24));                // shroud
  g.add(place(muzzleBrake(metal, cut, 0.018), 0, 0.008, 0.57));
  g.add(place(pistolGrip(shell, 0.3), 0, -0.086, -0.06));
  // Drum magazine — the instant "LMG" tell.
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.058, 20), shell);
  drum.rotation.z = Math.PI / 2;
  g.add(place(drum, 0, -0.1, 0.04));
  g.add(place(new THREE.Mesh(new THREE.TorusGeometry(0.058, 0.008, 8, 20), metal), 0, -0.1, 0.07));
  g.add(place(new THREE.Mesh(new THREE.TorusGeometry(0.058, 0.008, 8, 20), metal), 0, -0.1, 0.01));
  // Feed tray joining drum to receiver, so it hangs off the gun rather than under it.
  g.add(place(roundedBox(0.05, 0.05, 0.06, 0.01, metal), 0, -0.055, 0.04));
  // Bipod, folded down.
  for (const s of [-1, 1]) {
    const leg = roundedBox(0.008, 0.09, 0.008, 0.003, metal);
    leg.rotation.z = s * 0.28;
    g.add(place(leg, s * 0.022, -0.06, 0.34));
  }
  g.add(place(roundedBox(0.038, 0.07, 0.16, 0.014, shell), 0, -0.012, -0.21));  // stock
  return g;
}

/**
 * EMBER HALO — the exotic. Ceramic-white shell, gold furniture, and a ring of ember
 * light around the muzzle that gives it its name. Deliberately the only gun with a
 * bright body: at 10,000 G$ it should be recognisable across the room.
 */
function emberHalo(): THREE.Group {
  const g = new THREE.Group();
  const ceramic = new THREE.MeshStandardMaterial({ color: 0xe8e4dc, roughness: 0.28, metalness: 0.05 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xd4a24c, roughness: 0.22, metalness: 1 });
  const dark = MAT.polymer(0x2a2622);
  const ember = MAT.glow(0xff6a2a, 3.0);
  const cut = MAT.cut();

  g.add(place(roundedBox(0.05, 0.086, 0.3, 0.016, ceramic), 0, 0, 0.0));        // shell
  g.add(place(roundedBox(0.052, 0.024, 0.18, 0.008, gold), 0, 0.055, 0.0));     // gold spine
  g.add(rail(0.16, 0.02, 0.072, gold, cut));
  g.add(place(roundedBox(0.03, 0.03, 0.14, 0.01, dark), 0, 0.006, 0.2));        // shrouded barrel
  g.add(place(tube(0.012, 0.012, 0.3, gold), 0, 0.006, 0.3));
  // The halo: a ring of ember light standing off the muzzle.
  const halo = new THREE.Mesh(new THREE.TorusGeometry(0.032, 0.005, 8, 24), ember);
  g.add(place(halo, 0, 0.006, 0.44));
  const halo2 = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.004, 8, 20), ember);
  g.add(place(halo2, 0, 0.006, 0.47));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    g.add(place(roundedBox(0.006, 0.006, 0.05, 0.002, gold), Math.cos(a) * 0.027, 0.006 + Math.sin(a) * 0.027, 0.425));
  }
  g.add(place(roundedBox(0.014, 0.014, 0.16, 0.005, ember), 0, 0.038, 0.02));   // ember channel
  g.add(place(pistolGrip(dark, 0.32), 0, -0.076, -0.02));
  g.add(place(magazine(ceramic, 0.12, 0.05), 0, -0.046, 0.06));
  g.add(place(opticTube(gold, MAT.glass(0xffb066), 0.12, 0.022), 0, 0.1, 0.0));
  g.add(place(roundedBox(0.034, 0.058, 0.16, 0.016, ceramic), 0, -0.008, -0.2));
  g.add(place(roundedBox(0.036, 0.02, 0.03, 0.008, gold), 0, -0.03, -0.28));
  return g;
}

const BUILDERS: Record<ProceduralGunId, () => THREE.Group> = {
  ashfall_carbine: ashfallCarbine,
  warden_repeater: wardenRepeater,
  rift_lance: riftLance,
  seraph_lmg: seraphLmg,
  ember_halo: emberHalo,
};

/**
 * Build one seasonal weapon, normalised into the engine's convention: barrel down
 * +Z, origin centred, scaled to `targetLen` metres, with a `muzzle` anchor at the
 * tip so the scene can hang tracers and flash off it exactly as it does for a GLB.
 */
export function buildProceduralGun(id: ProceduralGunId, targetLen: number): THREE.Group {
  const inner = BUILDERS[id]();

  const box = new THREE.Box3().setFromObject(inner);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  inner.position.sub(center);                       // centre on the origin
  const scale = size.z > 1e-4 ? targetLen / size.z : 1;
  inner.scale.setScalar(scale);

  const group = new THREE.Group();
  group.add(inner);

  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.set(0, 0, targetLen / 2);
  group.add(muzzle);

  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false; }
  });
  return group;
}
