'use client';

/**
 * The look of a structured level (fps/levels). Every collider is drawn as the thing
 * it is (a container, a truck, a jersey barrier, a warehouse wall, a server rack),
 * sized exactly to its box so what you see is what blocks you. Visual-only `art`
 * adds roofs, towers, light poles, catwalks and beacons. Repeated pieces are
 * instanced; lights come from the level (few, physical units), the rest is emissive.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Art, Box, LevelDef } from '../fps/levels';
import { usePbr } from './usePbr';

const HANGAR = '/textures/hangar';

type Inst = { x: number; y: number; z: number; sx: number; sy: number; sz: number; ry?: number; color?: string };

/** Instanced unit boxes (optionally per-instance tinted). */
function Instanced({ items, material, cast = true, geometry }: { items: Inst[]; material: THREE.Material; cast?: boolean; geometry?: THREE.BufferGeometry }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    const mat = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const c = new THREE.Color();
    items.forEach((it, i) => {
      q.setFromAxisAngle(up, it.ry ?? 0);
      mat.compose(new THREE.Vector3(it.x, it.y, it.z), q, new THREE.Vector3(it.sx, it.sy, it.sz));
      m.setMatrixAt(i, mat);
      if (it.color) m.setColorAt(i, c.set(it.color));
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    // Cull by where the instances ARE: the default bounds are the unit box at the
    // origin, which hid every container in the level whenever the origin was off-screen.
    m.computeBoundingBox();
    m.computeBoundingSphere();
  }, [items]);
  if (!items.length) return null;
  return (
    <instancedMesh ref={ref} args={[geometry ?? UNIT, material, items.length]} castShadow={cast} receiveShadow />
  );
}

const UNIT = new THREE.BoxGeometry(1, 1, 1);
/** Small or flat pieces whose shadows nobody reads: skipping them keeps the shadow pass cheap. */
const NO_SHADOW = ['glass', 'panel', 'lampHead', 'redLed', 'screen', 'road', 'yellow', 'steel', 'frame', 'case', 'stripe', 'skirting', 'wood'];
const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 20);
const WHEEL = new THREE.CylinderGeometry(0.5, 0.5, 1, 14).rotateZ(Math.PI / 2);

/** Chain-link texture, drawn once. */
function chainLink(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.strokeStyle = 'rgba(170,170,165,0.95)';
  g.lineWidth = 2.2;
  g.beginPath(); g.moveTo(0, 32); g.lineTo(32, 0); g.lineTo(64, 32); g.lineTo(32, 64); g.closePath(); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Server-rack front: rows of status LEDs. */
function ledTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#05070a'; g.fillRect(0, 0, 64, 128);
  for (let y = 6; y < 128; y += 8) {
    g.fillStyle = '#11161c'; g.fillRect(4, y - 3, 56, 6);
    for (let x = 8; x < 60; x += 6) {
      const r = Math.sin(x * 12.9 + y * 78.2) * 43758.5;
      const f = r - Math.floor(r);
      g.fillStyle = f > 0.8 ? '#ff5040' : f > 0.45 ? '#3ad07a' : '#1a2a20';
      g.fillRect(x, y - 1, 2, 2);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A distant ring of ridges so the level sits in a landscape, not a void. */
function Mountains({ color, radius = 150 }: { color: string; radius?: number }) {
  const geo = useMemo(() => {
    const seg = 160;
    const pos: number[] = [];
    const h = (a: number) => 14 + 10 * Math.sin(a * 3.1) + 6 * Math.sin(a * 7.3 + 1.2) + 3 * Math.sin(a * 17.1) + 2 * Math.sin(a * 31.7);
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const p = (a: number, y: number) => [Math.cos(a) * radius, y, Math.sin(a) * radius];
      pos.push(...p(a0, -2), ...p(a1, -2), ...p(a0, h(a0)), ...p(a1, -2), ...p(a1, h(a1)), ...p(a0, h(a0)));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  }, [radius]);
  return (
    <mesh geometry={geo}>
      <meshBasicMaterial color={color} side={THREE.DoubleSide} fog={false} />
    </mesh>
  );
}

/** Additive light cone (floodlights, the searchlight). */
function Beam({ from, to, radius, color }: { from: [number, number, number]; to: [number, number, number]; radius: number; color: string }) {
  const { pos, quat, len } = useMemo(() => {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
    const dir = b.clone().sub(a);
    const len = dir.length();
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.normalize());
    return { pos: a.clone().add(b).multiplyScalar(0.5), quat, len };
  }, [from, to]);
  const mat = useMemo(() => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color(color) } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
    fragmentShader: 'uniform vec3 uColor; varying vec2 vUv; void main(){ float e = sin(vUv.x*3.14159); gl_FragColor = vec4(uColor,1.)*e*e*(0.25+0.75*vUv.y)*0.09; }',
  }), [color]);
  return (
    <mesh position={pos} quaternion={quat} material={mat}>
      <cylinderGeometry args={[0.25, radius, len, 24, 1, true]} />
    </mesh>
  );
}

function Blinker({ x, y, z, color }: { x: number; y: number; z: number; color: string }) {
  const ref = useRef<THREE.MeshBasicMaterial>(null);
  useFrame((s) => { if (ref.current) ref.current.opacity = s.clock.elapsedTime % 1.6 < 0.8 ? 1 : 0.15; });
  return (
    <mesh position={[x, y, z]}>
      <sphereGeometry args={[0.12, 10, 8]} />
      <meshBasicMaterial ref={ref} color={color} transparent />
    </mesh>
  );
}

export function LevelArt({ level, minimal = false, lit = true }: { level: LevelDef; minimal?: boolean; lit?: boolean }) {
  const night = level.id === 'blacksite';
  const corrugated = usePbr('corrugated_iron_02', [1, 1], HANGAR);
  const plate = usePbr('metal_plate', [1, 1], HANGAR);
  const concrete = usePbr('concrete_floor_worn_001', [1, 1], HANGAR);
  const plaster = usePbr('damaged_plaster', [1, 1]);
  const planks = usePbr('black_painted_planks', [1, 1]);

  const mats = useMemo(() => {
    const tri = (maps: { map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture }, o: THREE.MeshStandardMaterialParameters) =>
      new THREE.MeshStandardMaterial({ ...maps, ...o });
    const link = chainLink();
    link.repeat.set(1, 1);
    return {
      container: tri(corrugated, { color: '#ffffff', roughness: 0.7, metalness: 0.35 }),
      frame: new THREE.MeshStandardMaterial({ color: '#2a2b2d', roughness: 0.6, metalness: 0.6 }),
      warehouse: tri(corrugated, { color: '#b8b2a6', roughness: 0.75, metalness: 0.3 }),
      stripe: new THREE.MeshStandardMaterial({ color: '#8f2a20', roughness: 0.7 }),
      concrete: tri(concrete, { color: night ? '#7d828a' : '#b0a99c', roughness: 0.92 }),
      facade: tri(concrete, { color: '#8a8f98', roughness: 0.85 }),
      interior: tri(plaster, { color: '#c9ccd0', roughness: 0.95 }),
      skirting: new THREE.MeshStandardMaterial({ color: '#2b2f36', roughness: 0.8 }),
      steel: tri(plate, { color: '#5b6068', roughness: 0.5, metalness: 0.75 }),
      olive: new THREE.MeshStandardMaterial({ color: '#4f5a3c', roughness: 0.75, metalness: 0.2 }),
      tarp: new THREE.MeshStandardMaterial({ color: '#5e5f42', roughness: 0.95 }),
      tire: new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.9 }),
      glass: new THREE.MeshStandardMaterial({ color: '#0b0e12', emissive: night ? '#8fb6ff' : '#ffcf8a', emissiveIntensity: night ? 0.9 : 0.35, roughness: 0.2 }),
      wood: tri(planks, { color: '#9a7a52', roughness: 0.9 }),
      case: new THREE.MeshStandardMaterial({ color: '#3f4733', roughness: 0.6, metalness: 0.3 }),
      tank: tri(plate, { color: '#c8c3b8', roughness: 0.45, metalness: 0.6 }),
      fence: new THREE.MeshStandardMaterial({ map: link, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.5, color: '#9a9a96' }),
      desk: new THREE.MeshStandardMaterial({ color: '#d7d9dc', roughness: 0.5 }),
      screen: new THREE.MeshStandardMaterial({ color: '#000', emissive: '#58c6ff', emissiveIntensity: 1.6 }),
      server: new THREE.MeshStandardMaterial({ map: ledTexture(), emissive: '#ffffff', emissiveMap: ledTexture(), emissiveIntensity: 1.2, roughness: 0.4, metalness: 0.5 }),
      roof: tri(corrugated, { color: '#6d6a64', roughness: 0.8, metalness: 0.3, side: THREE.DoubleSide }),
      road: new THREE.MeshStandardMaterial({ color: '#2f2d2b', roughness: 0.85 }),
      yellow: new THREE.MeshStandardMaterial({ color: '#c99b2a', roughness: 0.8 }),
      lampHead: new THREE.MeshStandardMaterial({ color: '#000', emissive: night ? '#d8e6ff' : '#ffbe73', emissiveIntensity: 4 }),
      panel: new THREE.MeshStandardMaterial({ color: '#000', emissive: '#e8f0ff', emissiveIntensity: 2.2 }),
      redLed: new THREE.MeshBasicMaterial({ color: '#ff3b30' }),
    };
  }, [corrugated, plate, concrete, plaster, planks, night]);

  const parts = useMemo(() => {
    const out: Record<string, Inst[]> = {};
    const add = (k: string, it: Inst) => (out[k] ??= []).push(it);
    const all: Box[] = [...level.walls, ...level.cover];
    for (const b of all) {
      const { x, z, w, d, h } = b;
      const alongZ = d > w;
      const len = alongZ ? d : w, wid = alongZ ? w : d;
      const ry = alongZ ? 0 : Math.PI / 2;
      const fwd = (t: number): [number, number] => (alongZ ? [x, z + t] : [x + t, z]);
      switch (b.kind) {
        case 'container': {
          add('container', { x, y: h / 2, z, sx: w, sy: h, sz: d, color: b.color });
          if (h > 3) add('frame', { x, y: h / 2, z, sx: w + 0.04, sy: 0.08, sz: d + 0.04 }); // stack seam
          add('frame', { x, y: h - 0.05, z, sx: w + 0.06, sy: 0.1, sz: d + 0.06 });
          break;
        }
        case 'truck': {
          const [cx, cz] = fwd(len / 2 - 1.1);
          add('olive', { x: cx, y: 1.45, z: cz, sx: wid, sy: 1.6, sz: 2, ry });            // cab
          add('glass', { x: cx, y: 1.85, z: cz + (alongZ ? 1.01 : 0), sx: alongZ ? wid * 0.9 : 0.04, sy: 0.55, sz: alongZ ? 0.04 : wid * 0.9 }); // windscreen
          const [bx, bz] = fwd(-0.9);
          add('olive', { x: bx, y: 0.9, z: bz, sx: wid, sy: 0.35, sz: len - 2.3, ry });      // bed
          add('tarp', { x: bx, y: 1.95, z: bz, sx: wid * 0.98, sy: 1.75, sz: len - 2.4, ry }); // canvas
          for (const t of [len / 2 - 1.2, -len / 2 + 2.6, -len / 2 + 1.2]) for (const s of [-1, 1]) {
            const [wx, wz] = fwd(t);
            add('tire', { x: wx + (alongZ ? (s * wid) / 2 : 0), y: 0.5, z: wz + (alongZ ? 0 : (s * wid) / 2), sx: 0.4, sy: 1, sz: 1, ry: alongZ ? 0 : Math.PI / 2 });
          }
          break;
        }
        case 'fence':
          add('fenceMesh', { x, y: h / 2, z, sx: Math.max(w, 0.02), sy: h, sz: Math.max(d, 0.02) });
          for (let t = -len / 2; t <= len / 2; t += 3) { const [px, pz] = fwd(t); add('steel', { x: px, y: h / 2, z: pz, sx: 0.09, sy: h, sz: 0.09 }); }
          { const [ax, az] = fwd(0); add('steel', { x: ax, y: h, z: az, sx: alongZ ? 0.05 : len, sy: 0.05, sz: alongZ ? len : 0.05 }); }
          break;
        case 'barrier':
          add('concrete', { x, y: 0.22, z, sx: w, sy: 0.44, sz: d });
          add('concrete', { x, y: h * 0.7, z, sx: alongZ ? w * 0.45 : w, sy: h * 0.6, sz: alongZ ? d : d * 0.45 });
          break;
        case 'tank':
          add('tankCyl', { x, y: h / 2, z, sx: w, sy: h, sz: d });
          add('steel', { x, y: h + 0.05, z, sx: w * 0.7, sy: 0.1, sz: d * 0.7 });
          break;
        case 'booth':
          add('concrete', { x, y: 0.55, z, sx: w, sy: 1.1, sz: d });
          add('glass', { x, y: 1.65, z, sx: w * 0.96, sy: 1.1, sz: d * 0.96 });
          add('concrete', { x, y: h - 0.2, z, sx: w + 0.3, sy: 0.4, sz: d + 0.3 });
          break;
        case 'tower_leg':
          add('steel', { x, y: h / 2, z, sx: w, sy: h, sz: d });
          break;
        case 'crate':
          add('wood', { x, y: h / 2, z, sx: w, sy: h, sz: d });
          break;
        case 'case':
          add('case', { x, y: h / 2, z, sx: w, sy: h, sz: d });
          add('frame', { x, y: h * 0.75, z, sx: w + 0.02, sy: 0.06, sz: d + 0.02 });
          break;
        case 'warehouse':
          add('warehouse', { x, y: h / 2, z, sx: w, sy: h, sz: d });
          add('stripe', { x, y: 3.2, z, sx: w + 0.03, sy: 0.45, sz: d + 0.03 });
          break;
        case 'rack':
          add('steel', { x, y: h / 2, z, sx: w, sy: 0.08, sz: d });
          for (const y of [0.15, 1.2, 2.25, h]) add('steel', { x, y, z, sx: w, sy: 0.06, sz: d });
          for (const t of [-len / 2, 0, len / 2]) { const [px, pz] = fwd(t); add('steel', { x: px, y: h / 2, z: pz, sx: 0.08, sy: h, sz: 0.08 }); }
          for (const [y, k] of [[0.55, 0], [1.6, 1]] as const) for (let t = -len / 2 + 0.8; t < len / 2 - 0.4; t += 1.4) {
            const [px, pz] = fwd(t + (k ? 0.5 : 0));
            add('case', { x: px, y, z: pz, sx: w * 0.8, sy: 0.7, sz: 0.9 });
          }
          break;
        case 'concrete':
          add('concrete', { x, y: h / 2, z, sx: w, sy: h, sz: d });
          add('steel', { x, y: h + 0.15, z, sx: alongZ ? 0.06 : w, sy: 0.3, sz: alongZ ? d : 0.06 }); // wire
          break;
        case 'facade':
          add('facade', { x, y: h / 2, z, sx: w, sy: h, sz: d });
          add('glass', { x, y: 4.6, z: z + 0.31, sx: w * 0.86, sy: 0.7, sz: 0.02 });
          add('panel', { x, y: 3.4, z: z + 0.32, sx: w * 0.9, sy: 0.05, sz: 0.02 });
          break;
        case 'interior':
          add('interior', { x, y: h / 2, z, sx: w, sy: h, sz: d });
          add('skirting', { x, y: 0.5, z, sx: w + 0.02, sy: 1, sz: d + 0.02 });
          break;
        case 'desk':
          add('desk', { x, y: h - 0.04, z, sx: w, sy: 0.08, sz: d });
          add('steel', { x, y: (h - 0.08) / 2, z, sx: w * 0.9, sy: h - 0.08, sz: d * 0.2 });
          for (let t = -len / 2 + 0.7; t < len / 2 - 0.3; t += 1.6) { const [px, pz] = fwd(t); add('screen', { x: px, y: h + 0.3, z: pz, sx: alongZ ? 0.04 : 0.6, sy: 0.38, sz: alongZ ? 0.6 : 0.04 }); }
          break;
        case 'server':
          add('server', { x, y: h / 2, z, sx: w, sy: h, sz: d });
          break;
        default:
          add('concrete', { x, y: h / 2, z, sx: w, sy: h, sz: d });
      }
    }
    for (const a of level.art) {
      const { x, z } = a;
      switch (a.kind) {
        case 'road': add('road', { x, y: 0.012, z, sx: a.w ?? 6, sy: 0.02, sz: a.d ?? 40 }); break;
        case 'stripe': add('yellow', { x, y: 0.015, z, sx: a.w ?? 4, sy: 0.02, sz: a.d ?? 0.15 }); break;
        case 'roof': add('roof', { x, y: a.h ?? 7, z, sx: a.w ?? 10, sy: 0.12, sz: a.d ?? 10 }); break;
        case 'tower': {
          const h = a.h ?? 7;
          add('steel', { x, y: h, z, sx: 3.6, sy: 0.2, sz: 3.6 });
          add('concrete', { x, y: h + 0.7, z, sx: 3.2, sy: 1.0, sz: 3.2 });
          add('glass', { x, y: h + 1.55, z, sx: 3.0, sy: 0.7, sz: 3.0 });
          add('steel', { x, y: h + 2.1, z, sx: 3.8, sy: 0.15, sz: 3.8 });
          for (let y = 0.6; y < h; y += 1.6) add('steel', { x, y, z, sx: 3.0, sy: 0.06, sz: 3.0 });
          break;
        }
        case 'light_pole':
          add('steel', { x, y: 3.9, z, sx: 0.16, sy: 7.8, sz: 0.16 });
          add('steel', { x: x + 0.5, y: 7.75, z, sx: 1.2, sy: 0.1, sz: 0.1 });
          add('lampHead', { x: x + 1, y: 7.6, z, sx: 0.6, sy: 0.12, sz: 0.4 });
          break;
        case 'catwalk': {
          const h = a.h ?? 4.5, w = a.w ?? 20, d = a.d ?? 1.2;
          add('steel', { x, y: h, z, sx: w, sy: 0.08, sz: d });
          add('steel', { x, y: h + 1, z: z + d / 2, sx: w, sy: 0.05, sz: 0.05 });
          for (let t = -w / 2; t <= w / 2; t += 3) add('steel', { x: x + t, y: h / 2, z, sx: 0.12, sy: h, sz: 0.12 });
          break;
        }
        case 'lamp': add('panel', { x, y: (a.h ?? 3.3) - 0.03, z, sx: 1.4, sy: 0.05, sz: 0.3 }); break;
        case 'camera':
          add('frame', { x, y: a.h ?? 3, z, sx: 0.18, sy: 0.18, sz: 0.4 });
          add('redLed', { x, y: (a.h ?? 3) + 0.05, z: z + 0.21, sx: 0.04, sy: 0.04, sz: 0.02 });
          break;
        default:
      }
    }
    return out;
  }, [level]);

  const beacons = level.art.filter((a) => a.kind === 'beacon');
  const floods = level.art.filter((a) => a.kind === 'floodlight');
  const radar = level.art.find((a) => a.kind === 'radar');
  const cast = !minimal;

  return (
    <group>
      <Mountains color={night ? '#0b1220' : '#5a3f30'} />
      {Object.entries(parts).map(([k, items]) =>
        k === 'tankCyl' ? <Instanced key={k} items={items} material={mats.tank} geometry={CYL} cast={cast} />
        : k === 'tire' ? <Instanced key={k} items={items} material={mats.tire} geometry={WHEEL} cast={false} />
        : k === 'fenceMesh' ? <Instanced key={k} items={items} material={mats.fence} cast={false} />
        : <Instanced key={k} items={items} material={(mats as Record<string, THREE.Material>)[k] ?? mats.concrete} cast={cast && !NO_SHADOW.includes(k)} />,
      )}
      {beacons.map((b, i) => <Blinker key={i} x={b.x} y={b.h ?? 5} z={b.z} color={b.color ?? '#ff3b30'} />)}
      {floods.map((f, i) => (
        <group key={i}>
          <mesh position={[f.x, f.h ?? 7.4, f.z]}><boxGeometry args={[0.7, 0.5, 0.5]} /><primitive object={mats.lampHead} attach="material" /></mesh>
          {!minimal && <Beam from={[f.x, (f.h ?? 7.4) - 0.2, f.z]} to={[f.x + 9, 0, f.z - 10]} radius={4.5} color="#cfe0ff" />}
        </group>
      ))}
      {radar && (
        <group position={[radar.x, 0, radar.z]}>
          <mesh position={[0, (radar.h ?? 20) / 2, 0]}><boxGeometry args={[2.5, radar.h ?? 20, 2.5]} /><meshStandardMaterial color="#1a1f28" /></mesh>
          <mesh position={[0, (radar.h ?? 20) + 2.4, 0]}><sphereGeometry args={[3.4, 24, 16]} /><meshStandardMaterial color="#cfd6e0" emissive="#3a4a66" emissiveIntensity={0.5} /></mesh>
        </group>
      )}
      {lit && level.lights.slice(0, minimal ? 2 : 4).map((l, i) => (
        <pointLight key={i} position={l.pos} color={l.color} intensity={l.intensity} distance={l.distance} decay={1.6} />
      ))}
    </group>
  );
}

export type { Art };
