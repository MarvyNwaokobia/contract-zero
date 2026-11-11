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
import { idleProps, isDelivering, type WorldCues } from '../fps/lineProps';

const HANGAR = '/textures/hangar';

type Inst = { x: number; y: number; z: number; sx: number; sy: number; sz: number; rx?: number; ry?: number; rz?: number; color?: string };

/** Instanced unit boxes (optionally per-instance tinted). */
function Instanced({ items, material, cast = true, geometry }: { items: Inst[]; material: THREE.Material; cast?: boolean; geometry?: THREE.BufferGeometry }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    const mat = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const c = new THREE.Color();
    items.forEach((it, i) => {
      q.setFromEuler(e.set(it.rx ?? 0, it.ry ?? 0, it.rz ?? 0));
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
const NO_SHADOW = ['glass', 'panel', 'lampHead', 'redLed', 'screen', 'road', 'yellow', 'steel', 'frame', 'case', 'stripe', 'skirting', 'wood', 'signBar'];
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

/** A refinery flare stack: a tall steel stack and a flame that never quite settles. */
function FlareStack({ x, z, h, calm = false, out = false }: { x: number; z: number; h: number; calm?: boolean; /** The line it burns for is down: no flame, no glow. */ out?: boolean }) {
  const flame = useRef<THREE.Mesh>(null);
  const light = useRef<THREE.PointLight>(null);
  useFrame((st) => {
    const t = st.clock.elapsedTime;
    const k = calm ? 1 : 1 + Math.sin(t * 9) * 0.12 + Math.sin(t * 23) * 0.06;
    if (out) { if (flame.current) flame.current.visible = false; if (light.current) light.current.intensity = 0; return; }
    if (flame.current) { flame.current.scale.set(k, 1.2 * k + Math.sin(t * 5) * 0.15, k); flame.current.rotation.y = t * 0.8; }
    if (light.current) light.current.intensity = 34 * k;
  });
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, h / 2, 0]} castShadow><cylinderGeometry args={[0.45, 0.7, h, 14]} /><meshStandardMaterial color="#5a5c5f" roughness={0.5} metalness={0.7} /></mesh>
      {[0.25, 0.5, 0.75].map((f) => <mesh key={f} position={[0, h * f, 0]}><torusGeometry args={[0.62, 0.06, 6, 18]} /><meshStandardMaterial color="#8a2a20" /></mesh>)}
      <mesh ref={flame} position={[0, h + 1.1, 0]}><coneGeometry args={[0.7, 2.6, 12, 1, true]} /><meshBasicMaterial color="#ffb347" transparent opacity={0.85} side={THREE.DoubleSide} depthWrite={false} blending={THREE.AdditiveBlending} /></mesh>
      <pointLight ref={light} position={[0, h + 1.5, 0]} color="#ff8a3a" intensity={34} distance={40} decay={1.6} />
    </group>
  );
}

/** A steam vent: a pipe stub and white plumes that rise and thin out. */
function Steam({ x, z, minimal }: { x: number; z: number; minimal: boolean }) {
  const group = useRef<THREE.Group>(null);
  const tex = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(32, 32, 2, 32, 32, 31);
    grd.addColorStop(0, 'rgba(255,255,255,0.8)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }, []);
  const n = minimal ? 3 : 6;
  useFrame((st) => {
    const t = st.clock.elapsedTime;
    group.current?.children.forEach((c, i) => {
      if (!(c as THREE.Sprite).isSprite) return;
      const k = (t * 0.32 + i / n) % 1;
      c.position.set(Math.sin(i * 2.1 + t * 0.4) * 0.3 * k, 1.2 + k * 4.5, Math.cos(i * 1.3) * 0.3 * k);
      c.scale.setScalar(0.6 + k * 2.4);
      ((c as THREE.Sprite).material as THREE.SpriteMaterial).opacity = 0.45 * (1 - k);
    });
  });
  return (
    <group ref={group} position={[x, 0, z]}>
      <mesh position={[0, 0.6, 0]}><cylinderGeometry args={[0.18, 0.18, 1.2, 10]} /><meshStandardMaterial color="#4c4f53" metalness={0.6} roughness={0.5} /></mesh>
      {Array.from({ length: n }, (_, i) => <sprite key={i}><spriteMaterial map={tex} transparent depthWrite={false} color="#e8ecef" opacity={0.3} /></sprite>)}
    </group>
  );
}

/** Where a production line is down: a hazard board on a post and a slow red lamp, so a ruined line reads as ruined. */
function OfflineMarker({ x, z }: { x: number; z: number }) {
  const lamp = useRef<THREE.MeshBasicMaterial>(null);
  useFrame((st) => { if (lamp.current) lamp.current.opacity = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(st.clock.elapsedTime * 2.2)); });
  return (
    <group position={[x, 0, z]} data-offline-marker>
      <mesh position={[0, 1.2, 0]} castShadow><cylinderGeometry args={[0.06, 0.06, 2.4, 8]} /><meshStandardMaterial color="#3a3d41" metalness={0.6} roughness={0.5} /></mesh>
      <mesh position={[0, 2.0, 0.06]}><boxGeometry args={[1.5, 0.9, 0.08]} /><meshStandardMaterial color="#d9d4c6" roughness={0.8} /></mesh>
      {[-0.55, -0.18, 0.18, 0.55].map((px) => <mesh key={px} position={[px, 2.0, 0.11]} rotation={[0, 0, -0.6]}><boxGeometry args={[0.16, 1.0, 0.03]} /><meshStandardMaterial color="#c4361f" /></mesh>)}
      <mesh position={[0, 2.7, 0]}><sphereGeometry args={[0.16, 10, 8]} /><meshBasicMaterial ref={lamp} color="#ff3b30" transparent opacity={0.9} /></mesh>
    </group>
  );
}

/** A truck that is unloading a delivery that has really arrived: a slow amber beacon on its roof. */
function DeliveryBeacon({ x, z, y }: { x: number; z: number; y: number }) {
  const m = useRef<THREE.MeshBasicMaterial>(null);
  useFrame((st) => { if (m.current) m.current.opacity = 0.25 + 0.75 * Math.max(0, Math.sin(st.clock.elapsedTime * 4.5)); });
  return (
    <group position={[x, y, z]} data-delivery-beacon>
      <mesh><cylinderGeometry args={[0.14, 0.18, 0.18, 10]} /><meshStandardMaterial color="#2b2d30" /></mesh>
      <mesh position={[0, 0.16, 0]}><sphereGeometry args={[0.16, 10, 8]} /><meshBasicMaterial ref={m} color="#ffb020" transparent opacity={0.9} /></mesh>
    </group>
  );
}

export function LevelArt({ level, minimal = false, colourOnly = false, lit = true, night: nightProp, calm = false, cues }: { level: LevelDef; minimal?: boolean; /** Load colour maps only (touch and minimal tiers). */ colourOnly?: boolean; lit?: boolean; night?: boolean; calm?: boolean; /** What the site's economy is doing (lines down, deliveries). */ cues?: WorldCues | null }) {
  // What the economy says is down or arriving: shown, never invented.
  const idle = useMemo(() => idleProps(level, cues), [level, cues]);
  const delivering = isDelivering(cues);
  // Night look (glowing windows, cool lamps) follows the hour, not the map.
  const night = nightProp ?? level.id === 'blacksite';
  const corrugated = usePbr('corrugated_iron_02', [1, 1], HANGAR, colourOnly);
  const plate = usePbr('metal_plate', [1, 1], HANGAR, colourOnly);
  const concrete = usePbr('concrete_floor_worn_001', [1, 1], HANGAR, colourOnly);
  const plaster = usePbr('damaged_plaster', [1, 1], undefined, colourOnly);
  const planks = usePbr('black_painted_planks', [1, 1], undefined, colourOnly);

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
      // Refinery tanks are smooth painted steel, not tread plate.
      tank: level.id === 'cinder_yard'
        ? new THREE.MeshStandardMaterial({ color: '#a9a69c', roughness: 0.55, metalness: 0.35 })
        : tri(plate, { color: '#c8c3b8', roughness: 0.45, metalness: 0.6 }),
      rust: tri(plate, { color: '#7a4a32', roughness: 0.7, metalness: 0.45 }),
      pipe: new THREE.MeshStandardMaterial({ color: '#6b6e72', roughness: 0.45, metalness: 0.7 }),
      hazard: new THREE.MeshStandardMaterial({ color: '#c9a227', roughness: 0.6 }),
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
      // Painted drums take their colour per instance; sign marks are unlit so they read at night.
      drum: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.55, metalness: 0.5 }),
      signBar: new THREE.MeshBasicMaterial({ color: '#ffffff' }),
      mattress: new THREE.MeshStandardMaterial({ color: '#cfd6dc', roughness: 0.9 }),
    };
  }, [corrugated, plate, concrete, plaster, planks, night, level.id]);

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
          // Weld seams, a safety band under the lip, a ladder with its cage, and a roof hatch.
          for (const f of [0.33, 0.66]) add('pipeCyl', { x, y: h * f, z, sx: w + 0.1, sy: 0.1, sz: d + 0.1 });
          add('hazardCyl', { x, y: h - 0.35, z, sx: w + 0.06, sy: 0.22, sz: d + 0.06 });
          add('steel', { x: x + w / 2 + 0.04, y: h / 2, z, sx: 0.06, sy: h, sz: 0.5 });
          for (let y = 2; y < h; y += 1.5) add('steel', { x: x + w / 2 + 0.2, y, z, sx: 0.04, sy: 0.04, sz: 0.62 });
          add('hazard', { x, y: h + 0.14, z, sx: 0.9, sy: 0.1, sz: 0.9 });
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
        case 'column':
          // A fractionation column: a tall vessel ringed with platforms and a ladder cage.
          add('tankCyl', { x, y: h / 2, z, sx: w, sy: h, sz: d });
          for (const y of [h * 0.3, h * 0.6, h * 0.9]) {
            add('steel', { x, y, z, sx: w + 1.4, sy: 0.08, sz: d + 1.4 });
            add('hazard', { x, y: y + 1, z: z + d / 2 + 0.7, sx: w + 1.4, sy: 0.05, sz: 0.05 });
          }
          add('steel', { x: x + w / 2 + 0.35, y: h / 2, z, sx: 0.06, sy: h, sz: 0.5 });
          break;
        case 'pipe_rack':
          // A low pipe rack: a steel frame carrying three lines. Waist-high cover.
          for (let t = -len / 2; t <= len / 2 + 0.01; t += Math.max(1.5, len / 4)) { const [px, pz] = fwd(t); add('steel', { x: px, y: h / 2, z: pz, sx: 0.1, sy: h, sz: 0.1 }); }
          for (const [dy, off] of [[h, -0.25], [h, 0.05], [h * 0.55, 0.3]] as const) {
            const [px, pz] = fwd(0);
            add('pipeCyl', { x: px + (alongZ ? off : 0), y: dy, z: pz + (alongZ ? 0 : off), sx: 0.28, sy: len, sz: 0.28, rx: alongZ ? Math.PI / 2 : 0, rz: alongZ ? 0 : Math.PI / 2 });
          }
          break;
        case 'pump':
          // A pump skid: a base, the motor and the pump casing.
          add('steel', { x, y: 0.15, z, sx: w, sy: 0.3, sz: d });
          add('rust', { x: x - w * 0.2, y: 0.75, z, sx: w * 0.45, sy: 0.9, sz: d * 0.7 });
          add('pipeCyl', { x: x + w * 0.22, y: 0.7, z, sx: d * 0.6, sy: w * 0.4, sz: d * 0.6, rz: Math.PI / 2 });
          break;
        case 'bed':
          // A medical cot: frame, mattress and pillow.
          add('steel', { x, y: 0.28, z, sx: w, sy: 0.1, sz: d });
          for (const sx of [-1, 1]) for (const sz of [-1, 1]) add('steel', { x: x + (sx * (w - 0.1)) / 2, y: 0.14, z: z + (sz * (d - 0.1)) / 2, sx: 0.06, sy: 0.28, sz: 0.06 });
          add('mattress', { x, y: 0.5, z, sx: w * 0.94, sy: 0.3, sz: d * 0.94 });
          { const [px, pz] = fwd(-len / 2 + 0.3); add('mattress', { x: px, y: 0.72, z: pz, sx: alongZ ? wid * 0.7 : 0.4, sy: 0.14, sz: alongZ ? 0.4 : wid * 0.7 }); }
          break;
        case 'cabinet':
          add('desk', { x, y: h / 2, z, sx: w, sy: h, sz: d });
          add('frame', { x, y: h / 2, z: z + d / 2 + 0.005, sx: 0.03, sy: h * 0.96, sz: 0.01 });
          add('redLed', { x, y: h * 0.72, z: z + d / 2 + 0.012, sx: 0.28, sy: 0.07, sz: 0.01 });
          add('redLed', { x, y: h * 0.72, z: z + d / 2 + 0.012, sx: 0.07, sy: 0.28, sz: 0.01 });
          break;
        case 'console':
          add('steel', { x, y: (h - 0.08) / 2, z, sx: w * 0.92, sy: h - 0.08, sz: d * 0.8 });
          add('desk', { x, y: h - 0.04, z, sx: w, sy: 0.08, sz: d });
          for (let t = -len / 2 + 0.7; t < len / 2 - 0.3; t += 1.2) { const [px, pz] = fwd(t); add('screen', { x: px, y: h + 0.34, z: pz, sx: alongZ ? 0.04 : 0.55, sy: 0.34, sz: alongZ ? 0.55 : 0.04 }); }
          break;
        case 'locker':
          add('steel', { x, y: h / 2, z, sx: w, sy: h, sz: d });
          for (let t = -len / 2 + 0.25; t < len / 2; t += 0.5) { const [px, pz] = fwd(t); add('frame', { x: px, y: h / 2, z: pz, sx: alongZ ? w + 0.02 : 0.02, sy: h * 0.94, sz: alongZ ? 0.02 : d + 0.02 }); }
          break;
        case 'drum':
          add('drumCyl', { x, y: h / 2, z, sx: w, sy: h, sz: d, color: (Math.round(x * 7 + z * 3) & 1) ? '#7a2f22' : '#2f4a63' });
          add('frame', { x, y: h * 0.82, z, sx: w + 0.03, sy: 0.05, sz: d + 0.03 });
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
          // Rails and toe boards on both edges, so a walkway you can climb reads as one.
          for (const side of [-1, 1]) {
            add('steel', { x, y: h + 1, z: z + (side * d) / 2, sx: w, sy: 0.05, sz: 0.05 });
            add('steel', { x, y: h + 0.5, z: z + (side * d) / 2, sx: w, sy: 0.04, sz: 0.04 });
            add('hazard', { x, y: h + 0.1, z: z + (side * d) / 2, sx: w, sy: 0.14, sz: 0.04 });
            for (let t = -w / 2; t <= w / 2 + 0.01; t += 2.75) add('steel', { x: x + t, y: h + 0.5, z: z + (side * d) / 2, sx: 0.05, sy: 1, sz: 0.05 });
          }
          for (let t = -w / 2; t <= w / 2; t += 3) add('steel', { x: x + t, y: h / 2, z, sx: 0.12, sy: h, sz: 0.12 });
          break;
        }
        case 'lamp': add('panel', { x, y: (a.h ?? 3.3) - 0.03, z, sx: 1.4, sy: 0.05, sz: 0.3 }); break;
        case 'pipe': {
          // An elevated pipe run with supports every few metres.
          const along = (a.d ?? 0) > (a.w ?? 0);
          const len = along ? a.d ?? 4 : a.w ?? 4, h = a.h ?? 5;
          add('pipeCyl', { x, y: h, z, sx: 0.4, sy: len, sz: 0.4, rx: along ? Math.PI / 2 : 0, rz: along ? 0 : Math.PI / 2 });
          for (let t = -len / 2; t <= len / 2 + 0.01; t += 4) add('steel', { x: along ? x : x + t, y: h / 2, z: along ? z + t : z, sx: 0.12, sy: h, sz: 0.12 });
          break;
        }
        case 'sign': {
          // Faces along z unless rotated a quarter turn. No width: a medical cross. A width: a banner.
          const h = a.h ?? 2.5, side = Math.abs(Math.sin(a.rot ?? 0)) > 0.5;
          const dim = (along: number, thick: number) => (side ? { sx: thick, sz: along } : { sx: along, sz: thick });
          if (a.w) {
            add('frame', { x, y: h, z, sy: 0.7, ...dim(a.w, 0.06) });
            add('signBar', { x, y: h, z, sy: 0.4, color: a.color, ...dim(a.w * 0.96, 0.08) });
          } else {
            add('frame', { x, y: h, z, sy: 0.95, ...dim(0.95, 0.05) });
            add('signBar', { x, y: h, z, sy: 0.18, color: a.color, ...dim(0.62, 0.07) });
            add('signBar', { x, y: h, z, sy: 0.62, color: a.color, ...dim(0.18, 0.07) });
          }
          break;
        }
        case 'valve':
          // A hand wheel on a stem, on the pipework.
          add('pipeCyl', { x, y: a.h ?? 3.4, z, sx: 0.55, sy: 0.05, sz: 0.55 });
          add('steel', { x, y: (a.h ?? 3.4) - 0.2, z, sx: 0.06, sy: 0.4, sz: 0.06 });
          break;
        case 'camera':
          add('frame', { x, y: a.h ?? 3, z, sx: 0.18, sy: 0.18, sz: 0.4 });
          add('redLed', { x, y: (a.h ?? 3) + 0.05, z: z + 0.21, sx: 0.04, sy: 0.04, sz: 0.02 });
          break;
        default:
      }
    }
    // Stairs: a stringer slab, a tread every 0.45 m, and a rail up each side.
    for (const st of level.stairs ?? []) {
      const alongX = st.rise.endsWith('x'), len = alongX ? st.w : st.d, wid = alongX ? st.d : st.w;
      const dir = st.rise.startsWith('+') ? 1 : -1;
      const ang = Math.atan2(st.h, len), slope = Math.hypot(len, st.h);
      // The point a distance t from the foot, along the climb, at the stair's surface.
      const foot = alongX ? st.x - dir * len / 2 : st.z - dir * len / 2;
      const at = (t: number, lat = 0): [number, number, number] => alongX ? [foot + dir * t, (t / len) * st.h, st.z + lat] : [st.x + lat, (t / len) * st.h, foot + dir * t];
      const [mx, my, mz] = at(len / 2);
      // Euler signs: about Z a positive angle raises +x; about X it raises -z. So +x and -z take +angle, -x and +z take -angle.
      const tilt = (alongX ? dir : -dir) * ang;
      add('steel', alongX ? { x: mx, y: my - 0.06, z: mz, sx: slope, sy: 0.12, sz: wid, rz: tilt } : { x: mx, y: my - 0.06, z: mz, sx: wid, sy: 0.12, sz: slope, rx: tilt });
      for (let t = 0.3; t < len; t += 0.45) {
        const [tx, ty, tz] = at(t);
        add('hazard', alongX ? { x: tx, y: ty + 0.02, z: tz, sx: 0.28, sy: 0.04, sz: wid * 0.94 } : { x: tx, y: ty + 0.02, z: tz, sx: wid * 0.94, sy: 0.04, sz: 0.28 });
      }
      for (const side of [-1, 1]) {
        const [rx, ry, rz] = at(len / 2, (side * wid) / 2);
        add('steel', alongX ? { x: rx, y: ry + 1, z: rz, sx: slope, sy: 0.05, sz: 0.05, rz: tilt } : { x: rx, y: ry + 1, z: rz, sx: 0.05, sy: 0.05, sz: slope, rx: tilt });
        for (let t = 0; t <= len + 0.01; t += 2) { const [px, py, pz] = at(Math.min(t, len), (side * wid) / 2); add('steel', { x: px, y: py + 0.5, z: pz, sx: 0.05, sy: 1, sz: 0.05 }); }
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
      <Mountains color={night ? '#0b1220' : level.id === 'cinder_yard' ? '#4a3426' : '#5a3f30'} />
      {Object.entries(parts).map(([k, items]) =>
        k === 'tankCyl' ? <Instanced key={k} items={items} material={mats.tank} geometry={CYL} cast={cast} />
        : k === 'pipeCyl' ? <Instanced key={k} items={items} material={mats.pipe} geometry={CYL} cast={cast} />
        : k === 'drumCyl' ? <Instanced key={k} items={items} material={mats.drum} geometry={CYL} cast={cast} />
        : k === 'hazardCyl' ? <Instanced key={k} items={items} material={mats.hazard} geometry={CYL} cast={false} />
        : k === 'tire' ? <Instanced key={k} items={items} material={mats.tire} geometry={WHEEL} cast={false} />
        : k === 'fenceMesh' ? <Instanced key={k} items={items} material={mats.fence} cast={false} />
        : <Instanced key={k} items={items} material={(mats as Record<string, THREE.Material>)[k] ?? mats.concrete} cast={cast && !NO_SHADOW.includes(k)} />,
      )}
      {beacons.map((b, i) => <Blinker key={i} x={b.x} y={b.h ?? 5} z={b.z} color={b.color ?? '#ff3b30'} />)}
      {level.art.filter((a) => a.kind === 'stack').map((a, i) => <FlareStack key={`stack${i}`} x={a.x} z={a.z} h={a.h ?? 20} calm={calm} out={idle.art.has(a)} />)}
      {level.art.filter((a) => a.kind === 'steam' && !idle.art.has(a)).map((a, i) => <Steam key={`steam${i}`} x={a.x} z={a.z} minimal={minimal} />)}
      {idle.lines.map((l) => <OfflineMarker key={`${l.resource}-${l.line}`} x={l.anchor[0]} z={l.anchor[1]} />)}
      {delivering && [...level.walls, ...level.cover].filter((b) => b.kind === 'truck' && !idle.boxes.has(b)).map((b, i) => <DeliveryBeacon key={`dlv${i}`} x={b.x} z={b.z} y={(b.h ?? 2.6) + 0.1} />)}
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
