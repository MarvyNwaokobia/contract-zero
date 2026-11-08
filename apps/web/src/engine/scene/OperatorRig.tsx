'use client';

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import * as THREE from 'three';
import { FPS_TUNING } from '../fps';
import { useRiflePrototype, cloneRifle } from './rifle';

/** Melee props baked into the placeholder body. A shooter carries none of these. */
const STRIP = /sword|shield/i;
/**
 * Mixamo grip bone. NOTE: three's GLTFLoader SANITISES node names, so the file's
 * `mixamorig:RightHand` is `mixamorig_RightHand` once loaded. Match by suffix,
 * never by exact name — and `$` keeps us off RightHandIndex1 etc.
 */
const GRIP_BONE = /righthand$/i;
/** Grip offset in hand-bone space. Tuned against the aim-idle pose. */
const GUN_POS = new THREE.Vector3(0, 0, 0.18);

/**
 * A rifle-carrying enemy body (the plan slice 7b).
 *
 * The skeleton and clips come from `operator.glb` (Mixamo X Bot's rifle set
 * grafted onto a skinned body by scripts/build_operator_glb.py). The BODY mesh
 * is a placeholder: swapping it is one asset change, because clip names and the
 * skeleton stay put.
 *
 * Each instance clones the skeleton AND its materials, so one enemy's hit-flash
 * can't tint the whole squad. The rig is auto-scaled to TARGET_H and grounded,
 * which keeps the visible body aligned with FpsSim's maths hitboxes (head at
 * 1.62m, torso to 1.46m) rather than relying on whatever units the source used.
 */

export type ClipName = 'idle' | 'walk' | 'run' | 'strafeL' | 'strafeR' | 'fire' | 'reload' | 'hit' | 'death';

/** Matches FPS_TUNING's hitbox height so what you see is what you shoot. */
// (height comes from the head bone; see below)
const FADE = 0.18;
/** A corpse's lowest bone rests this far above the floor (bones sit inside flesh). */
const FLOOR_CLEARANCE = 0.06;

export interface OperatorApi {
  /** Crossfade to a looping clip. */
  setClip(name: ClipName): void;
  /** Fire a one-shot clip over the top (returns to the looping clip after). */
  playOnce(name: ClipName, timeScale?: number): void;
  /** Emissive tint: the aim telegraph (amber) and the hit flash (red). */
  setTint(hex: number, intensity: number): void;
  /** Diagnostics: where did the rifle actually end up? */
  debug(): Record<string, unknown>;
}

export const OperatorRig = forwardRef<OperatorApi, { modelPath: string }>(function OperatorRig({ modelPath }, ref) {
  const { scene, animations } = useGLTF(modelPath);
  const rifleProto = useRiflePrototype();
  const groupRef = useRef<THREE.Group>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const actions = useRef<Partial<Record<ClipName, THREE.AnimationAction>>>({});
  const current = useRef<ClipName | null>(null);
  const oneShot = useRef<THREE.AnimationAction | null>(null);
  const mats = useRef<THREE.MeshStandardMaterial[]>([]);
  const gunRef = useRef<THREE.Object3D | null>(null);
  const gripRef = useRef<THREE.Object3D | null>(null);
  const aligned = useRef(false);
  const dead = useRef(false);
  const groundBones = useRef<THREE.Object3D[]>([]);

  // Clone skeleton + materials per instance, normalise scale, sit it on the floor.
  const rig = useMemo(() => {
    const clone = SkeletonUtils.clone(scene) as THREE.Group;

    // The placeholder body ships melee props (Paladin sword + shield). Bin them:
    // a shooter carries a rifle, and it goes in the grip hand below.
    for (const o of [...clone.children, ...clone.getObjectsByProperty('isMesh', true)]) {
      if (STRIP.test(o.name)) o.visible = false;
    }

    clone.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || STRIP.test(mesh.name)) return;
      mesh.castShadow = true;

      // Frustum culling STAYS ON, with padded bounds.
      //
      // This used to be `frustumCulled = false`, on the reasoning that a skinned
      // mesh's bounds come from the bind pose and understate an animating body. That
      // is true, but switching culling off is the wrong remedy: it means every rig in
      // the mission is submitted every frame even when it is behind the player, and
      // each operator is 46,301 triangles across two primitives. Measured on the
      // touch/minimal tier, nine rigs accounted for 417k of the frame's 440k triangles
      // — 95% of all geometry, on the quality tier that is supposed to be the escape
      // hatch for a struggling phone. No quality setting touched it, which is exactly
      // why LOW felt like it did nothing.
      //
      // The correct remedy for lying bind-pose bounds is to PAD them. The bind sphere
      // already encloses the whole body; 2.5x gives a wide margin for any pose the rig
      // reaches (arms out, ragdoll fall) while still rejecting anyone off-screen, so
      // nothing you could actually see can pop.
      //
      // Guarded by a flag because SkeletonUtils.clone SHARES geometry between clones:
      // without it, 36 endless rigs would each inflate the same sphere and the radius
      // would compound into infinity, culling nothing.
      // The sphere MUST be set on the mesh, not the geometry. three.js r184's
      // Frustum.intersectsObject takes the object's own bounding sphere whenever the
      // property exists, and SkinnedMesh declares one (initialised null):
      //
      //   if ( object.boundingSphere !== undefined ) {
      //     if ( object.boundingSphere === null ) object.computeBoundingSphere();
      //
      // so padding geometry.boundingSphere is simply never read for a skinned mesh.
      // Leaving it null instead makes three call SkinnedMesh.computeBoundingSphere(),
      // which walks EVERY vertex through applyBoneTransform — 31,687 of them per rig —
      // and then caches the result, so the sphere is also a one-shot snapshot of
      // whatever pose the rig happened to be in. That is the original "skinned bounds
      // lie" complaint, just relocated: a later pose can reach outside it and the body
      // vanishes at the screen edge.
      //
      // Setting it explicitly fixes all three: no per-vertex walk, no pose snapshot,
      // and the padding actually applies. Radius comes from the geometry's bind-pose
      // sphere (cheap, no skinning) with generous headroom for any reachable pose.
      mesh.frustumCulled = true;
      const skinned = mesh as unknown as THREE.SkinnedMesh;
      if (skinned.isSkinnedMesh) {
        const geo = mesh.geometry as THREE.BufferGeometry;
        if (!geo.boundingSphere) geo.computeBoundingSphere();
        if (geo.boundingSphere) {
          skinned.boundingSphere = geo.boundingSphere.clone();
          skinned.boundingSphere.radius *= 2.5;
        }
      }
      const src = mesh.material as THREE.Material | THREE.Material[];
      const cloneMat = (m: THREE.Material) => {
        const c = m.clone() as THREE.MeshStandardMaterial;
        if (c.emissive) { c.emissive.setHex(0x000000); c.emissiveIntensity = 0; }
        // Without the amber tell, enemies must read on silhouette + light alone.
        if (c.color) c.color.multiplyScalar(1.7);
        c.roughness = Math.min(1, (c.roughness ?? 0.8) + 0.1);
        mats.current.push(c);
        return c;
      };
      mesh.material = Array.isArray(src) ? src.map(cloneMat) : cloneMat(src);
    });

    // Do NOT measure a skinned mesh with Box3: its bounds come from the bind pose
    // and lie badly (which is why the cull sphere above is padded rather than
    // trusted as-is). Scale from the HEAD BONE,
    // which also lands the model's head exactly on the sim's head hitbox.
    clone.updateMatrixWorld(true);
    let head: THREE.Object3D | null = null;
    clone.traverse((o) => {
      if (!head && (o as THREE.Bone).isBone && /head$/i.test(o.name)) head = o;
    });
    if (head) {
      const headY = new THREE.Vector3().setFromMatrixPosition((head as THREE.Object3D).matrixWorld).y;
      if (headY > 0.05) clone.scale.setScalar(FPS_TUNING.HEAD_Y / headY);
    }
    clone.updateMatrixWorld(true);

    // A real rifle in the grip hand. The rig inherits the bone's world scale, so
    // undo it or the gun comes out the size of the room.
    let gripFound: THREE.Object3D | null = null;
    clone.traverse((o) => {
      if (!gripFound && (o as THREE.Bone).isBone && GRIP_BONE.test(o.name)) gripFound = o;
    });
    const grip = gripFound as THREE.Object3D | null; // TS can't see closure writes
    if (grip) {
      const gun = cloneRifle(rifleProto);
      // Undo the bone's world scale so the rifle is life-sized. Orientation is
      // aligned on the first ANIMATED frame (see below) — the bind pose is not
      // the pose the character actually stands in.
      const ws = new THREE.Vector3();
      grip.getWorldScale(ws);
      gun.scale.setScalar(ws.x > 1e-6 ? 1 / ws.x : 1);
      gun.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.castShadow = true; });
      grip.add(gun);
      gunRef.current = gun;
      gripRef.current = grip;
      aligned.current = false;
    }
    // Bones we ground a corpse against: whichever ends up lowest holds the floor.
    groundBones.current = [];
    clone.traverse((o) => {
      if ((o as THREE.Bone).isBone && /(hips|leftfoot|rightfoot|head|leftforearm|rightforearm)$/i.test(o.name)) {
        groundBones.current.push(o);
      }
    });

    clone.updateMatrixWorld(true);
    return clone;
  }, [scene, rifleProto]);

  useEffect(() => {
    const mixer = new THREE.AnimationMixer(rig);
    mixerRef.current = mixer;
    for (const clip of animations) {
      const name = clip.name as ClipName;
      const action = mixer.clipAction(clip);
      actions.current[name] = action;
    }
    const idle = actions.current.idle;
    if (idle) { idle.play(); current.current = 'idle'; }
    return () => { mixer.stopAllAction(); mixerRef.current = null; };
  }, [rig, animations]);

  useImperativeHandle(ref, (): OperatorApi => ({
    setClip(name) {
      if (current.current === name) return;
      const next = actions.current[name];
      if (!next) return;
      const prev = current.current ? actions.current[current.current] : null;
      if (name === 'death') {
        next.reset();
        next.setLoop(THREE.LoopOnce, 1);
        next.clampWhenFinished = true;
        // a flinch blending under a corpse makes it twitch
        if (oneShot.current) { oneShot.current.stop(); oneShot.current = null; }
        dead.current = true;
      } else {
        dead.current = false;
        rig.position.y = 0;
        next.reset().setLoop(THREE.LoopRepeat, Infinity);
      }
      next.enabled = true;
      next.fadeIn(FADE).play();
      if (prev && prev !== next) prev.fadeOut(FADE);
      current.current = name;
    },
    playOnce(name, timeScale = 1) {
      const a = actions.current[name];
      if (!a) return;
      a.reset();
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = false;
      a.setEffectiveWeight(1);
      a.timeScale = timeScale;
      a.play();
      oneShot.current = a;
    },
    setTint(hex, intensity) {
      for (const m of mats.current) {
        if (!m.emissive) continue;
        m.emissive.setHex(hex);
        m.emissiveIntensity = intensity;
      }
    },
    debug() {
      const gun = gunRef.current, grip = gripRef.current;
      if (!gun || !grip) return { attached: false, gun: !!gun, grip: !!grip };
      const gp = gun.getWorldPosition(new THREE.Vector3());
      const hp = grip.getWorldPosition(new THREE.Vector3());
      const gs = gun.getWorldScale(new THREE.Vector3());
      const box = new THREE.Box3().setFromObject(gun);
      const size = box.getSize(new THREE.Vector3());
      return {
        attached: true, aligned: aligned.current, visible: gun.visible,
        gunWorld: [+gp.x.toFixed(2), +gp.y.toFixed(2), +gp.z.toFixed(2)],
        handWorld: [+hp.x.toFixed(2), +hp.y.toFixed(2), +hp.z.toFixed(2)],
        distHandToGun: +gp.distanceTo(hp).toFixed(3),
        gunWorldScale: +gs.x.toFixed(4),
        gunSizeMetres: [+size.x.toFixed(2), +size.y.toFixed(2), +size.z.toFixed(2)],
        localScale: +gun.scale.x.toFixed(4),
        meshCount: gun.getObjectsByProperty('isMesh', true).length,
        dead: dead.current,
        clip: current.current,
        rigY: +rig.position.y.toFixed(3),
        headY: (() => {
          const h = groundBones.current.find((b) => /head$/i.test(b.name));
          return h ? +h.getWorldPosition(new THREE.Vector3()).y.toFixed(3) : null;
        })(),
        lowestBoneY: (() => {
          let m = Infinity;
          for (const b of groundBones.current) m = Math.min(m, b.getWorldPosition(new THREE.Vector3()).y);
          return Number.isFinite(m) ? +m.toFixed(3) : null;
        })(),
      };
    },
  }), [rig]);

  const tmpQ = useMemo(() => new THREE.Quaternion(), []);
  const tmpQ2 = useMemo(() => new THREE.Quaternion(), []);
  const tmpV = useMemo(() => new THREE.Vector3(), []);

  useFrame((_, dt) => {
    // Skip everything for a rig nobody can see. three.js won't DRAW a hidden object,
    // but this frame callback runs regardless, so an off-duty rig would still pay for
    // a full skeleton update every frame. That matters most in endless, which keeps a
    // standing pool of rigs and parks the unused ones, but it also covers despawned
    // survival slots and any corpse culled from view.
    let node: THREE.Object3D | null = groupRef.current;
    while (node) {
      if (!node.visible) return;
      node = node.parent;
    }

    mixerRef.current?.update(Math.min(dt, 1 / 20));

    // Align the rifle ONCE, after the idle clip has actually posed the skeleton.
    // We want the barrel (+Z) to point down the character's forward axis, so:
    //   gun.local = inverse(grip.world) * character.world
    // and the muzzle-ward offset must be expressed in the grip's local space,
    // which is exactly that same rotation applied to (0,0,z).
    const gun = gunRef.current, grip = gripRef.current;
    if (!aligned.current && gun && grip) {
      grip.getWorldQuaternion(tmpQ);   // hand, as animated
      rig.getWorldQuaternion(tmpQ2);   // character root
      gun.quaternion.copy(tmpQ.invert().multiply(tmpQ2));
      // The grip bone's world scale is ~0.01 (Mixamo centimetres), so a child's
      // local units are NOT metres. Convert the metre offset into bone units --
      // gun.scale.x already holds 1/boneWorldScale.
      gun.position.copy(GUN_POS).applyQuaternion(gun.quaternion).multiplyScalar(gun.scale.x);
      aligned.current = true;
    }

    // A death clip drops the hips toward the floor but nothing re-grounds the rig,
    // so the body sinks. Lift it until the lowest bone rests on the ground.
    if (dead.current && groundBones.current.length) {
      rig.updateMatrixWorld(true);
      let minY = Infinity;
      for (const bone of groundBones.current) {
        const y = bone.getWorldPosition(tmpV).y;
        if (y < minY) minY = y;
      }
      if (Number.isFinite(minY)) {
        if (minY < FLOOR_CLEARANCE) {
          // sinking: lift it out of the floor immediately
          rig.position.y += FLOOR_CLEARANCE - minY;
        } else {
          // NEVER press a body down just because its feet came off the ground
          // mid-fall -- that is what made corpses sink. Relax the lift instead.
          rig.position.y += (0 - rig.position.y) * Math.min(1, dt * 4);
        }
      }
    }

    const os = oneShot.current;
    if (os && !os.isRunning()) oneShot.current = null;
  });

  return <group ref={groupRef}><primitive object={rig} /></group>;
});

useGLTF.preload('/characters/glb/operator.glb');
