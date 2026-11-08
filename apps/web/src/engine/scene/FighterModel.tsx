'use client';

import { memo, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { AnimationStateMachine } from '../animation';
import type { CharacterState } from '../character';
import { loadMixamoAnimations, getMixamoClips, isMixamoLoadComplete } from '../animation';
import { makeBlobShadowTexture } from '../world/textures';
import { makeGunMesh } from './GunMesh';
import { STARTER_GUN_ID, type GunId } from '../combat';

interface FighterModelProps {
  classId: 'berserker' | 'sentinel' | 'phantom';
  state: CharacterState;
  animMachine: AnimationStateMachine;
  accent?: string;
  gunId?: GunId;
}

const MODEL_PATHS: Record<string, string> = {
  berserker: '/characters/glb/berserker.glb',
  sentinel: '/characters/glb/sentinel.glb',
  phantom: '/characters/glb/phantom.glb',
};

const CLASS_ACCENTS: Record<string, string> = {
  berserker: '#ef4444',
  sentinel: '#3b82f6',
  phantom: '#8b5cf6',
};

// Seconds for the impact squash to spring fully back to rest.
const IMPACT_DECAY = 0.13;

// Procedural recoil: max chest pitch (radians) at a full-strength kick, and how
// fast the kick springs back. Driven by state.recoilPulse (set per shot from the
// gun's feel profile), applied to the spine AFTER the mixer like HIPS_PITCH_FIX —
// pure bone-quaternion math, so it's Safari-safe where baked clips are not.
const RECOIL_MAX_PITCH = 0.16;
const RECOIL_DECAY = 0.11;
const _recoilEuler = new THREE.Euler();
const _recoilQuat = new THREE.Quaternion();

// The gun is driven from the right-hand bone each frame rather than PARENTED into
// the skeleton — parenting a child into the rig corrupted the animation bind and
// left the fighter in its T-pose. GUN_GRIP is the gun's offset relative to the hand.
const GUN_GRIP = new THREE.Matrix4().compose(
  new THREE.Vector3(0, 0.02, 0.04),
  new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)),
  new THREE.Vector3(1, 1, 1),
);
const _gunScratch = new THREE.Matrix4();

// The Blender-exported GLB rigs carry a ~90° pitch offset on the root (Hips) bone vs
// the Mixamo clips — the classic Z-up→Y-up export rotation — which lays the fighters
// out FLAT/horizontal. The clips otherwise drive the rig correctly, so we cancel the
// offset with a constant -90° X rotation premultiplied onto the Hips each frame after
// the mixer runs. It's pure bone-quaternion math (the same thing the mixer does), so
// it works in Safari — unlike rest-pose retargeting / baked clips, which load but
// fail to drive the rig in real iOS/macOS WebKit.
const HIPS_PITCH_FIX = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
// Inverse of the correction, used to UNDO last frame's fix before the mixer runs so
// the premultiply is idempotent — see the cumulative-spin note in the frame loop.
const HIPS_PITCH_FIX_INV = HIPS_PITCH_FIX.clone().invert();

export const FighterModel = memo(function FighterModel({
  classId,
  state,
  animMachine,
  accent,
  gunId = STARTER_GUN_ID,
}: FighterModelProps) {
  const groupRef = useRef<THREE.Group>(null);
  const modelRef = useRef<THREE.Group>(null);
  const shadowRef = useRef<THREE.Group>(null);
  const gunRef = useRef<THREE.Group | null>(null);
  const handBoneRef = useRef<THREE.Object3D | null>(null);
  const hipsBoneRef = useRef<THREE.Object3D | null>(null);
  const spineBoneRef = useRef<THREE.Object3D | null>(null);
  // Recoil applied to the spine last frame — undone before the next mixer pass
  // (same idempotency dance as the Hips pitch fix below).
  const recoilUndoQuat = useRef(new THREE.Quaternion());
  const recoilApplied = useRef(false);
  // Whether last frame already premultiplied HIPS_PITCH_FIX onto the Hips, so we can
  // undo it before the next mixer pass and keep the correction from compounding.
  const hipsFixApplied = useRef(false);
  const lean = useRef({ x: 0, z: 0 });
  const lastPos = useRef<THREE.Vector3 | null>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const initDone = useRef(false);
  const mixamoApplied = useRef(false);
  // Keep the fighter hidden until a real animation is driving the rig, so the
  // bind-pose T-pose (and the casual GLB idle) never show. Revealed once the
  // combat-idle clip is ready, or after a short fallback if it's slow.
  const revealed = useRef(false);
  const initTime = useRef(0);
  const modelPath = MODEL_PATHS[classId];
  const { scene, animations } = useGLTF(modelPath);
  // The fighter's ACTUAL equipped weapon — each tier is its own model, so the
  // gun you bought is the gun in your hands (and the one the enemy shows you).
  const gunProto = useMemo(() => makeGunMesh(gunId), [gunId]);
  const blobTex = useMemo(() => makeBlobShadowTexture(), []);

  const clonedScene = useMemo(() => {
    const clone = SkeletonUtils.clone(scene);
    clone.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    return clone;
  }, [scene]);

  // Start loading Mixamo animations immediately
  useMemo(() => { loadMixamoAnimations(); }, []);

  const accentColor = accent ?? CLASS_ACCENTS[classId] ?? '#ffffff';

  useFrame((_, dt) => {
    if (!groupRef.current) return;

    // First init: create mixer with GLB clips
    if (!initDone.current && groupRef.current.children.length > 0) {
      initDone.current = true;
      const mixer = new THREE.AnimationMixer(groupRef.current);
      mixerRef.current = mixer;
      animMachine.init(mixer, animations);

      const boneNames: string[] = [];
      let hipsBone: THREE.Object3D | null = null;
      groupRef.current.traverse((child) => {
        if ((child as THREE.Bone).isBone) {
          boneNames.push(child.name);
          if (!hipsBone && /hips/i.test(child.name)) { hipsBone = child; hipsBoneRef.current = child; }
          // The hand root ends in "RightHand"; finger bones (…RightHandThumb1) don't.
          // Stashed for the gun, attached AFTER the Mixamo bind (see below).
          if (!handBoneRef.current && /righthand$/i.test(child.name)) handBoneRef.current = child;
          // Chest bone for the recoil kick — prefer Spine2, fall back down the chain.
          if (/spine2$/i.test(child.name)) spineBoneRef.current = child;
          else if (!spineBoneRef.current && /spine1?$/i.test(child.name)) spineBoneRef.current = child;
        }
      });
      if (!handBoneRef.current) console.warn(`[Fighter:${classId}] no RightHand bone — gun won't socket`);
      // Feed the rig's bind-pose hip height to the locomotion matcher so cadence
      // scales with leg length (kills foot-skate on taller/shorter fighters).
      if (hipsBone) {
        groupRef.current.updateWorldMatrix(true, true);
        const hipY = (hipsBone as THREE.Object3D).getWorldPosition(new THREE.Vector3()).y;
        animMachine.setRigScale(hipY);
        console.log(`[Fighter:${classId}] hip height ${hipY.toFixed(2)}m → rig-scaled locomotion`);
      }
      console.log(`[Fighter:${classId}] Init with ${animations.length} GLB clips, bones: ${boneNames.slice(0, 5).join(', ')}...`);
    }

    // Wait for the FULL Mixamo set before binding — not just the first clip to
    // arrive. Latching early left walk/run unloaded, so the rig fell back to the
    // GLB idle clip and slid the idle pose across the floor (punch-list A1).
    if (initDone.current && !mixamoApplied.current && mixerRef.current && isMixamoLoadComplete()) {
      const mixamoClips = getMixamoClips();
      if (mixamoClips.size > 0) {
        mixamoApplied.current = true;
        const combined = [...animations];
        for (const [name, clip] of mixamoClips) {
          if (!combined.find(c => c.name === name)) {
            combined.push(clip);
          }
        }
        animMachine.init(mixerRef.current, combined);
        console.log(`[Fighter:${classId}] ${combined.length} clips ready (${mixamoClips.size} Mixamo + ${animations.length} GLB)`);

        // Build the gun as a SIBLING (child of the outer group), never parented
        // into the skeleton. Its matrix is driven from the hand bone each frame.
        if (!gunRef.current) {
          const gun = gunProto.clone(true);
          gun.matrixAutoUpdate = false; // we set gun.matrix directly in the frame loop
          groupRef.current.add(gun);
          gunRef.current = gun;
        }
      }
    }

    // Reveal once the combat-idle is actually playing — never show a T-pose.
    // Prefer the Mixamo fight stance, but fall back after ~2.5s so a slow/failed
    // animation load can't leave the fighter invisible.
    if (!revealed.current && initDone.current) {
      if (initTime.current === 0) initTime.current = performance.now();
      if (mixamoApplied.current || performance.now() - initTime.current > 2500) {
        revealed.current = true;
        groupRef.current.visible = true;
        if (shadowRef.current) shadowRef.current.visible = true;
      }
    }

    // Update position
    groupRef.current.position.copy(state.position);
    groupRef.current.position.y = Math.max(0, groupRef.current.position.y);

    const targetQuat = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      state.rotation
    );
    const rotLerp = 1 - Math.exp(-12 * dt);
    groupRef.current.quaternion.slerp(targetQuat, rotLerp);

    // Match the walk/run cycle to actual ground speed so feet don't skate.
    const planarSpeed = Math.sqrt(state.velocity.x ** 2 + state.velocity.z ** 2);
    animMachine.matchLocomotionSpeed(planarSpeed);

    // Directional locomotion: project velocity on the facing (forward = (sinθ, cosθ),
    // right = (-cosθ, sinθ)) so the machine can swap walk/strafe/backpedal clips.
    // The fighter faces the enemy (lock-on), so sideways travel = a real strafe.
    if (planarSpeed > 0.3) {
      const fSin = Math.sin(state.rotation), fCos = Math.cos(state.rotation);
      const fwdAmt = state.velocity.x * fSin + state.velocity.z * fCos;
      const rightAmt = -state.velocity.x * fCos + state.velocity.z * fSin;
      animMachine.setMoveDirection(fwdAmt, rightAmt);
    }

    // Procedural lean — tilt into movement and recoil on impact, for weight.
    // Velocity is read from actual position delta so it also captures the
    // attack lunge (which moves position directly, not via state.velocity).
    let vx = 0, vz = 0;
    if (lastPos.current && dt > 0.0001) {
      vx = THREE.MathUtils.clamp((state.position.x - lastPos.current.x) / dt, -10, 10);
      vz = THREE.MathUtils.clamp((state.position.z - lastPos.current.z) / dt, -10, 10);
    }
    (lastPos.current ??= new THREE.Vector3()).copy(state.position);
    const sin = Math.sin(state.rotation), cos = Math.cos(state.rotation);
    const fwd = vx * sin + vz * cos;
    const side = vx * cos - vz * sin;
    const targetX = -fwd * 0.045 + state.impactPulse * 0.35;
    const targetZ = side * 0.045;
    const lk = 1 - Math.exp(-10 * dt);
    lean.current.x += (targetX - lean.current.x) * lk;
    lean.current.z += (targetZ - lean.current.z) * lk;
    if (modelRef.current) modelRef.current.rotation.set(lean.current.x, 0, lean.current.z);

    // Grounding contact shadow — flat on the floor, follows the fighter.
    if (shadowRef.current) {
      shadowRef.current.position.set(state.position.x, 0.02, state.position.z);
      const s = Math.max(0.45, 1 - Math.max(0, state.position.y) * 0.18);
      shadowRef.current.scale.set(s, s, s);
    }

    // Impact scale-punch — squash on contact, springs back as the pulse decays.
    // The decay is FROZEN while the mixer is paused for hit-stop, so the squash
    // holds through the freeze (the animation-side held impact frame) and only
    // springs back once motion resumes — instead of being used up mid-freeze.
    if (state.impactPulse > 0) {
      const p = state.impactPulse;
      groupRef.current.scale.set(1 + 0.18 * p, 1 - 0.22 * p, 1 + 0.18 * p);
      if (!animMachine.isPaused) {
        state.impactPulse = Math.max(0, p - dt / IMPACT_DECAY);
        if (state.impactPulse === 0) groupRef.current.scale.set(1, 1, 1);
      }
    }

    // UNDO last frame's pitch correction before the mixer runs, so re-applying it
    // below is idempotent. This matters because a FINISHED one-shot clip (Death,
    // Victory) STOPS re-writing the Hips every frame — three.js holds the clamped
    // pose without re-evaluating the track. An unconditional premultiply would then
    // compound -90°/frame and spin the body, flicking it between upright and flat:
    // the "switching horizontally and vertically" glitch seen after a KO. (Looping
    // clips never finish, so live play was unaffected — which is why it only showed
    // once the fight ended.)
    if (hipsBoneRef.current && hipsFixApplied.current) {
      hipsBoneRef.current.quaternion.premultiply(HIPS_PITCH_FIX_INV);
    }
    // Undo last frame's recoil kick for the same reason (a finished one-shot clip
    // stops rewriting bones, so an unconditional premultiply would compound).
    if (spineBoneRef.current && recoilApplied.current) {
      spineBoneRef.current.quaternion.premultiply(recoilUndoQuat.current);
      recoilApplied.current = false;
    }

    animMachine.update(dt);

    // Stand the fighter upright: cancel the rig's baked-in ~90° root pitch (see
    // HIPS_PITCH_FIX). Applied onto whatever the mixer left — a fresh clip pose while
    // playing, or the held final pose once a one-shot clip has finished.
    if (hipsBoneRef.current) {
      hipsBoneRef.current.quaternion.premultiply(HIPS_PITCH_FIX);
      hipsFixApplied.current = true;
    }

    // Recoil kick — pitch the chest back proportional to the shot's kick, then
    // spring to rest. Frozen during hit-stop, like the impact squash.
    if (spineBoneRef.current && state.recoilPulse > 0) {
      const kick = state.recoilPulse * RECOIL_MAX_PITCH;
      _recoilQuat.setFromEuler(_recoilEuler.set(-kick, 0, 0));
      spineBoneRef.current.quaternion.premultiply(_recoilQuat);
      recoilUndoQuat.current.copy(_recoilQuat).invert();
      recoilApplied.current = true;
      if (!animMachine.isPaused) {
        state.recoilPulse = Math.max(0, state.recoilPulse - dt / RECOIL_DECAY);
      }
    }

    // Drive the gun from the hand bone (it's a sibling, not parented into the rig).
    // gun.matrix = groupRef⁻¹ · handBoneWorld · grip → renders exactly at the hand.
    if (gunRef.current && handBoneRef.current) {
      handBoneRef.current.updateWorldMatrix(true, false); // refresh hand + ancestors (incl. groupRef)
      _gunScratch.copy(groupRef.current.matrixWorld).invert();
      gunRef.current.matrix.multiplyMatrices(_gunScratch, handBoneRef.current.matrixWorld).multiply(GUN_GRIP);
    }
  });

  return (
    <>
      <group ref={shadowRef} visible={false}>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[1.7, 1.7]} />
          <meshBasicMaterial map={blobTex} transparent depthWrite={false} opacity={0.85} />
        </mesh>
      </group>
      <group ref={groupRef} visible={false}>
        <group ref={modelRef}>
          <primitive object={clonedScene} />
        </group>
        <pointLight color={accentColor} intensity={4.0} distance={7} position={[0, 1.5, 0]} />
        <pointLight color={'#fff4e8'} intensity={2.0} distance={8} position={[0, 3.5, 0.6]} />
      </group>
    </>
  );
});
