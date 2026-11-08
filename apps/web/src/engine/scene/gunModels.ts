import { useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import type { GunId } from '../combat/GunStats';
import { buildProceduralGun, type ProceduralGunId } from './proceduralGuns';

/**
 * The five real weapon models, one per gun tier, for the first-person viewmodel.
 * Same models the marketplace bakes (see dev/bake-items), so the gun you buy is
 * the gun you hold. The AR + Legendary are hand-authored GLBs; the Sidearm, SMG
 * and Marksman were generated (image -> SAM 3D). Enemies keep the shared rifle
 * (OperatorRig) — this is only the player's own weapon.
 *
 * Each model is normalised into the engine's weapon convention (barrel = +Z, up =
 * +Y, origin centred, a `muzzle` anchor at the barrel tip) so the scene can hang
 * any of them off the camera identically and swap on a weapon switch.
 */

/**
 * The SEASONAL weapons have no GLB — they are assembled from primitives at runtime
 * (scene/proceduralGuns.ts). Keeping them out of the GLB map means the loader never
 * tries to fetch a file that doesn't exist, and a new weapon costs a function
 * instead of a modelling pipeline.
 */
const PROCEDURAL_LEN: Record<ProceduralGunId, number> = {
  ashfall_carbine: 0.72,  // bullpup — short for its power
  warden_repeater: 1.06,  // long battle rifle
  rift_lance:      1.16,  // longest in the set
  seraph_lmg:      1.02,  // heavy, bulky rather than long
  ember_halo:      0.9,
};

const PROCEDURAL_IDS = Object.keys(PROCEDURAL_LEN) as ProceduralGunId[];

export const GUN_MODEL_URL: Record<Exclude<GunId, ProceduralGunId>, string> = {
  sidearm: '/models/guns/sidearm.glb',
  smg: '/models/guns/smg.glb',
  assault_rifle: '/models/guns/rifle.glb',
  marksman: '/models/guns/marksman.glb',
  legendary: '/models/guns/blaster.glb',
};

/** Real-ish weapon length (metres) each model is scaled to — sets relative size. */
const GUN_LEN: Record<Exclude<GunId, ProceduralGunId>, string | number> = {
  sidearm: 0.26,
  smg: 0.52,
  assault_rifle: 0.88,
  marksman: 1.12,
  legendary: 0.82,
};

/**
 * Per-model orientation fix applied AFTER the generic "longest axis → +Z" step.
 * Generated meshes don't all face the same way; flipY swings the barrel end-for-
 * end, and extra yaw/roll square up ones that lifted at an angle. Tuned by eye
 * against the viewmodel.
 */
const GUN_FIX: Record<Exclude<GunId, ProceduralGunId>, { flipY: boolean; yaw?: number; pitch?: number; roll?: number }> = {
  sidearm:       { flipY: true },
  smg:           { flipY: true },
  assault_rifle: { flipY: true },  // matches the old rifle.ts FLIP
  marksman:      { flipY: true },
  legendary:     { flipY: true },
};

function buildPrototype(src: THREE.Object3D, gunId: GunId): THREE.Group {
  const inner = src.clone(true);
  inner.rotation.set(0, 0, 0);
  inner.position.set(0, 0, 0);
  inner.scale.set(1, 1, 1);

  // 1. longest axis of the raw model = the barrel. Rotate it onto +Z.
  const size = new THREE.Box3().setFromObject(inner).getSize(new THREE.Vector3());
  if (size.x >= size.y && size.x >= size.z) inner.rotation.y = -Math.PI / 2;      // +X -> +Z
  else if (size.y >= size.x && size.y >= size.z) inner.rotation.x = Math.PI / 2;  // +Y -> +Z
  const fix = GUN_FIX[gunId];
  if (fix.flipY) inner.rotateY(Math.PI);
  if (fix.yaw) inner.rotateY(fix.yaw);
  if (fix.pitch) inner.rotateX(fix.pitch);
  if (fix.roll) inner.rotateZ(fix.roll);
  inner.updateMatrixWorld(true);

  // 2. scale to a real length, then centre on the origin.
  const len = new THREE.Box3().setFromObject(inner).getSize(new THREE.Vector3()).z;
  if (len > 1e-5) inner.scale.setScalar(GUN_LEN[gunId] / len);
  inner.updateMatrixWorld(true);
  const centre = new THREE.Box3().setFromObject(inner).getCenter(new THREE.Vector3());
  inner.position.sub(centre);
  inner.updateMatrixWorld(true);

  inner.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.castShadow = true; m.frustumCulled = false; }
  });

  const group = new THREE.Group();
  group.add(inner);
  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.set(0, 0, GUN_LEN[gunId] / 2);
  group.add(muzzle);
  group.name = `gun-${gunId}`;
  return group;
}

/** Only the GLB-backed guns; the procedural ones are built, not fetched.
 *  This is a LOADING list — it says what to fetch, not what a player can hold.
 *  Anything iterating weapons to build or show them wants ALL_GUN_IDS. */
export const GUN_IDS = Object.keys(GUN_MODEL_URL) as Exclude<GunId, ProceduralGunId>[];

/**
 * Every gun a player can actually equip — GLB-backed and procedural alike, and
 * exactly the keys `useGunPrototypes` returns.
 *
 * Split out because the scene built its viewmodels from GUN_IDS, which silently
 * meant "the five with model files". Equipping a seasonal weapon then looked up
 * a mesh that was never created, and the very next line called
 * .getObjectByName on it — so buying a seasonal gun and deploying crashed the
 * whole route with "undefined is not an object". The prototypes were always
 * there; only the loop that cloned them was short.
 */
export const ALL_GUN_IDS: GunId[] = [...GUN_IDS, ...PROCEDURAL_IDS];

/**
 * The real-world length every prototype is normalised to, for both families at once.
 *
 * Exported because a prototype's frame is only meaningful WITH its length: the model
 * is centred on the origin, so "how far along the weapon" is a fraction of this and
 * nothing else. The viewmodel hands measure their grips that way.
 */
export const GUN_LENGTH: Record<GunId, number> = {
  ...(Object.fromEntries(
    (Object.keys(GUN_LEN) as Exclude<GunId, ProceduralGunId>[]).map((id) => [id, Number(GUN_LEN[id])]),
  ) as Record<Exclude<GunId, ProceduralGunId>, number>),
  ...PROCEDURAL_LEN,
};

/** Load + normalise every gun model. Returns one prototype per tier; clone before
 *  mutating. Suspends while the GLBs load, so mount under a <Suspense>. */
export function useGunPrototypes(): Record<GunId, THREE.Group> {
  const gltfs = useGLTF(GUN_IDS.map((id) => GUN_MODEL_URL[id]));
  return useMemo(() => {
    const out = {} as Record<GunId, THREE.Group>;
    GUN_IDS.forEach((id, i) => { out[id] = buildPrototype(gltfs[i].scene, id); });
    // Seasonal weapons are assembled here rather than loaded, so they cost no
    // network fetch and are ready on the same frame as the rest.
    for (const id of PROCEDURAL_IDS) out[id] = buildProceduralGun(id, PROCEDURAL_LEN[id]);
    return out;
  }, [gltfs]);
}

GUN_IDS.forEach((id) => useGLTF.preload(GUN_MODEL_URL[id]));
