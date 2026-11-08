'use client';

import { useMemo, useRef, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CrowdDirector } from './CrowdDirector';

interface Spectator {
  base: THREE.Vector3;
  yaw: number;
  phase: number;
  jump: number;   // responsiveness to surges
  bob: number;    // idle bob speed
  height: number; // per-person scale for a natural crowd
}

// Concentric tiers of seated spectators rising away from the pit. The y values
// match the arena terrace tops so they sit on the stone steps.
const TIERS = [
  { radius: 22.5, y: 1.0, count: 64 },
  { radius: 25.5, y: 2.4, count: 76 },
  { radius: 29, y: 3.8, count: 88 },
];

const CLOTHING = ['#2a2730', '#33222a', '#222a33', '#3a3024', '#2c2238', '#243a2c', '#3a2424', '#1e2a3a'];
const SKIN = ['#d8a878', '#b97f54', '#8d5a3c', '#e3b98f', '#7a4b32', '#c98e63'];

// A seated spectator: butt on the step, legs folded out in front (toward the
// pit), torso upright, arms resting forward. Origin at the seat; +Z is forward.
function buildBodyGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const hips = new THREE.BoxGeometry(0.3, 0.18, 0.22);
  hips.translate(0, 0.06, 0);
  parts.push(hips);

  // thighs angle up-forward to the knees
  const thighL = new THREE.CylinderGeometry(0.07, 0.07, 0.32, 5);
  thighL.rotateX(1.2);
  thighL.translate(-0.09, 0.12, 0.16);
  const thighR = thighL.clone(); thighR.translate(0.18, 0, 0);
  parts.push(thighL, thighR);

  // shins drop forward-down to the feet
  const shinL = new THREE.CylinderGeometry(0.06, 0.065, 0.34, 5);
  shinL.rotateX(2.3);
  shinL.translate(-0.09, 0.06, 0.42);
  const shinR = shinL.clone(); shinR.translate(0.18, 0, 0);
  parts.push(shinL, shinR);

  // upright torso
  const torso = new THREE.CylinderGeometry(0.16, 0.2, 0.5, 6);
  torso.translate(0, 0.36, 0);
  parts.push(torso);

  // arms resting forward over the knees
  const armL = new THREE.CylinderGeometry(0.05, 0.055, 0.42, 5);
  armL.rotateX(1.1);
  armL.translate(-0.2, 0.3, 0.18);
  const armR = armL.clone(); armR.translate(0.4, 0, 0);
  parts.push(armL, armR);

  return mergeGeometries(parts, false) ?? parts[0];
}

function buildHeadGeometry(): THREE.BufferGeometry {
  const neck = new THREE.CylinderGeometry(0.05, 0.055, 0.08, 5);
  neck.translate(0, 0.6, 0);
  const head = new THREE.SphereGeometry(0.12, 8, 6);
  head.translate(0, 0.72, 0);
  return mergeGeometries([neck, head], false) ?? head;
}

export function Crowd({ director }: { director: CrowdDirector }) {
  const bodyRef = useRef<THREE.InstancedMesh>(null);
  const headRef = useRef<THREE.InstancedMesh>(null);
  const bodyGeo = useMemo(() => buildBodyGeometry(), []);
  const headGeo = useMemo(() => buildHeadGeometry(), []);

  const people = useMemo<Spectator[]>(() => {
    const list: Spectator[] = [];
    for (const tier of TIERS) {
      for (let i = 0; i < tier.count; i++) {
        const a = (i / tier.count) * Math.PI * 2 + (Math.random() - 0.5) * 0.05;
        const r = tier.radius + (Math.random() - 0.5) * 0.8;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        list.push({
          base: new THREE.Vector3(x, tier.y + Math.random() * 0.04, z),
          yaw: Math.atan2(-x, -z), // face the pit centre
          phase: Math.random() * Math.PI * 2,
          jump: 0.6 + Math.random() * 0.8,
          bob: 1.5 + Math.random() * 1.5,
          height: 0.9 + Math.random() * 0.25,
        });
      }
    }
    return list;
  }, []);

  const count = people.length;

  // Per-instance clothing + skin colours.
  useEffect(() => {
    const body = bodyRef.current;
    const head = headRef.current;
    if (!body || !head) return;
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      c.set(CLOTHING[Math.floor(Math.random() * CLOTHING.length)]);
      body.setColorAt(i, c);
      c.set(SKIN[Math.floor(Math.random() * SKIN.length)]);
      head.setColorAt(i, c);
    }
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    if (head.instanceColor) head.instanceColor.needsUpdate = true;
  }, [count]);

  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame((state) => {
    const body = bodyRef.current;
    const head = headRef.current;
    if (!body || !head) return;
    const t = state.clock.elapsedTime;
    const energy = director.energy;
    const surge = director.surge;

    for (let i = 0; i < count; i++) {
      const p = people[i];
      const idle = Math.sin(t * p.bob + p.phase) * 0.03;
      const hype = energy * Math.sin(t * (3 + energy * 5) + p.phase) * 0.12;
      const hop = surge * p.jump * Math.max(0, Math.sin(t * 9 + p.phase)) * 0.4;
      const y = p.base.y + idle + hype + hop;

      dummy.position.set(p.base.x, y, p.base.z);
      dummy.rotation.set(0, p.yaw, 0);
      const squash = 1 + hop * 0.12;
      dummy.scale.set(p.height, p.height * squash, p.height);
      dummy.updateMatrix();
      body.setMatrixAt(i, dummy.matrix);
      head.setMatrixAt(i, dummy.matrix);
    }
    body.instanceMatrix.needsUpdate = true;
    head.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      <instancedMesh ref={bodyRef} args={[bodyGeo, undefined, count]} frustumCulled={false}>
        <meshStandardMaterial roughness={0.9} metalness={0.05} />
      </instancedMesh>
      <instancedMesh ref={headRef} args={[headGeo, undefined, count]} frustumCulled={false}>
        <meshStandardMaterial roughness={0.8} metalness={0} />
      </instancedMesh>
    </group>
  );
}
