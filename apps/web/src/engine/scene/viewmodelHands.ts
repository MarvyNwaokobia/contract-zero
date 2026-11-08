/**
 * @module scene/viewmodelHands
 * @description The hands holding your weapon.
 *
 * Until now the first-person viewmodel had ONE 6cm cube of brown, labelled in the
 * scene as "simple graybox hands so the first person reads". It didn't: at the
 * framing the game actually uses it sits behind the receiver and is never visible,
 * so every weapon in Valor floated in front of the camera with nothing holding it.
 * A floating gun is the single loudest "this is a prototype" tell a shooter has —
 * the hands are what make the weapon YOURS rather than a prop on a stick.
 *
 * Built from primitives for the same reason the seasonal weapons are
 * (scene/proceduralGuns): a rig costs a function instead of a modelling and rigging
 * pipeline, and it can be parameterised per weapon — a pistol and an LMG are not
 * held the same way, and the grip has to move with the gun it is on.
 *
 * What makes them not look like stacked boxes, borrowing the gun module's rules:
 *
 *  • GLOVES, NOT SKIN. Tactical gloves fit the operator fantasy, and they dodge the
 *    uncanny problem that a bare hand is a face-level object everyone can spot as
 *    wrong. Fabric, a rubberised palm and a knuckle guard read as three materials.
 *  • SILHOUETTE FIRST. At viewmodel size you read the outline of a fist and the line
 *    of the forearm; nothing finer survives. Fingers are ridges on that outline
 *    rather than articulated digits.
 *  • FOREARMS. A pair of disembodied hands is worse than none — the arms running
 *    back out of frame are what connect the weapon to a body.
 *  • MERGED. Every part of a hand shares a geometry per material, so the whole rig
 *    is three draw calls rather than the twenty-odd it is modelled from. The
 *    viewmodel redraws every frame, in front of everything, on phones.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GunId } from '../combat/GunStats';

/**
 * Where the weapon sits relative to the eye, hip-ready and down the sights. The
 * scene lerps between these by the ADS factor.
 *
 * They live here rather than in ValorScene so the grip bench (/dev/grip) can frame a
 * weapon exactly the way the game does. A bench that is a few centimetres off is
 * worse than no bench: you tune a grip until it reads there and it is wrong in the
 * op, which is precisely the failure these anchors are hand-tuned to avoid.
 */
export const VIEWMODEL_HIP = new THREE.Vector3(0.2, -0.2, -0.5);
// ADS is a gentle RAISE of the hip pose, not a shove into the camera. The rifle is
// ~0.88m long and centred on its origin (rear ~0.44m back), so pulling it to z=-0.32
// AND centring it (x=0) put the chunky receiver end-on ~1cm from the eye = a giant
// black blob. Instead keep it at hip depth (-0.5, whole gun in front), only slightly
// toward centre (x 0.2->0.1 so you still see its side, not its rear), and lift it
// (y -0.2->-0.1). The aim "zoom" comes from the FOV narrowing, not the gun position.
export const VIEWMODEL_ADS = new THREE.Vector3(0.1, -0.1, -0.5);

// Each model is now normalised to its own real length (see gunModels.ts), so
// `scale` is a small fudge for hand-fit, not a size proxy; z/y slide the weapon
// in the hands (a long DMR sits pushed out, a pistol held in close).
export const WEAPON_VIEW: Record<GunId, { scale: number; z: number; y: number }> = {
  sidearm: { scale: 1.0, z: 0.12, y: -0.02 }, // a compact pistol, held in close
  smg: { scale: 1.0, z: 0.05, y: -0.01 },     // stubby, snappy
  assault_rifle: { scale: 1.0, z: 0, y: 0 },  // the baseline
  marksman: { scale: 1.0, z: -0.05, y: 0.01 },// long — pushed out front
  legendary: { scale: 1.0, z: 0, y: 0 },      // the Valor Prototype
  // Seasonal weapons: longer bodies are pushed further out so the muzzle clears frame.
  ashfall_carbine: { scale: 1.0, z: 0.04, y: -0.005 },
  warden_repeater: { scale: 1.0, z: -0.06, y: 0.01 },
  rift_lance:      { scale: 1.0, z: -0.07, y: 0.012 },
  seraph_lmg:      { scale: 1.0, z: -0.03, y: 0.005 },
  ember_halo:      { scale: 1.0, z: -0.02, y: 0.008 },
};


// ── Materials ─────────────────────────────────────────────────────────────────
// Shared instances: ten weapons' worth of hands is still one shader program each.

const GLOVE = new THREE.MeshStandardMaterial({ color: 0x2f3238, roughness: 0.88, metalness: 0.03 });
/** The rubberised palm and finger pads — darker and glossier than the fabric, which
 *  is what separates the gripping surface from the back of the hand. */
const PALM = new THREE.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.55, metalness: 0.06 });
/** Sleeve, a shade off the glove so the cuff line reads. */
const SLEEVE = new THREE.MeshStandardMaterial({ color: 0x1e201b, roughness: 1, metalness: 0 });

/** Dispose the shared materials. Only for tests and hot paths that tear the scene
 *  down; the app holds these for its lifetime. */
export function disposeHandMaterials(): void {
  GLOVE.dispose();
  PALM.dispose();
  SLEEVE.dispose();
}

// ── Primitives ────────────────────────────────────────────────────────────────

/** A rounded box, same construction the procedural guns use, returned as geometry
 *  so it can be merged rather than drawn on its own. */
function box(w: number, h: number, d: number, r = 0.005): THREE.BufferGeometry {
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
    bevelThickness: radius * 0.5, bevelSegments: 1, curveSegments: 2,
  });
  geo.translate(0, 0, -d / 2);
  geo.computeVertexNormals();
  return geo;
}

/** Position + rotate a geometry in place, so parts can be laid out and then merged. */
function at(
  geo: THREE.BufferGeometry,
  x: number, y: number, z: number,
  rx = 0, ry = 0, rz = 0,
): THREE.BufferGeometry {
  if (rx || ry || rz) {
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz));
    geo.applyMatrix4(m);
  }
  geo.translate(x, y, z);
  return geo;
}

/** A tapered limb — the forearm. Cylinders are cheap and the sleeve is the one part
 *  of this rig with no hard edges. Built hanging straight DOWN from its origin, so
 *  the wrist is the pivot and a single X rotation swings it back toward the elbow. */
function limb(rTop: number, rBot: number, len: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, len, 10, 1);
  g.translate(0, -len / 2, 0);
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return mergeGeometries(parts, false) ?? parts[0];
}

// ── One hand ──────────────────────────────────────────────────────────────────

export interface HandOptions {
  /** Mirror the whole hand across X. The two hands are the same model handed. */
  left?: boolean;
  /** Overall size. 1 ≈ an adult hand at 0.09m across; a pistol wants it no smaller,
   *  a big rifle can carry a touch more. */
  scale?: number;
  /** How far the fingers curl around, 0..1. A support hand on a fat handguard opens
   *  out; a firing hand on a thin grip closes right up. */
  curl?: number;
  /** Length of the forearm running back out of frame. 0 for none. */
  forearm?: number;
  /**
   * How far the forearm swings BACK from straight down, in radians: 0 hangs at the
   * wrist, π/2 runs horizontally back toward the shooter. The firing arm wants a lot
   * (elbow tucked at the ribs), the support arm much less — it comes up to the
   * handguard from below, and that difference is most of what stops the two reading
   * as the same arm twice.
   */
  forearmPitch?: number;
  /** Splay of the forearm away from the weapon's centre line. */
  forearmYaw?: number;
}

/**
 * A gloved fist, built around a grip that runs vertically through its centre.
 *
 * Local frame: +Y is up the grip (toward the wrist), +Z is toward the muzzle, +X is
 * outboard. The origin sits where the grip passes through the palm, so a caller
 * positions a hand by saying where on the weapon it is holding — not by working out
 * where its wrist ends up.
 */
export function buildHand(opts: HandOptions = {}): THREE.Group {
  const s = opts.scale ?? 1;
  const curl = opts.curl ?? 1;
  // Handedness is a mirrored LAYOUT, not a mirrored object. Scaling a group by -1 on
  // X reverses triangle winding, so every face culls backwards and the lighting is
  // inside-out; the usual patch (render the back side instead) leaves the normals
  // wrong and the hand lit from the inside. Every part here is symmetric in X, so
  // negating the X offsets and the Y/Z rotations gives a true mirror with correct
  // winding and normals, and costs nothing.
  const m = opts.left ? -1 : 1;
  const glove: THREE.BufferGeometry[] = [];
  const palm: THREE.BufferGeometry[] = [];
  const sleeve: THREE.BufferGeometry[] = [];

  // Back of the hand: the big slab that carries the silhouette, outboard of the grip.
  glove.push(at(box(0.030, 0.098, 0.076, 0.012), m * 0.026, 0.004, 0.002));
  // Knuckle guard — a hard plate across the back, the detail that says "tactical
  // glove" rather than "mitten" in one shape.
  glove.push(at(box(0.026, 0.030, 0.062, 0.008), m * 0.030, 0.036, 0.010));

  // Fingers, wrapping the FRONT of the grip (+Z) and curling inboard. Four ridges
  // down the front rather than four articulated digits: at the size this is drawn,
  // the ridge line is the whole read.
  for (let i = 0; i < 4; i++) {
    const y = 0.032 - i * 0.024;
    const reach = 0.052 * (0.82 + 0.18 * curl);          // how far across the grip it comes
    const drop = curl * 0.010 * i;                        // lower fingers curl further under
    glove.push(at(box(reach, 0.019, 0.030, 0.008), m * (0.026 - reach / 2), y - drop, 0.028, 0, 0, m * -curl * 0.12));
    // Pad on the inside face of each finger, where it actually contacts the weapon.
    palm.push(at(box(reach * 0.8, 0.013, 0.010, 0.004), m * (0.026 - reach / 2), y - drop, 0.043));
  }

  // Thumb: comes over the top-front, across the grip. The one part that breaks the
  // fist's symmetry, and the reason a hand reads as a hand and not a block.
  glove.push(at(box(0.022, 0.048, 0.026, 0.009), m * 0.020, 0.040, -0.026, 0.5, 0, m * -0.35));

  // Rubberised palm facing the grip, the surface doing the gripping.
  palm.push(at(box(0.014, 0.086, 0.070, 0.010), m * 0.008, 0.002, 0.002));

  // Glove cuff, then the sleeve running back out of frame.
  glove.push(at(box(0.038, 0.026, 0.082, 0.011), m * 0.026, 0.062, -0.002));
  const fa = opts.forearm ?? 0;
  if (fa > 0) {
    const arm = limb(0.033, 0.026, fa);
    // Hangs down from the wrist; +X rotation swings it BACK toward the elbow, which
    // in the weapon's frame is -Z (the muzzle is +Z, so the shooter is behind it).
    at(arm, m * 0.026, 0.070, -0.004, opts.forearmPitch ?? 0.9, m * (opts.forearmYaw ?? 0), 0);
    sleeve.push(arm);
  }

  const group = new THREE.Group();
  for (const [parts, mat] of [[glove, GLOVE], [palm, PALM], [sleeve, SLEEVE]] as const) {
    if (!parts.length) continue;
    const mesh = new THREE.Mesh(merge(parts), mat);
    mesh.castShadow = false;      // a viewmodel is drawn over the world, not lit into it
    mesh.frustumCulled = false;   // it lives in front of the near plane; culling flickers it
    group.add(mesh);
  }
  group.scale.setScalar(s);
  return group;
}

// ── Per-weapon grips ──────────────────────────────────────────────────────────

/**
 * Where a weapon is held, MEASURED off the weapon itself.
 *
 * The obvious approach is a hand-tuned table of anchors per gun, the way GUN_FIX in
 * gunModels handles orientation. It was the first thing tried here and it is the
 * wrong tool: ten weapons from three pipelines (hand-authored GLB, image-to-3D, and
 * procedural) put their receivers at wildly different heights inside an identically
 * normalised bounding box, so ten triples have to be eyeballed, none of them can be
 * checked by anything but a screenshot, and an eleventh weapon starts the job again.
 *
 * So this measures instead. The gun is sliced along its barrel axis and the LOWEST
 * surface in each slice is recorded — that profile is the weapon's underside, which
 * is exactly the line a hand grips along, whatever the model's internal proportions.
 * A hand then sits at a given fraction along the weapon, raised to meet the underside
 * at that point. It costs one pass over the vertices per gun at load, and it is right
 * by construction on a model nobody has looked at yet.
 *
 * Two caveats it handles explicitly:
 *
 *  • The MAGAZINE is the lowest thing on most rifles, and it is not a grip. Slices
 *    are read at fractions chosen to sit behind it (the pistol grip) and well ahead
 *    of it (the handguard), and the depth is clamped so a deep magazine well cannot
 *    drag a hand down with it.
 *  • A PISTOL has no handguard to reach for, so both hands go to the one grip.
 */

/** Underside profile of a weapon: `minY[i]` is the lowest surface in slice i. */
interface Profile {
  minY: Float32Array;
  z0: number;
  dz: number;
  /** The weapon's typical underside — the median of the slices. Grips hang a little
   *  below this; a magazine or a drum hangs a long way below it. */
  body: number;
}

const SLICES = 48;

function underside(gun: THREE.Object3D, len: number): Profile {
  const minY = new Float32Array(SLICES).fill(Infinity);
  const z0 = -len / 2;
  const dz = len / SLICES;
  const v = new THREE.Vector3();

  gun.updateMatrixWorld(true);
  const toGun = new THREE.Matrix4().copy(gun.matrixWorld).invert();

  gun.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const pos = mesh.geometry.getAttribute('position');
    if (!pos) return;
    const toLocal = new THREE.Matrix4().multiplyMatrices(toGun, mesh.matrixWorld);
    const index = mesh.geometry.getIndex();
    const tris = index ? index.count : pos.count;

    // TRIANGLES, not vertices. A box carries vertices only at its corners, so a
    // 6cm-deep pistol grip lands entirely between two slice boundaries and every
    // slice across its middle comes back EMPTY — and half these weapons are built
    // out of boxes. Worse, those empty slices then skew the median that decides the
    // body line. Taking each triangle's z SPAN and stamping its lowest point across
    // every slice it crosses fills the faces in, which is what a flat underside
    // actually is.
    for (let t = 0; t < tris; t += 3) {
      let zMin = Infinity, zMax = -Infinity, yMin = Infinity;
      for (let k = 0; k < 3; k++) {
        const vi = index ? index.getX(t + k) : t + k;
        v.fromBufferAttribute(pos, vi).applyMatrix4(toLocal);
        if (v.z < zMin) zMin = v.z;
        if (v.z > zMax) zMax = v.z;
        if (v.y < yMin) yMin = v.y;
      }
      const from = Math.max(0, Math.floor((zMin - z0) / dz));
      const to = Math.min(SLICES - 1, Math.floor((zMax - z0) / dz));
      for (let s = from; s <= to; s++) if (yMin < minY[s]) minY[s] = yMin;
    }
  });

  const seen = Array.from(minY).filter(Number.isFinite).sort((a, b) => a - b);
  const body = seen.length ? seen[Math.floor(seen.length / 2)] : 0;
  return { minY, z0, dz, body };
}

/** The lowest surface at a fraction along the weapon (-0.5 = butt, +0.5 = muzzle).
 *  Slices nothing reached at all fall back to the nearest that something did. */
function undersideAt(p: Profile, len: number, frac: number): number {
  const z = frac * len;
  const s = Math.max(0, Math.min(SLICES - 1, Math.floor((z - p.z0) / p.dz)));
  for (let r = 0; r < SLICES; r++) {
    for (const i of [s - r, s + r]) {
      if (i >= 0 && i < SLICES && Number.isFinite(p.minY[i])) return p.minY[i];
    }
  }
  return 0;
}

/** Per-weapon deviations from "one hand back, one hand forward". Only the things
 *  measurement genuinely cannot know. */
interface GripTune {
  /** Fraction along the weapon for each hand. */
  fire: number;
  support: number | null;   // null = a pistol: both hands on the one grip
  scale?: number;
}

const GRIP: Record<GunId, GripTune> = {
  sidearm:         { fire: -0.06, support: null, scale: 0.94 },
  smg:             { fire: -0.10, support: 0.16 },
  assault_rifle:   { fire: -0.09, support: 0.16 },
  marksman:        { fire: -0.10, support: 0.15 },
  legendary:       { fire: -0.09, support: 0.15 },
  ashfall_carbine: { fire: -0.06, support: 0.18 },  // bullpup: grip is well forward
  warden_repeater: { fire: -0.10, support: 0.16 },
  rift_lance:      { fire: -0.11, support: 0.16 },
  seraph_lmg:      { fire: -0.10, support: 0.14, scale: 1.06 },
  ember_halo:      { fire: -0.09, support: 0.15 },
};


/**
 * Furthest a hand may sit below the weapon's own BODY LINE (the median underside).
 *
 * Relative, not absolute. A fixed ceiling sounds safer and is worse: set tight enough
 * to catch a drum magazine, it also caps every ordinary pistol grip, and then the
 * clamp — not the measurement — is deciding where every hand goes, which throws away
 * the whole reason for measuring. Against the body line, a grip hanging a few
 * centimetres under the receiver is normal and passes through untouched, while a mag
 * or a drum hanging 20cm down is the outlier it actually is.
 */
const MAX_BELOW_BODY = 0.07;

/**
 * The pair of hands for one weapon, in that weapon's own frame.
 *
 * Parent this to the GUN, not to the viewmodel group: the gun is what moves when you
 * aim down sights, when the weapon kicks, and when it is swapped or lowered against
 * a wall — hands attached to the gun inherit every one of those for free and can
 * never drift off the grip. Hands attached to the viewmodel would have to
 * re-implement all of it, and would be wrong the first time anyone retuned ADS.
 */
export function buildViewmodelHands(gunId: GunId, gun: THREE.Object3D, len: number): THREE.Group {
  const tune = GRIP[gunId] ?? GRIP.assault_rifle;
  const profile = underside(gun, len);
  const group = new THREE.Group();
  group.name = 'hands';

  /** Where a hand sits: along the weapon by fraction, up against its underside. */
  const anchor = (frac: number, sideways: number): [number, number, number] => {
    // HALFWAY between the weapon's body line and its lowest point here — which is
    // where a hand actually closes. Anchoring to the lowest point instead hangs the
    // hand off the very bottom of the grip, and a pistol grip is around 10cm deep,
    // so that is a hand dangling under the weapon rather than holding it.
    const mid = (profile.body + undersideAt(profile, len, frac)) / 2;
    return [sideways, Math.max(profile.body - MAX_BELOW_BODY, mid), frac * len];
  };

  // FIRING hand: right, on the pistol grip, forearm running back toward the shoulder.
  // The firing forearm is a CUFF STUB, not an arm. Anatomically the elbow tucks at
  // the ribs — but the ribs are behind the camera, so an arm drawn to true length
  // reaches within 20cm of the eye and becomes a tube over a quarter of the screen.
  // Worse, DOWN THE SIGHTS the weapon is raised and pulled toward centre, and that
  // tube lands square in the middle of the sight picture: measured against the same
  // frame with hands off, it was covering aim. The support arm can afford real
  // length because it hangs from a hand further down the barrel and leaves through
  // the bottom edge; this one cannot, so it stops at the wrist.
  const fire = buildHand({ scale: tune.scale ?? 1, curl: 1, forearm: 0.055, forearmPitch: 0.5 });
  fire.position.set(...anchor(tune.fire, 0.006));
  fire.rotation.set(-0.16, 0, 0.10);   // wrist rake up the grip
  group.add(fire);

  if (tune.support !== null) {
    // SUPPORT hand: left, out on the handguard, thumb-forward, opened out because a
    // handguard is fatter than a grip. Its forearm drops away far less steeply — that
    // arm comes UP to the weapon from below, which is what stops it reading as a
    // second firing hand stuck on backwards.
    const support = buildHand({
      left: true, scale: tune.scale ?? 1, curl: 0.72, forearm: 0.13,
      forearmPitch: 0.32, forearmYaw: 0.24,
    });
    support.position.set(...anchor(tune.support, -0.010));
    support.rotation.set(0.24, 0, -0.16);
    group.add(support);
  } else {
    // A pistol is held in BOTH hands, stacked: the support hand wraps the firing
    // hand's fingers rather than reaching for a handguard that does not exist.
    const cup = buildHand({
      left: true, scale: (tune.scale ?? 1) * 0.96, curl: 0.5, forearm: 0.10,
      forearmPitch: 0.5, forearmYaw: 0.3,
    });
    const [x, y, z] = anchor(tune.fire, -0.034);
    cup.position.set(x, y - 0.006, z - 0.012);
    cup.rotation.set(0.1, 0, -0.2);
    group.add(cup);
  }

  return group;
}
