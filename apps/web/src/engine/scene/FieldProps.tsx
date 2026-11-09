'use client';

/**
 * The physical objects of an operation, drawn from the field runtime (fps/field):
 * supply crates and medical cases, cargo cases, the seized case, sabotage charges and
 * the blast, and the extraction zone with its ground markings, smoke, flares and the
 * vehicle waiting there. Original procedural geometry, no external assets.
 *
 * Everything reads the runtime each frame (visibility, where dropped cargo lies, which
 * crates are empty, the countdown), so the scene never re-renders React for it.
 */

import { useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { FieldRuntime, Interactable } from '../fps/field';

const RES_COLOR: Record<string, string> = { AMMUNITION: '#5b6640', 'MEDICAL SUPPLIES': '#d9dcd6', FUEL: '#9b3328' };

function Box({ s, p, c, e, ei = 0.6, r }: { s: [number, number, number]; p: [number, number, number]; c: string; e?: string; ei?: number; r?: [number, number, number] }) {
  return (
    <mesh position={p} rotation={r} castShadow receiveShadow>
      <boxGeometry args={s} />
      <meshStandardMaterial color={c} roughness={0.7} metalness={0.15} emissive={e ?? '#000000'} emissiveIntensity={e ? ei : 0} />
    </mesh>
  );
}

/** An ammunition crate: olive box, a band coded by round, a lid that opens when empty. */
function AmmoCrate({ item }: { item: Interactable }) {
  const band = item.ammoClass === 'pistol' ? '#3d7fc4' : '#d6b13a';
  return (
    <group>
      <Box s={[0.72, 0.36, 0.46]} p={[0, 0.18, 0]} c="#4b553a" />
      <Box s={[0.74, 0.06, 0.48]} p={[0, 0.18, 0]} c={band} e={band} ei={0.25} />
      <group name="lid" position={[0, 0.37, -0.23]}>
        <Box s={[0.74, 0.05, 0.48]} p={[0, 0, 0.23]} c="#56613f" />
      </group>
      <group name="fill">
        {[-0.18, 0, 0.18].map((x) => <Box key={x} s={[0.14, 0.1, 0.36]} p={[x, 0.33, 0]} c="#b8933a" />)}
      </group>
    </group>
  );
}

function MedCase() {
  return (
    <group>
      <Box s={[0.56, 0.3, 0.36]} p={[0, 0.15, 0]} c="#e4e6e1" />
      <Box s={[0.26, 0.012, 0.07]} p={[0, 0.306, 0]} c="#c8262b" e="#c8262b" ei={0.5} />
      <Box s={[0.07, 0.012, 0.26]} p={[0, 0.306, 0]} c="#c8262b" e="#c8262b" ei={0.5} />
      <group name="lid" position={[0, 0.3, -0.18]}><Box s={[0.001, 0.001, 0.001]} p={[0, 0, 0]} c="#000" /></group>
      <group name="fill" />
    </group>
  );
}

/** A cargo case coded by resource; the seized one carries a bright strap and a blinker. */
function CargoCase({ item, label }: { item: Interactable; label: string }) {
  const c = RES_COLOR[label] ?? '#5b6640';
  const seized = item.kind === 'seized_case';
  return (
    <group>
      <Box s={[0.92, 0.44, 0.52]} p={[0, 0.22, 0]} c={c} />
      <Box s={[0.94, 0.04, 0.54]} p={[0, 0.44, 0]} c="#2a2d30" />
      <Box s={[0.08, 0.46, 0.54]} p={[-0.3, 0.22, 0]} c="#2a2d30" />
      <Box s={[0.08, 0.46, 0.54]} p={[0.3, 0.22, 0]} c="#2a2d30" />
      <Box s={[0.24, 0.05, 0.05]} p={[0, 0.49, 0]} c="#1c1e20" />
      {seized && <Box s={[0.95, 0.06, 0.55]} p={[0, 0.3, 0]} c="#ff8a2a" e="#ff8a2a" ei={0.9} />}
      {seized && <mesh name="blink" position={[0, 0.56, 0]}><sphereGeometry args={[0.05, 8, 8]} /><meshBasicMaterial color="#ff5a2a" /></mesh>}
    </group>
  );
}

function Pouch() {
  return <Box s={[0.26, 0.1, 0.16]} p={[0, 0.05, 0]} c="#2e3229" />;
}

/** The charge site: a plate marking the target, and the charge itself once set. */
function Charge() {
  return (
    <group>
      <mesh name="mark" position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.55, 0.7, 24]} />
        <meshBasicMaterial color="#ff6a3a" transparent opacity={0.7} />
      </mesh>
      <group name="set" visible={false}>
        <Box s={[0.32, 0.2, 0.16]} p={[0, 0.95, 0]} c="#b3a27a" />
        <Box s={[0.34, 0.03, 0.18]} p={[0, 0.95, 0]} c="#202020" />
        <mesh name="led" position={[0.1, 1.07, 0.08]}><sphereGeometry args={[0.025, 6, 6]} /><meshBasicMaterial color="#ff2020" /></mesh>
      </group>
      <group name="boom" visible={false}>
        <mesh name="ball"><sphereGeometry args={[1, 16, 12]} /><meshBasicMaterial color="#ffb24a" transparent opacity={0.85} /></mesh>
        <mesh name="scorch" position={[0, 0.015, 0]} rotation={[-Math.PI / 2, 0, 0]}><circleGeometry args={[2.4, 24]} /><meshBasicMaterial color="#120d0a" transparent opacity={0.75} /></mesh>
        <pointLight name="fire" color="#ff7a2a" intensity={0} distance={14} position={[0, 1.2, 0]} />
      </group>
    </group>
  );
}

function Flatbed({ kind }: { kind: 'flatbed' | 'truck' }) {
  const body = kind === 'flatbed' ? '#6a5a3e' : '#3e4a52';
  return (
    <group>
      <Box s={[2.2, 1.4, 1.8]} p={[2.2, 1.15, 0]} c={body} />
      <Box s={[0.05, 0.5, 1.5]} p={[3.31, 1.35, 0]} c="#9fc4d4" e="#3a5560" ei={0.4} />
      {kind === 'flatbed'
        ? <Box s={[3.6, 0.2, 2.0]} p={[-0.6, 0.65, 0]} c="#4a4136" />
        : <Box s={[3.6, 1.9, 2.0]} p={[-0.6, 1.5, 0]} c="#59636b" />}
      {[[-1.6, 1], [-1.6, -1], [2.4, 1], [2.4, -1]].map(([x, z]) => (
        <mesh key={`${x}${z}`} position={[x, 0.42, z * 0.95]} rotation={[Math.PI / 2, 0, 0]} castShadow>
          <cylinderGeometry args={[0.42, 0.42, 0.3, 14]} />
          <meshStandardMaterial color="#1b1c1d" roughness={0.9} />
        </mesh>
      ))}
      <mesh name="hazard" position={[3.32, 1.95, 0]}><sphereGeometry args={[0.08, 8, 8]} /><meshBasicMaterial color="#ffb020" /></mesh>
    </group>
  );
}

/** Soft round smoke texture, drawn once. */
function useSmokeTexture() {
  return useMemo(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(32, 32, 2, 32, 32, 31);
    grd.addColorStop(0, 'rgba(255,255,255,0.9)');
    grd.addColorStop(0.5, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, []);
}

const PUFFS = 9;

function ExfilZone({ field, lowSpec }: { field: FieldRuntime; lowSpec: boolean }) {
  const z = field.spec.exfil!;
  const ring = useRef<THREE.Mesh>(null);
  const arc = useRef<THREE.Mesh>(null);
  const smoke = useRef<THREE.Group>(null);
  const flareLight = useRef<THREE.PointLight>(null);
  const zoneLight = useRef<THREE.PointLight>(null);
  const tex = useSmokeTexture();
  const lastArc = useRef(-1);
  const flares = useMemo(() => [0, 2.1, 4.2].map((a) => [Math.cos(a) * z.radius * 0.92, Math.sin(a) * z.radius * 0.92] as [number, number]), [z.radius]);

  useFrame((st, dt) => {
    const t = st.clock.elapsedTime;
    const phase = field.exfilPhase;
    const live = phase === 'ready' || phase === 'counting';
    const col = phase === 'counting' ? '#4be08a' : phase === 'done' ? '#4be08a' : live ? '#ffb020' : '#6f7d8c';
    if (ring.current) {
      const m = ring.current.material as THREE.MeshBasicMaterial;
      m.color.set(col);
      m.opacity = live ? 0.55 + Math.sin(t * 4) * 0.2 : 0.25;
    }
    if (arc.current) {
      const p = phase === 'counting' ? Math.min(1, field.exfilProgress / z.secs) : phase === 'done' ? 1 : 0;
      const q = Math.round(p * 48);
      if (q !== lastArc.current) {
        lastArc.current = q;
        arc.current.geometry.dispose();
        arc.current.geometry = new THREE.RingGeometry(z.radius - 0.35, z.radius - 0.05, 48, 1, Math.PI / 2, -Math.max(0.0001, (q / 48) * Math.PI * 2));
      }
      arc.current.visible = q > 0;
    }
    if (smoke.current) {
      smoke.current.visible = live || phase === 'done';
      smoke.current.children.forEach((c, i) => {
        const s = c as THREE.Sprite;
        const k = ((t * 0.18 + i / PUFFS) % 1);
        s.position.set(flares[0][0] + Math.sin(i * 1.7 + t * 0.3) * 0.5 * k, 0.4 + k * 7, flares[0][1] + Math.cos(i * 2.3) * 0.4 * k);
        s.scale.setScalar(0.8 + k * 3.2);
        (s.material as THREE.SpriteMaterial).opacity = 0.55 * (1 - k);
        (s.material as THREE.SpriteMaterial).color.set(phase === 'counting' || phase === 'done' ? '#7fe0a0' : '#ff9a4a');
      });
    }
    if (flareLight.current) flareLight.current.intensity = live ? 5 + Math.sin(t * 23) * 1.5 + Math.sin(t * 7) * 1.2 : 0;
    if (zoneLight.current) zoneLight.current.intensity = phase === 'counting' ? 3 : 0;
    void dt;
  });

  return (
    <group position={[z.pos[0], 0, z.pos[1]]}>
      <mesh ref={ring} position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[z.radius - 0.22, z.radius, 64]} />
        <meshBasicMaterial color="#ffb020" transparent opacity={0.5} depthWrite={false} />
      </mesh>
      <mesh ref={arc} position={[0, 0.035, 0]} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <ringGeometry args={[z.radius - 0.35, z.radius - 0.05, 48, 1, 0, 0.001]} />
        <meshBasicMaterial color="#4be08a" transparent opacity={0.9} depthWrite={false} />
      </mesh>
      {z.lz && (
        // Landing-zone markings: a painted square and an H.
        <group position={[0, 0.025, 0]}>
          {[[0, z.radius * 0.6, z.radius * 1.2, 0.18], [0, -z.radius * 0.6, z.radius * 1.2, 0.18], [z.radius * 0.6, 0, 0.18, z.radius * 1.2], [-z.radius * 0.6, 0, 0.18, z.radius * 1.2], [-0.7, 0, 0.25, 2.2], [0.7, 0, 0.25, 2.2], [0, 0, 1.4, 0.25]].map(([x, zz, w, d], i) => (
            <mesh key={i} position={[x, 0, zz]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[w, d]} />
              <meshBasicMaterial color="#e8e2d0" transparent opacity={0.7} depthWrite={false} />
            </mesh>
          ))}
        </group>
      )}
      {flares.map(([x, zz], i) => (
        <group key={i} position={[x, 0, zz]}>
          <mesh position={[0, 0.08, 0]} rotation={[0, 0, Math.PI / 2.4]}>
            <cylinderGeometry args={[0.035, 0.035, 0.28, 8]} />
            <meshBasicMaterial color="#ff3b2a" />
          </mesh>
        </group>
      ))}
      <pointLight ref={flareLight} color="#ff4a2a" intensity={0} distance={lowSpec ? 7 : 11} position={[flares[0][0], 0.6, flares[0][1]]} />
      <pointLight ref={zoneLight} color="#5fe0a8" intensity={0} distance={z.radius * 2.2} position={[0, 2.5, 0]} />
      <group ref={smoke}>
        {Array.from({ length: lowSpec ? 5 : PUFFS }, (_, i) => (
          <sprite key={i}>
            <spriteMaterial map={tex} transparent depthWrite={false} color="#ff9a4a" opacity={0.4} />
          </sprite>
        ))}
      </group>
      {z.vehicle && (
        <group position={[z.vehicle.pos[0] - z.pos[0], 0, z.vehicle.pos[1] - z.pos[1]]} rotation={[0, z.vehicle.rot, 0]}>
          <Flatbed kind={z.vehicle.kind} />
        </group>
      )}
    </group>
  );
}

export function FieldProps({ field, lowSpec = false }: { field: FieldRuntime; lowSpec?: boolean }) {
  const refs = useRef(new Map<string, THREE.Group>());
  const [count, setCount] = useState(field.items.size);
  const boomAt = useRef(-1);
  const items = useMemo(() => [...field.items.values()].filter((i) => i.kind !== 'exfil'), [field, count]);
  const label = field.spec.cargoLabel ?? '';

  useFrame((st) => {
    const t = st.clock.elapsedTime;
    if (field.items.size !== count) setCount(field.items.size);
    if (field.detonated && boomAt.current < 0) boomAt.current = t;
    for (const i of items) {
      const g = refs.current.get(i.id);
      if (!g) continue;
      const live = field.items.get(i.id) ?? i;
      g.visible = live.state !== 'carried' && !(live.kind === 'pouch' && live.state === 'empty');
      g.position.set(live.pos[0], 0, live.pos[1]);
      // Empty containers: the lid opens and the contents go.
      const lid = g.getObjectByName('lid');
      if (lid) lid.rotation.x = live.state === 'empty' ? -1.9 : 0;
      const fill = g.getObjectByName('fill');
      if (fill) fill.visible = live.state !== 'empty';
      // The thing you're looking at lifts a little and glows.
      const hot = field.target?.id === i.id;
      g.scale.setScalar(hot ? 1.06 + Math.sin(t * 8) * 0.02 : 1);
      const blink = g.getObjectByName('blink');
      if (blink) blink.visible = Math.sin(t * 6) > 0;
      if (live.kind === 'charge') {
        const set = g.getObjectByName('set');
        const mark = g.getObjectByName('mark');
        const boom = g.getObjectByName('boom');
        const led = g.getObjectByName('led');
        if (set) set.visible = live.state === 'done' && !field.detonated;
        if (mark) mark.visible = live.state === 'idle';
        if (led) led.visible = Math.sin(t * (field.fuseAt > 0 ? 16 : 5)) > 0;
        if (boom) {
          boom.visible = field.detonated;
          if (field.detonated) {
            const a = t - boomAt.current;
            const ball = boom.getObjectByName('ball') as THREE.Mesh | undefined;
            if (ball) {
              ball.visible = a < 0.9;
              ball.scale.setScalar(0.5 + a * 6);
              ball.position.y = 1 + a * 1.5;
              (ball.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.9 - a);
            }
            const fire = boom.getObjectByName('fire') as THREE.PointLight | undefined;
            if (fire) fire.intensity = a < 0.4 ? 80 : 6 + Math.sin(t * 17) * 2 + Math.sin(t * 5) * 2;
          }
        }
      }
    }
  });

  return (
    <group>
      {items.map((i) => (
        <group key={i.id} ref={(g) => { if (g) refs.current.set(i.id, g); else refs.current.delete(i.id); }} position={[i.pos[0], 0, i.pos[1]]}>
          {i.kind === 'ammo_crate' && <AmmoCrate item={i} />}
          {i.kind === 'med_case' && <MedCase />}
          {(i.kind === 'cargo_case' || i.kind === 'seized_case') && <CargoCase item={i} label={label} />}
          {i.kind === 'pouch' && <Pouch />}
          {i.kind === 'charge' && <Charge />}
        </group>
      ))}
      {field.spec.exfil && <ExfilZone field={field} lowSpec={lowSpec} />}
    </group>
  );
}
