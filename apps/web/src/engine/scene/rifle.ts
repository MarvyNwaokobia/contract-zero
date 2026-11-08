import { useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';

/**
 * The one rifle, shared by the first-person viewmodel and every enemy's hands.
 *
 * The source model (`AssaultRifle2`) is authored tiny and lying along X, so we
 * normalise it once into the engine's weapon convention:
 *
 *   +Z = firing direction · origin at the middle of the weapon · `muzzle` anchor
 *   at the barrel tip (muzzle flash + tracers spawn there)
 *
 * Deriving the barrel from the longest bounding-box axis means a replacement
 * model drops in without hand-tuned rotations.
 */

export const RIFLE_URL = '/models/guns/rifle.glb';

/** Real assault-rifle length, metres. */
const TARGET_LEN = 0.88;
/** The model faces the wrong way down its long axis; flip it end-for-end. */
const FLIP = true;

function buildPrototype(src: THREE.Object3D): THREE.Group {
  const inner = src.clone(true);
  inner.rotation.set(0, 0, 0);
  inner.position.set(0, 0, 0);
  inner.scale.set(1, 1, 1);

  // 1. longest axis of the raw model = the barrel. Rotate it onto +Z.
  const box = new THREE.Box3().setFromObject(inner);
  const size = box.getSize(new THREE.Vector3());
  if (size.x >= size.y && size.x >= size.z) inner.rotation.y = -Math.PI / 2; // +X -> +Z
  else if (size.y >= size.x && size.y >= size.z) inner.rotation.x = Math.PI / 2; // +Y -> +Z
  if (FLIP) inner.rotateY(Math.PI);
  inner.updateMatrixWorld(true);

  // 2. scale to a real rifle, then centre the weapon on its own origin.
  const box2 = new THREE.Box3().setFromObject(inner);
  const len = box2.getSize(new THREE.Vector3()).z;
  if (len > 1e-5) inner.scale.setScalar(TARGET_LEN / len);
  inner.updateMatrixWorld(true);

  const box3 = new THREE.Box3().setFromObject(inner);
  const centre = box3.getCenter(new THREE.Vector3());
  inner.position.sub(centre);
  inner.updateMatrixWorld(true);

  inner.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.castShadow = true; m.frustumCulled = false; }
  });

  const group = new THREE.Group();
  group.add(inner);

  // 3. muzzle anchor at the barrel tip.
  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.set(0, 0, TARGET_LEN / 2);
  group.add(muzzle);
  group.name = 'rifle';
  return group;
}

/** Normalised prototype, built once per loaded GLB. Clone it, never mutate it. */
export function useRiflePrototype(): THREE.Group {
  const { scene } = useGLTF(RIFLE_URL);
  return useMemo(() => buildPrototype(scene), [scene]);
}

/** A fresh, independently-transformable rifle (with its `muzzle` child). */
export function cloneRifle(prototype: THREE.Group): THREE.Group {
  return prototype.clone(true);
}

useGLTF.preload(RIFLE_URL);
