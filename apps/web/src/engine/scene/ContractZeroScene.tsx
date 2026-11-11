'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { AdaptiveDpr } from '@react-three/drei';
import { AutoQuality, readAutoLevel, writeAutoLevel, type AutoLevel } from '../perf/autoQuality';
import { EffectComposer, Bloom, Noise, Vignette, ChromaticAberration, N8AO } from '@react-three/postprocessing';
import { BlendFunction } from 'postprocessing';
import * as THREE from 'three';
import { usePbr } from './usePbr';
import { makeTriplanarMaterial } from './triplanar';
import { buildViewmodelHands, VIEWMODEL_HIP, VIEWMODEL_ADS, WEAPON_VIEW } from './viewmodelHands';
import { buildZoneEnvironment, ENV_INTENSITY } from './zoneEnvironment';
import { ImpactFX, type ImpactSurface } from '../vfx/ImpactFX';
import { useImpactTextures } from '../vfx/useImpactTextures';
import { DroppedWeapon } from '../vfx/DroppedWeapon';
import {
  FpsSim,
  xpForKill, rankForXp, xpIntoRank, xpBarSize, rankUpsBetween, careerXpFor, XP_REWARD, rayAABB, aabbOfCover, slideMove, type FpsInput, type Vec3, type Rank, type Attachment,
} from '../fps';
import { RANK_COLORS } from '../../lib/constants';
import { linesFor, SPEAKER_META, type PresenceLine, type PresenceTrigger, type Speaker } from '../story/presence';
import { GUN_FEEL } from '../combat/GunFeel';
import { STARTER_GUN_ID, getGun, type GunId } from '../combat/GunStats';
import type { AmmoId, AttachmentId, AttachmentSlot } from '../combat/Loadout';
import { FpsAudio, ambienceKey } from '../audio';
import { computeEdgeArrow } from '../verb/threatArrow';
import { useGunPrototypes, ALL_GUN_IDS, GUN_LENGTH } from './gunModels';
import { OperatorRig, type OperatorApi } from './OperatorRig';
import { LEVELS } from '../fps/levels';
import { LevelArt } from './LevelArt';
import { FieldProps } from './FieldProps';
import { ItemInspector } from '@/components/inspect/ItemInspector';
import type { InspectItem } from '@/components/inspect/itemInfo';
import { useSettings, updateSettings, renderPlan, PALETTES, type RenderPlan, type Settings } from '@/lib/settings';
import { PauseSettings } from '@/components/settings/PauseSettings';
import { markTipSeen, tipSeen, type Tip } from '@/lib/tutorial';
import { DEFAULT_BINDS, actionsByCode, bindLabel, type Action, type Binds } from '@/lib/keybinds';
import { FieldRuntime, trainingField, BLAST_RADIUS, CARRY_MAX, type FieldEvent, type FieldRecord, type ProtoEvent } from '../fps/field';
import { CAMPAIGN, CAMPAIGN_KEY, PROGRESS_KEY, ZONE_THEMES, themeForMission, SURVIVAL_MISSION, GAUNTLET_MISSION, ENDLESS_MISSION, SEASONAL_MISSION, survivalWaveCount, survivalWaveHp, gauntletWaveCount, gauntletWaveHp, type Mission } from '../fps/campaign';
import {
  buildChain, generateRoom, entryCap, spawnPointFor, zForWaveStart, firstRoomOfWave, roomsForWave, ROOM_W,
  type GeneratedRoom,
} from '../fps/endless';
import { dressingFor, dressingColliders, type PropSpec } from './setDressing';

/**
 * CONTRACT ZERO first-person scene.
 *
 * The single verb, in isolation: a first-person gunfight that has to feel great
 * MUTED, with no art and no sound. First-person camera, viewmodel with sway +
 * bob + recoil, ADS / lean / crouch, aim decided by a camera raycast against
 * head/body hitboxes, cover that eats rounds, lethal damage, and enemies that
 * fight back from cover.
 *
 * Controls are KEYBOARD-FIRST (every action has a key):
 *   move WASD · look mouse OR arrow keys · FIRE Space · ADS Left-Shift
 *   lean Q/E · crouch C · reload R. Mouse buttons also work as a bonus.
 */

const EYE_STAND = 1.6;
const EYE_CROUCH = 1.02;
const PLAYER_R = 0.35;

const WALK = 3.4;     // m/s base
const ADS_MOVE = 0.55;
const CROUCH_MOVE = 0.5;

const LOOK_SENS = 0.0010;       // rad per mouse pixel — fine aim (was far too fast)
const KEY_LOOK = 0.9;           // rad/s for arrow-key look — small nudges
const ADS_SENS = 0.55;          // look slows while aiming down sights (precision)
const MOUSE_MAX_STEP = 90;      // clamp per-event mouse delta — kills pointer-lock spikes
const TOUCH_LOOK_SENS = 0.0022; // rad per touch-drag pixel (mobile look)
/// How fast the touch-drag buffer drains, per second. Higher = tighter and more
/// immediate, lower = glassier and more floaty. Used as `1 - exp(-dt * rate)`, so this
/// is a real-time constant: the same feel at 20fps as at 60fps. This is the number to
/// turn if mobile aim feels either laggy or twitchy.
const LOOK_SMOOTH_RATE = 19;

// Player-tunable look sensitivity. A single multiplier over the tuned defaults, kept
// per device in localStorage — a phone and a desktop want very different numbers, and
// localStorage is already per device, so one key covers both without a mode switch.
const SENS_KEY = 'cz_look_sens';
const SENS_MIN = 0.25, SENS_MAX = 2.5, SENS_DEFAULT = 1;
function loadLookSens(): number {
  if (typeof window === 'undefined') return SENS_DEFAULT;
  try {
    const v = Number(window.localStorage.getItem(SENS_KEY));
    // Clamped on the way IN, not just on the way out: a hand-edited or stale value
    // must not be able to make the game unplayable before the slider can fix it.
    if (Number.isFinite(v) && v > 0) return Math.max(SENS_MIN, Math.min(SENS_MAX, v));
  } catch { /* private mode */ }
  return SENS_DEFAULT;
}
const PITCH_LIMIT = 1.45;       // ~83°

const RECOIL_RECOVER = 12;     // per second
const BOB = 0.014;

// The two viewmodel framings moved to scene/viewmodelHands as VIEWMODEL_HIP /
// VIEWMODEL_ADS, so the grip bench can frame a weapon identically to the game.

// The tactical UI face (loaded in the route via next/font), mono for raw numbers.
const UI_FONT = 'var(--font-tactical), ui-monospace, monospace';

/** Line-drawn UI glyphs (currentColor), replacing emoji across the HUD/menus. */
function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const s = {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
    style: { display: 'block', flex: 'none' as const },
  };
  switch (name) {
    case 'lock': return (<svg {...s}><rect x="4.5" y="10.5" width="15" height="10" rx="2" /><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" /></svg>);
    case 'check': return (<svg {...s}><path d="M20 6 9 17l-5-5" /></svg>);
    case 'chevron': return (<svg {...s}><path d="M9 5l7 7-7 7" /></svg>);
    case 'play': return (<svg {...s} fill="currentColor" stroke="none"><path d="M7 4.5v15l12-7.5-12-7.5z" /></svg>);
    case 'alert': return (<svg {...s}><path d="M12 3 2.5 20h19L12 3z" /><line x1="12" y1="10" x2="12" y2="14" /><circle cx="12" cy="17" r="0.7" fill="currentColor" stroke="none" /></svg>);
    case 'infinity': return (<svg {...s}><path d="M4 12c0-2.2 1.8-4 4-4s3.2 1.6 4 3c.8-1.4 2-3 4-3s4 1.8 4 4-1.8 4-4 4-3.2-1.6-4-3c-.8 1.4-2 3-4 3s-4-1.8-4-4z" /></svg>);
    case 'menu': return (<svg {...s}><line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="20" y2="17" /></svg>);
    case 'refresh': return (<svg {...s}><path d="M20.5 9A8 8 0 1 0 21 14" /><path d="M21 3.5V9h-5.5" /></svg>);
    case 'swap': return (<svg {...s}><path d="M16 4l4 4-4 4" /><path d="M20 8H7" /><path d="M8 20l-4-4 4-4" /><path d="M4 16h13" /></svg>);
    case 'firemode': return (<svg {...s}><circle cx="7" cy="7" r="1.4" fill="currentColor" stroke="none" /><line x1="11" y1="7" x2="19" y2="7" /><circle cx="7" cy="12" r="1.4" fill="currentColor" stroke="none" /><line x1="11" y1="12" x2="19" y2="12" /><circle cx="7" cy="17" r="1.4" fill="currentColor" stroke="none" /><line x1="11" y1="17" x2="19" y2="17" /></svg>);
    case 'crosshair': return (<svg {...s}><circle cx="12" cy="12" r="7" /><line x1="12" y1="2" x2="12" y2="5" /><line x1="12" y1="19" x2="12" y2="22" /><line x1="2" y1="12" x2="5" y2="12" /><line x1="19" y1="12" x2="22" y2="12" /><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" /></svg>);
    case 'rotate': return (<svg {...s}><rect x="8.5" y="3" width="7" height="18" rx="1.6" /><path d="M4.2 8.4A9 9 0 0 1 7 4.9" /><path d="M3 5l1 3.4 3.3-.8" /><path d="M19.8 15.6A9 9 0 0 1 17 19.1" /><path d="M21 19l-1-3.4-3.3.8" /></svg>);
    case 'pause': return (<svg {...s} fill="currentColor" stroke="none"><rect x="6.5" y="5" width="3.5" height="14" rx="1" /><rect x="14" y="5" width="3.5" height="14" rx="1" /></svg>);
    default: return null;
  }
}

/** Wrapped angular difference a-b, in (-π, π]. */
/** A gradient sky dome (zenith → horizon), the actual sky above the compound
 *  walls. fog:false keeps it crisp; it re-tints when the zone theme changes. */
function SkyDome({ top, bottom }: { top: string; bottom: string }) {
  const mat = useMemo(() => new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uTop: { value: new THREE.Color(top) }, uBottom: { value: new THREE.Color(bottom) } },
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'varying vec3 vP; uniform vec3 uTop; uniform vec3 uBottom; void main(){ float h = clamp(normalize(vP).y * 0.5 + 0.5, 0.0, 1.0); gl_FragColor = vec4(mix(uBottom, uTop, pow(h, 0.8)), 1.0); }',
  }), []);
  useEffect(() => {
    (mat.uniforms.uTop.value as THREE.Color).set(top);
    (mat.uniforms.uBottom.value as THREE.Color).set(bottom);
  }, [top, bottom, mat]);
  return (
    <mesh scale={[300, 300, 300]} renderOrder={-1} frustumCulled={false}>
      <sphereGeometry args={[1, 24, 16]} />
      <primitive object={mat} attach="material" />
    </mesh>
  );
}

/** The world-space materials the clutter wears. Built in FpsWorld (they need the
 *  loaded PBR maps) and passed down, so one material serves every prop of a kind. */
type PropMaterials = Record<'barrelA' | 'barrelB' | 'crate' | 'sandbag' | 'rubble', THREE.Material>;

function Prop({ kind, x, z, rot, mats }: PropSpec & { mats: PropMaterials }) {
  if (kind === 'barrels') {
    const drums = [mats.barrelA, mats.barrelB, mats.barrelA];
    return (
      <group position={[x, 0, z]} rotation={[0, rot, 0]}>
        {[[0, 0], [0.34, 0.06], [0.16, 0.34]].map(([dx, dz], i) => (
          <mesh key={i} position={[dx, 0.45, dz]} castShadow receiveShadow>
            {/* 12 sides was a graybox count and read as a hexagonal bin up close;
                18 is still cheap and the silhouette is round. */}
            <cylinderGeometry args={[0.26, 0.28, 0.9, 18]} />
            <primitive object={drums[i]} attach="material" />
          </mesh>
        ))}
      </group>
    );
  }
  if (kind === 'crates') {
    return (
      <group position={[x, 0, z]} rotation={[0, rot, 0]}>
        <mesh position={[0, 0.32, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.66, 0.64, 0.66]} />
          <primitive object={mats.crate} attach="material" />
        </mesh>
        <mesh position={[0.12, 0.82, -0.1]} rotation={[0, 0.4, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.5, 0.46, 0.5]} />
          <primitive object={mats.crate} attach="material" />
        </mesh>
      </group>
    );
  }
  if (kind === 'sandbags') {
    return (
      <group position={[x, 0, z]} rotation={[0, rot, 0]}>
        {[[-0.34, 0, 0.16], [0.34, 0, 0.16], [0, 0, 0.16], [-0.17, 0.28, 0.16], [0.17, 0.28, 0.16]].map(([dx, dy, h], i) => (
          <mesh key={i} position={[dx, 0.14 + dy, 0]} rotation={[0, (i % 2) * 0.3, 0]} castShadow receiveShadow>
            <boxGeometry args={[0.42, 0.26, h + 0.3]} />
            <primitive object={mats.sandbag} attach="material" />
          </mesh>
        ))}
      </group>
    );
  }
  // debris — a low scatter of rubble that can never hide anyone
  return (
    <group position={[x, 0, z]} rotation={[0, rot, 0]}>
      {[[0, 0.12, 0, 0.5], [0.3, 0.08, 0.2, 0.3], [-0.25, 0.1, -0.15, 0.34]].map(([dx, s, dz, w], i) => (
        <mesh key={i} position={[dx, s, dz]} rotation={[rot * 0.3, i, 0]} castShadow receiveShadow>
          <boxGeometry args={[w, s * 2, w * 0.8]} />
          <primitive object={mats.rubble} attach="material" />
        </mesh>
      ))}
    </group>
  );
}

/** Takes the prop list rather than deriving it, so the meshes you see and the
 *  colliders the sim was built with can never be two different scatters. */
function SetDressing({ props, mats }: { props: PropSpec[]; mats: PropMaterials }) {
  return <>{props.map((p, i) => <Prop key={i} {...p} mats={mats} />)}</>;
}

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** A glassy, tactile circular touch button — the shared look for the mobile HUD. */
function touchBtn(color: string, size: number, strong = false): React.CSSProperties {
  return {
    position: 'absolute', width: size, height: size, borderRadius: '50%',
    border: `1.5px solid ${color}${strong ? 'cc' : '55'}`,
    // Base alpha raised .42 → .74 because this used to sit on a blur(7px) backdrop
    // that supplied most of the separation from the scene. The blur is gone (see
    // `frost` — these buttons are touch-only, and nine live backdrop-filters over a
    // per-frame canvas was the mobile HUD's largest fixed cost), so the fill has to
    // carry the contrast on its own.
    background: `radial-gradient(circle at 50% 34%, ${color}${strong ? '40' : '22'}, ${color}0f 66%, rgba(6,10,16,.74))`,
    boxShadow: `inset 0 1px 0 rgba(255,255,255,.22), inset 0 -8px 16px ${color}14, 0 6px 16px rgba(0,0,0,.5)`,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color, fontWeight: 700, letterSpacing: 1, touchAction: 'none', userSelect: 'none', WebkitTapHighlightColor: 'transparent',
    transition: 'transform .11s cubic-bezier(.34,1.56,.64,1), box-shadow .11s, filter .11s', willChange: 'transform',
  };
}

/** Momentary press feedback for a touch button — a quick squish that springs back. */
function pressFx(el: HTMLElement | null, down: boolean, color: string) {
  if (!el) return;
  el.style.transform = down ? 'scale(0.86)' : 'scale(1)';
  el.style.filter = down ? 'brightness(1.5)' : 'brightness(1)';
  el.style.boxShadow = down
    ? `inset 0 1px 0 rgba(255,255,255,.3), 0 0 0 3px ${color}44, 0 8px 20px rgba(0,0,0,.5)`
    : `inset 0 1px 0 rgba(255,255,255,.22), inset 0 -8px 16px ${color}14, 0 6px 16px rgba(0,0,0,.5)`;
}

/** A button label: an icon followed by text, vertically centred. */
function iconRow(name: string, label: string, size = 15): React.ReactNode {
  return (<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Icon name={name} size={size} />{label}</span>);
}

/**
 * Is this a touch-first device (phone / tablet) that should get the mobile
 * controls? Handles the tricky cases: an iPad on iPadOS 13+ Safari masquerades as
 * DESKTOP macOS ("Macintosh" UA, no `ontouchstart`) but still reports multi-touch;
 * Android "Desktop site" mode can strip touch hints too. So we check the UA for the
 * known mobile/tablet families first, then the iPad-as-Mac tell, then a coarse
 * touch pointer — while a mouse-driven touchscreen laptop stays desktop.
 * `?touch` / `?desktop` force it either way for testing.
 */
function detectTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const q = new URLSearchParams(window.location.search);
  if (q.has('touch')) return true;
  if (q.has('desktop')) return false;
  const ua = navigator.userAgent || '';
  if (/iPhone|iPod|iPad|Android|Windows Phone|IEMobile|BlackBerry/i.test(ua)) return true;
  // iPadOS desktop-mode: reports as a Mac but has a touchscreen (real Macs report 0).
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 0) return true;
  // Any remaining touch-primary device (coarse pointer) — excludes mouse desktops
  // and trackpad laptops that merely happen to have a touchscreen.
  if (navigator.maxTouchPoints > 0 && window.matchMedia?.('(pointer: coarse)')?.matches) return true;
  return false;
}

/** Feeds frame times to the auto-quality controller (inside the Canvas). */
function AutoQualityProbe({ level, onStep }: { level: AutoLevel; onStep: (l: AutoLevel) => void }) {
  const ctl = useMemo(() => new AutoQuality(level), [level]);
  useFrame((_, dt) => {
    const step = ctl.frame(dt);
    if (step !== null) onStep(step);
  });
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__czAutoQuality = () => ({ level: ctl.level, fps: Math.round(ctl.fps) });
    return () => { delete w.__czAutoQuality; };
  }, [ctl]);
  return null;
}

/** Shared outlined-button style for the pause menu (C4). */
function btnC4(color: string): React.CSSProperties {
  return { pointerEvents: 'auto', cursor: 'pointer', background: 'transparent', border: `1px solid ${color}`, color, fontFamily: 'inherit', fontSize: 13, letterSpacing: 3, padding: '11px 22px', borderRadius: 6 };
}

// Per-weapon viewmodel framing so each gun reads as a different silhouette off
// the one shared rifle model: scale = length, z/y = how it sits in the hands.
// The attachment HUD strip + which key toggles each.
const ATTACH_CHIPS: { id: Attachment; label: string; key: string; color: string }[] = [
  { id: 'nvg', label: 'NVG', key: 'N', color: '#5fe0a8' },
  { id: 'light', label: 'LIGHT', key: 'F', color: '#ffe08a' },
  { id: 'laser', label: 'LASER', key: 'L', color: '#ff6a6a' },
  { id: 'optic', label: 'OPTIC', key: 'O', color: '#8fb8d0' },
];


// Where a dropped weapon comes to rest. Not 0: the models are centred on the body
// of the gun, so a receiver lying on the deck sits a few centimetres up.
const DROP_REST_Y = 0.07;

/** Metres between footfalls — one puff of dust per stride walked. */
const STRIDE = 0.95;

/** Sim-seconds on the deck before a second wind puts you back up. Long enough to
 *  register that you went down, short enough that it never feels like a load. */
const REVIVE_DELAY = 1.5;

// The mission compound is data now (engine/fps/campaign.ts). The scene runs ONE
// Mission at a time, loaded from CAMPAIGN[missionIndex]; completing it advances.
const FLOOR_W = 22, FLOOR_D = 38;

/** One unit cube shared by every wall and cover box in the scene. Walls are scaled
 *  copies of it, so streaming a room in or out costs no GPU buffer allocation. */
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

// ── Endless tuning ───────────────────────────────────────────────────────────
/** Rooms kept generated AHEAD of the player. Two is enough that the next room's
 *  walls and the one beyond it already exist when you look through a doorway. */
const ENDLESS_LOOKAHEAD = 3;
/** Rooms kept behind the player before they're pruned. Keeping one lets you back
 *  into the doorway you came through mid-firefight without falling out of the world. */
const ENDLESS_TRAIL = 1;
/** Lateral bound inside a generated room — the interior half-width, less a margin so
 *  the player is stopped just shy of the side walls rather than inside them. */
const ENDLESS_HALF_W = ROOM_W / 2 - 0.3;
/** How many enemy rigs endless keeps mounted. Authored missions size this pool from
 *  their own enemy list, but an endless mission carries NO enemies — they are streamed
 *  in per room — so it needs a standing pool instead. The live window holds 4 rooms
 *  (one trailing, the current, two ahead) and a room caps at 8 defenders, so 32 is the
 *  real ceiling; this leaves a little headroom. Unused slots are parked invisible, and
 *  a parked rig skips its skeleton update entirely (see OperatorRig). Without this pool
 *  the sim has enemies shooting at you that were never given a body to render. */
const ENDLESS_ENEMY_POOL = 36;
/** Draw distance for an ACTIVE (fighting) enemy — effectively never culled, so a
 *  defender chasing you can't blink out mid-firefight. */
const ENDLESS_CULL_ACTIVE = 60;
/** Draw distance for a DORMANT enemy: one asleep in a room you have not breached,
 *  almost always sealed behind a wall. Rooms are 14-18m deep, so this shows the one
 *  you are in and drops the rest — where nearly all the saving is. */
const ENDLESS_CULL_DORMANT = 20;
/** The same rule for an AUTHORED op, held further out.
 *
 *  This cull used to be endless-only, which left the campaign drawing every enemy in
 *  the mission on every frame. That is not a small oversight: an operator rig is
 *  46,301 triangles, and a measured op-1 frame on the minimal touch tier spent 417k of
 *  its 440k triangles on nine of them. Frustum culling alone cannot fix it, because an
 *  op is a corridor of rooms and the enemies are all AHEAD of you, inside the view
 *  cone, merely hidden behind walls — and three.js does no occlusion culling.
 *
 *  Set against the real geometry rather than guessed. Ops start the player at z=16
 *  (A_START) and op 1's rooms sit at z 2.5..5 and z -7..-2.5, i.e. dz 11-13.5 for the
 *  front room and 18.5-23 for the back one. 18m therefore keeps every body in the room
 *  you are walking into and drops the room behind its unbreached wall — which is the
 *  whole saving, since that far room is where most of an op's defenders wait.
 *
 *  It cannot pop anything you could see: a dormant enemy is by definition sealed in a
 *  room you have not opened, and by the time you reach the breach you are far inside
 *  18m, so it is already drawn. Breaching calls setRoomActive, which flips it to the
 *  ACTIVE distance and pins it visible for the rest of the fight. */
const CAMPAIGN_CULL_DORMANT = 18;
/** Depth of the travelling floor plane. Chosen so the ground texture's 20 repeats
 *  divide it into whole 3m tiles (see ENDLESS_RIG_STEP). */
const ENDLESS_FLOOR_D = 60;
/** Grid the travelling floor + sun snap to. It is exactly one floor texture tile
 *  (60 / 20 repeats), so when the floor jumps a cell the texture lands back on
 *  itself and the ground reads as static instead of sliding along with you. */
const ENDLESS_RIG_STEP = ENDLESS_FLOOR_D / 20;
/** One shadow-map texel in world units: the sun's shadow camera spans 44 units across
 *  a 2048 map. The travelling sun snaps to THIS, not the floor's 3m tile — a coarse
 *  step makes every shadow in the compound jump at once, which looks like the building
 *  juddering, while a texel-sized step keeps shadow edges stable against the world. */
const ENDLESS_SHADOW_TEXEL = 44 / 2048;

/** The parameters and callbacks for a generated-chain run. */
export interface EndlessOpts {
  /** Layout seed. Everyone in a season shares one, so nobody gets an easier draw. */
  seed: number;
  /** Wave the run begins on. Always 1 for Seasonal; the saved checkpoint for
   *  Campaign Endless. */
  startWave: number;
  /** Fired the moment the last enemy of a wave's final room drops. The page turns
   *  this into the server call that banks the wave (and pays it, once, in Campaign
   *  Endless). Never fires twice for the same wave. */
  onWaveCleared?: (wave: number) => void;
  /** The player was killed. `wave` is the one they died on. The run does NOT end —
   *  they are put back at the start of that wave — so this is for recording the loss,
   *  not for tearing the session down. */
  onDeath?: (wave: number, stats: { kills: number; headshots: number }) => void;
}

/** A non-host teammate's reported position/aim/fire-intent, sent every frame
 *  over `useCoopSocket`'s relay. World eye position + a normalized aim
 *  direction rather than yaw/pitch — the sender already HAS these (its own
 *  `cam.position`/`cam.getWorldDirection`), so there's no trig to
 *  reconstruct on either end. */
export interface CoopRemoteInput {
  x: number; y: number; z: number;
  dirX: number; dirY: number; dirZ: number;
  firing: boolean;
}

/** `FpsSim.snapshot()` plus the host's own world position — that class is
 *  headless and never owns camera/position state, only combat state, so a
 *  non-host client needs this bolted on separately to render the host's
 *  own operator rig (the `combatants` map only ever contains OTHER
 *  non-host teammates — the host is never a combatant of itself). */
export type CoopHostSnapshot = ReturnType<FpsSim['snapshot']> & {
  hostPos: { x: number; z: number; eyeY: number };
};

/** Host + this many teammates. MUST match `MAX_PARTY_SIZE` in
 *  `coop_server.rs` — this is what the client actually has rig slots for,
 *  the server is what actually enforces the cap. */
const MAX_PARTY_SIZE = 4;
/** A reasonable fixed cadence for a teammate's remote-resolved shots — the
 *  host doesn't know their exact weapon's fire rate (loadout is per-client
 *  cosmetic in every mode but Face-Off), so this is a simple, ammo-free
 *  approximation rather than modeling their real gun stats server-side. */
const TEAMMATE_FIRE_INTERVAL = 0.12;
/** Zero spread — a teammate's remote shot goes exactly where they reported
 *  aiming. Matches the trust model `resolveRemoteShot`'s own doc states:
 *  the host believes what a teammate's client says it fired. */
const TEAMMATE_SPREAD = 0;

/** Co-op Endless (party mode) — layered alongside `EndlessOpts`, present
 *  only when this run is a party, not solo. `useCoopSocket`'s own snapshot/
 *  peer-input fields are typed `unknown` on purpose (that hook is a dumb
 *  relay and never needs to know their shape) — this is where they get a
 *  real shape, tied directly to `FpsSim.snapshot()`'s actual return type so
 *  the two can never drift apart. */
export interface CoopOpts {
  isHost: boolean;
  /** This client's own wallet — used to filter "myself" out of whatever a
   *  non-host renders from the host's broadcast (I already render my own
   *  first-person view; I don't also want a third-person rig of myself). */
  myWallet: string;
  /** Non-host only — the host's latest broadcast, read every frame. */
  latestHostSnapshot?: React.RefObject<CoopHostSnapshot | null>;
  /** Host only — called on ContractZeroScene's own broadcast cadence. */
  sendHostState?: (snapshot: CoopHostSnapshot) => void;
  /** Non-host only — this frame's local input; the caller/hook decides
   *  transport rate, not this. */
  sendRemoteInput?: (payload: CoopRemoteInput) => void;
  /** Host only — every teammate's latest reported input, wallet -> payload. */
  latestPeerInputs?: React.RefObject<Map<string, CoopRemoteInput>>;
  /** Host only — fans a wave-clear out to the party over the relay. */
  sendWaveCleared?: (wave: number) => void;
}
const REACH_RADIUS = 3.5;
// A defend hold banks time within a WIDER ring than a reach touch, so you can pull
// back to adjacent cover to recover and still be "holding the point" — the hold no
// longer punishes the one tool the game teaches (using cover).
const HOLD_RADIUS = 6.5;

// Earn loop (slice 5). Career XP persists locally in the sandbox; when this is
// attached to /fight it banks through the real rank/RewardPool path instead.
const XP_KEY = 'cz_career_xp';
const XP_POPS = 4;

/** Placeholder body, real rifle animation. Swapping the mesh is one asset change. */
const OPERATOR_GLB = '/characters/glb/operator.glb';

/** Probe hooks (window.__cz*) exist only in development builds, or when a build opts
 *  in with NEXT_PUBLIC_CZ_DEV_HOOKS=1. A production player can't teleport, kill a
 *  room or skip a briefing from the console. The server still checks every claimed
 *  result against time and the session manifest regardless. */
const DEV_HOOKS = process.env.NODE_ENV !== 'production' || process.env.NEXT_PUBLIC_CZ_DEV_HOOKS === '1';

interface Hud {
  field: HTMLDivElement | null;
  fieldPrompt: HTMLDivElement | null;
  fieldExfil: HTMLDivElement | null;
  root: HTMLDivElement | null;
  ammo: HTMLDivElement | null;
  fireMode: HTMLDivElement | null;
  weapon: HTMLDivElement | null;
  loadout: HTMLDivElement | null;
  attachments: HTMLDivElement | null;
  nvgTint: HTMLDivElement | null;
  scope: HTMLDivElement | null;
  reload: HTMLDivElement | null;
  reloadBar: HTMLDivElement | null;
  reloadHint: HTMLDivElement | null;
  hit: HTMLDivElement | null;
  ch: { t: HTMLDivElement | null; b: HTMLDivElement | null; l: HTMLDivElement | null; r: HTMLDivElement | null };
  chDot: HTMLDivElement | null;
  chRing: HTMLDivElement | null;
  /** First-time tip line (lib/tutorial): never blocks the fight, fades on its own. */
  tip: HTMLDivElement | null;
  lock: HTMLDivElement | null;
  kills: HTMLDivElement | null;
  healthFill: HTMLDivElement | null;
  refills: HTMLDivElement | null;   // second-wind pips under the health bar
  vignette: HTMLDivElement | null;
  hitDir: HTMLDivElement | null;
  down: HTMLDivElement | null;
  arrows: Array<HTMLDivElement | null>;
  objText: HTMLDivElement | null;
  survEnd: HTMLDivElement | null;
  survEndText: HTMLDivElement | null;
  // ENDLESS: the standing wave readout + the wave-cleared beat.
  waveHud: HTMLDivElement | null;
  waveLabel: HTMLDivElement | null;
  waveRooms: HTMLDivElement | null;
  waveDone: HTMLDivElement | null;
  waveDoneText: HTMLDivElement | null;
  waveDoneSub: HTMLDivElement | null;
  objArrow: HTMLDivElement | null;
  briefing: HTMLDivElement | null;
  complete: HTMLDivElement | null;
  perf: HTMLDivElement | null;
  lockReticle: HTMLDivElement | null; // bracket drawn over the locked-on enemy
  adsBtn: HTMLDivElement | null;      // mobile ADS toggle, lit while aiming
  crouchBtn: HTMLDivElement | null;   // mobile crouch toggle, lit while crouched
  attachChips: Record<string, HTMLDivElement | null>; // mobile kit chips, lit while active
  rankText: HTMLDivElement | null;
  xpBar: HTMLDivElement | null;
  xpPops: Array<HTMLDivElement | null>;
  rankUp: HTMLDivElement | null;
  rankUpRank: HTMLDivElement | null;
  rankUpG: HTMLDivElement | null;
  subWrap: HTMLDivElement | null;
  subName: HTMLDivElement | null;
  subText: HTMLDivElement | null;
  bossWrap: HTMLDivElement | null;
  bossName: HTMLDivElement | null;
  bossFill: HTMLDivElement | null;
}

/** Mobile/touch control state, written by the on-screen pads and read each frame. */
interface Controls {
  moveX: number; // -1..1 strafe (right +)
  moveY: number; // -1..1 forward (forward +)
  lookX: number; // accumulated touch-drag dx, consumed each frame
  lookY: number;
  /**
   * Player's look-sensitivity multiplier on top of LOOK_SENS / TOUCH_LOOK_SENS.
   *
   * Lives here rather than in a prop so the frame loop picks a change up on the very
   * next frame with no remount. 1 = the tuned default; the slider in the pause menu
   * writes it and persists it per device.
   */
  lookSens: number;
  fire: boolean;
  ads: boolean;
  /** Touch crouch, held as a TOGGLE rather than a press. The stick and the fire pad
   *  already own both thumbs, so a hold-to-crouch button is a button you cannot use
   *  while playing. Desktop keeps hold-to-crouch on C, where a spare finger exists. */
  crouch: boolean;
  reload: boolean;
  fireMode: boolean;
  swap: boolean;
  /** Touch interact, held (the E key). */
  interact: boolean;
  /** Touch: apply a field dressing (the H key). */
  heal: boolean;
  toggle: Attachment | null; // mobile attachment chip → toggle this
  // ── Assisted targeting (mobile) ──
  lockCycle: boolean;          // Target button tapped → acquire nearest / cycle to next
  tapAimX: number | null;      // a TAP on the aim surface (screen px) → lock the enemy there
  tapAimY: number | null;
}

/**
 * C3 on-device perf meter. Lives inside the Canvas (needs useFrame) and writes a
 * rolling FPS + worst-frame reading to the HUD overlay's `perf` element. The "worst"
 * ms over each window is the tell for hitches (a spike a raw average hides).
 */
function PerfHud({ hud }: { hud: React.MutableRefObject<Hud> }) {
  const acc = useRef({ frames: 0, t: 0, worst: 0 });
  useFrame((_, dt) => {
    const a = acc.current;
    a.frames += 1; a.t += dt; a.worst = Math.max(a.worst, dt);
    if (a.t >= 0.5) {
      const fps = Math.round(a.frames / a.t);
      const worstMs = Math.round(a.worst * 1000);
      if (hud.current.perf) {
        hud.current.perf.textContent = `${fps} FPS · ${worstMs}ms worst`;
        hud.current.perf.style.color = fps >= 50 ? '#5fe0a8' : fps >= 30 ? '#e0b737' : '#ff5a52';
      }
      a.frames = 0; a.t = 0; a.worst = 0;
    }
  });
  return null;
}

/** Settings → Graphics → frame-rate cap: drive the loop by hand at the chosen rate
 *  (the Canvas runs with frameloop "never" while a cap is set). */
function FrameCap({ fps }: { fps: number }) {
  const advance = useThree((st) => st.advance);
  useEffect(() => {
    const step = 1000 / fps;
    const start = performance.now();
    let raf = 0, next = start;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t + 1 < next) return;
      next = Math.max(next + step, t - step); // keep cadence, never spiral after a stall
      advance((t - start) / 1000);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [fps, advance]);
  return null;
}

/** The last fight's measured frame rate, for the Settings page's readout. */
function PerfRecorder({ tier, plan, cap }: { tier: string; plan: RenderPlan; cap: number }) {
  const acc = useRef({ frames: 0, t: 0, worst: 0 });
  const gl = useThree((st) => st.gl);
  useFrame((_, dt) => {
    const a = acc.current;
    a.frames += 1; a.t += dt; a.worst = Math.max(a.worst, dt);
    if (a.t >= 3) {
      try {
        window.localStorage.setItem('cz_perf_last', JSON.stringify({
          fps: Math.round(a.frames / a.t), worstMs: Math.round(a.worst * 1000), tier, pixelRatio: +gl.getPixelRatio().toFixed(2),
          shadows: plan.shadows, post: plan.post, cap, at: Date.now(),
        }));
      } catch { /* private mode */ }
      a.frames = 0; a.t = 0; a.worst = 0;
    }
  });
  return null;
}

function FpsWorld({ hud, controls, audio, lowSpec, lightFx, minimal, mission, onComplete, onDeath, endOnDeath, pausedRef, gateRef, accountRank, accountXp, equippedGun, equippedAmmo, equippedMods, fieldKit, endlessOpts, coop, onProtocol, onInspect, inspectingRef, settingsRef, plan }: {
  /** Contract mode: a final death ends the run (the page shows the result) instead of restarting the op. */
  endOnDeath?: boolean;
  hud: React.MutableRefObject<Hud>; controls: React.MutableRefObject<Controls>;
  // lowSpec = touch device (drives touch input/aim-assist). lightFx = drop the
  // expensive postprocessing. minimal = the aggressive tier for a struggling
  // desktop/laptop: also kills shadows + set-dressing (mobile never sets this).
  audio: FpsAudio; lowSpec: boolean; lightFx: boolean; minimal: boolean; mission: Mission; onComplete: (stats: { kills: number; headshots: number; record?: FieldRecord }) => void;
  // Fires once per death, just before the op auto-restarts. The scene records the loss
  // (campaign only). Omitted where losses aren't recorded (/dev/verb).
  onDeath?: (stats: { kills: number; headshots: number }) => void;
  pausedRef: React.MutableRefObject<boolean>;
  // While the server-readiness gate is up (connecting / retry), freeze the sim so the
  // briefing + countdown don't run out behind the overlay and drop you into a live fight.
  gateRef: React.MutableRefObject<boolean>;
  // C1: the real server account standing. When present, the HUD's rank bar is
  // SEEDED from it (so it shows your true rank/progress, not a local number) and
  // climbs live per-kill; the server reconciles on op-clear. Omitted at /dev/verb.
  accountRank?: Rank; accountXp?: number;
  // The player's equipped gun from their marketplace inventory. It raises the
  // FLOOR of the op's issued weapon: you always carry whichever of the two is the
  // stronger tier, so buying a better gun visibly upgrades every fight while a new
  // player (sidearm only) still gets the op's issued weapon.
  equippedGun?: GunId;
  // The player's equipped ammo + stat attachments (B) — folded into every carried
  // gun's stats, and (for incendiary) a burn DoT.
  equippedAmmo?: AmmoId;
  equippedMods?: Partial<Record<AttachmentSlot, AttachmentId>>;
  // Standard-issue field kit (flashlight / NVG / laser) chosen on the Loadout.
  fieldKit?: Attachment[];
  // ENDLESS: the run's parameters and its two callbacks. Present only for the
  // generated-chain modes (Campaign Endless / Seasonal Campaign).
  endlessOpts?: EndlessOpts;
  // Co-op Endless (party mode). See `CoopOpts`.
  coop?: CoopOpts;
  /** Live contracts: the mission protocol events for the server, in order. */
  onProtocol?: (events: ProtoEvent[]) => void;
  /** I pressed: open the inspector on this item. While `inspectingRef` is set the
   *  fight goes on but the player's input is held (standing still, weapon down). */
  onInspect?: (item: InspectItem) => void;
  inspectingRef?: React.MutableRefObject<boolean>;
  /** Live player settings (FOV, reduced motion and flashes, subtitles, interaction). */
  settingsRef?: React.MutableRefObject<Settings>;
  /** What to render: the quality tier plus the player's graphics overrides. */
  plan: RenderPlan;
}) {
  const { camera, gl, scene } = useThree();

  // The one mission this mount runs. The scene remounts (key=missionIndex) to
  // switch, so treating these as constants is safe. Aliased to the old names so
  // the rest of the world reads unchanged.
  const ENEMIES = mission.enemies;
  // A training compound's last "extract" walk becomes a real extraction zone.
  const OBJECTIVES = useMemo(() => {
    if (mission.field || mission.survival || mission.endless) return mission.objectives;
    return mission.objectives.map((o, i) =>
      i === mission.objectives.length - 1 && o.kind === 'reach' && /EXTRACT|FALL BACK|GET CLEAR/.test(o.text) ? { ...o, kind: 'extract' as const } : o);
  }, [mission]);
  // The physical objects of this op (fps/field): one runtime per mount.
  const FIELD = useMemo(() => {
    if (mission.field) return new FieldRuntime(mission.field);
    const last = OBJECTIVES[OBJECTIVES.length - 1];
    return new FieldRuntime(trainingField(last?.kind === 'extract' ? last.pos : null));
  }, [mission, OBJECTIVES]);
  /** Field modes count rounds and loot more; the arenas keep an unlimited reserve. */
  const FINITE_AMMO = !mission.survival && !mission.gauntlet;
  // Your equipped gun overrides the op's issued primary when it's the stronger
  // tier (the mission gun is the floor). A boss finale still issues its scripted
  // weapon unless you own something better.
  // Your equipped gun is what you fight with — a gun you bought + equipped is ALWAYS
  // carried, even if it's a lower tier than the op issues (the Loadout warns you rather
  // than silently overriding your pick). The starter sidearm is the exception: it's the
  // default when nothing is equipped, so it falls back to the op's issued weapon rather
  // than handicapping a new player who hasn't bought anything yet.
  const hasChosenGun = !!equippedGun && equippedGun !== STARTER_GUN_ID;
  const PRIMARY: GunId = hasChosenGun ? equippedGun! : mission.gun;
  const GUN = PRIMARY;
  const LOADOUT = useMemo<GunId[]>(() => [PRIMARY, mission.secondary ?? 'sidearm'], [PRIMARY, mission.secondary]);
  const endless = !!mission.endless;
  // In endless the collider set is LIVE: rooms are appended ahead of the player and
  // pruned behind them, so this array is mutated in place rather than rebuilt. Every
  // per-frame loop below already re-reads it, so they pick up new geometry for free.
  // The clutter hugging the walls. Authored missions only — survival and endless
  // don't dress their rooms.
  // A structured level (fps/levels) brings its own geometry and art.
  const LEVEL = mission.level ? LEVELS[mission.level] : null;
  const levelCx = LEVEL ? (LEVEL.bounds.minX + LEVEL.bounds.maxX) / 2 : 0;
  const levelCz = LEVEL ? (LEVEL.bounds.minZ + LEVEL.bounds.maxZ) / 2 : 0;
  const DRESSING = useMemo(
    () => (mission.survival || mission.endless || mission.level ? [] : dressingFor(mission)),
    [mission],
  );
  // Barrels, crates and sandbags are SOLID, alongside the walls and cover. They were
  // decoration that nothing collided with, so people and enemies walked through
  // them. Debris is excluded by propCollider — ankle-high rubble you step over.
  //
  // Note these go in whatever the visual tier is. `minimal` drops the prop MESHES
  // to save draw calls, and a collider set that changed with the framerate would be
  // worse than an unlit corner you can't walk into: the sim is handed this list
  // once at construction, and collision must not depend on how fast the phone is.
  const COLLIDERS = useMemo(
    () => [...mission.walls, ...mission.cover, ...dressingColliders(DRESSING)],
    [mission, DRESSING],
  );
  const theme = themeForMission(mission);
  const isFinale = !endless && mission.id === CAMPAIGN[CAMPAIGN.length - 1].id;
  const survival = !!mission.survival;
  const blackout = !!mission.blackout; // the Rift with NVG jammed — fight by muzzle-flash

  // ── Endless chain state ──
  // `rooms` holds only the live window (a few either side of the player); `cursor` is
  // the room they are standing in. Everything is regenerable from the seed, so the
  // window can be pruned without losing anything.
  const chain = useRef<{
    rooms: GeneratedRoom[];
    cursor: number;      // chain index of the room the player is in
    nextIndex: number;   // next chain index to generate
    nextZ: number;       // z the next generated room starts at
    wave: number;        // the wave currently being fought
    bankedThrough: number; // highest wave already reported cleared (no double-pay)
    armed: boolean;      // has the FIRST room been woken? (see the arming beat below)
    dying: boolean;      // dead, waiting to be put back at the start of this wave
    over: boolean;
  }>({ rooms: [], cursor: 0, nextIndex: 0, nextZ: 0, wave: 1, bankedThrough: 0, armed: false, dying: false, over: false });
  // Bumped whenever geometry is appended or pruned, purely to re-render the meshes.
  const [geoTick, setGeoTick] = useState(0);
  const floorRef = useRef<THREE.Mesh>(null);
  const sunRef = useRef<THREE.DirectionalLight>(null);
  const sunTargetRef = useRef<THREE.Object3D>(null);
  const endlessTicks = useRef(0);
  /** Wall-clock deadline for the wave-cleared banner, 0 when it isn't showing. */
  const waveDoneUntil = useRef(0);
  /** Wall-clock moment a dead endless player is put back at the start of their wave. */
  const respawnAt = useRef(0);

  /**
   * Rebuild the chain at the first room of `wave` and drop the player in there.
   * Used when an endless player dies: they restart the WAVE they were on, so the
   * rooms they had cleared inside it are re-run but every earlier wave stands.
   */
  function restartWave(wave: number) {
    holsterWeapon();               // pick the rifle back up
    // Both second winds come back with the wave — they are per attempt at it, not
    // per run, or a long run would spend them in wave 1 and never see them again.
    refills.current = REFILLS;
    reviveAt.current = 0;
    paintRefills();
    const seed = endlessOpts?.seed ?? 1;
    const first = firstRoomOfWave(wave);
    const startZ = zForWaveStart(wave, seed);

    // Drop every enemy and every wall, then lay the wave's opening window fresh.
    // Co-op non-host: appendEnemies is skipped — this client's own sim never
    // owns real enemies (see FpsWorld's coop section), so respawning here
    // must not start populating them; resetEncounter/pruneBehind/appendCover
    // are all still correct to run as-is (resetEncounter's own enemy loop is
    // a no-op against an empty array, and geometry is real either way).
    const isAiAuthorityForRespawn = !coop || coop.isHost;
    sim.pruneBehind(Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY);
    sim.resetEncounter();
    sim.appendCover(entryCap(startZ));
    const rooms = buildChain(first, ENDLESS_LOOKAHEAD, startZ, seed);
    for (const r of rooms) {
      sim.appendCover([...r.walls, ...r.cover]);
      if (isAiAuthorityForRespawn) sim.appendEnemies(r.enemies);
    }
    const last = rooms[rooms.length - 1];
    sim.setBounds(-ENDLESS_HALF_W, ENDLESS_HALF_W, last.zFar, rooms[0].zNear);
    chain.current = {
      rooms, cursor: first, nextIndex: first + rooms.length, nextZ: last.zFar,
      wave, bankedThrough: wave - 1, armed: false, dying: false, over: false,
    };

    const [sx, sz] = spawnPointFor(startZ);
    pos.current.set(sx, EYE_STAND, sz);
    yaw.current = 0; pitch.current = 0;
    rigCell.current = { x: NaN, z: NaN, sunZ: NaN }; // force the travelling rig to re-seat
    setGeoTick((t) => t + 1);
  }
  /** Last grid cell the sun + floor were snapped to, so they only move when the
   *  player actually crosses a cell rather than every single frame. */
  const rigCell = useRef({ x: NaN, z: NaN, sunZ: NaN });

  const START = useMemo<[number, number]>(() => {
    if (!endless) return mission.start;
    const wave = endlessOpts?.startWave ?? 1;
    return spawnPointFor(zForWaveStart(wave, endlessOpts?.seed ?? 1));
  }, [endless, mission.start, endlessOpts?.startWave, endlessOpts?.seed]);

  const sim = useMemo(() => {
    // The op's issued kit (e.g. NVG in the Rift) plus the player's chosen field kit.
    const attachments = [...new Set([...(mission.attachments ?? []), ...(fieldKit ?? [])])];
    const s = new FpsSim({
      loadout: LOADOUT, attachments, ammoId: equippedAmmo, gunMods: equippedMods, enemies: ENEMIES, cover: COLLIDERS, hostage: mission.hostage, respawnEnabled: false, nav: LEVEL?.bounds, searchSecs: LEVEL ? 20 : undefined,
      reserveMags: FINITE_AMMO ? (mission.reserveMags ?? 4) : undefined,
      medkits: FINITE_AMMO ? (mission.medkits ?? 1) : 0,
      engageRange: mission.conditions?.engageRange,
      enemyAccuracy: mission.conditions?.enemyAccuracy,
    });
    s.setAllActive(false); // rooms start dormant; breaching each one wakes it
    if (endless) {
      const seed = endlessOpts?.seed ?? 1;
      const wave = endlessOpts?.startWave ?? 1;
      const first = firstRoomOfWave(wave);
      const startZ = zForWaveStart(wave, seed);
      // Lay the opening window: the room you start in plus a lookahead, so the next
      // room's walls are already there to shoot through the doorway at.
      const rooms = buildChain(first, ENDLESS_LOOKAHEAD, startZ, seed);
      s.appendCover(entryCap(startZ)); // seal the way back — the chain is one-way
      for (const r of rooms) {
        s.appendCover([...r.walls, ...r.cover]);
        s.appendEnemies(r.enemies);
      }
      // The first room stays DORMANT. Every other room in the chain is woken by the
      // player breaching it; spawning into a live firefight was the one place that
      // rule didn't hold, and it made the opening seconds unfair. It arms on the
      // player's first step instead (see the endless flow), so the run starts on
      // their move rather than shooting at them before they've read the room.
      const last = rooms[rooms.length - 1];
      // The enemy safety box defaults to a fixed square around the ORIGIN. Out here
      // that would yank every moving enemy back toward the start of the chain and
      // leave it firing from inside a wall, so it tracks the live window instead.
      s.setBounds(-ENDLESS_HALF_W, ENDLESS_HALF_W, last.zFar, rooms[0].zNear);
      chain.current = {
        rooms, cursor: first, nextIndex: first + rooms.length, nextZ: last.zFar,
        wave, bankedThrough: wave - 1, armed: false, dying: false, over: false,
      };
    }
    return s;
  }, []);

  // What actually gets drawn. Authored missions are static; an endless run redraws
  // from the live chain window each time geometry is streamed in or out (geoTick).
  const LEVEL_WALLS = useMemo(() => {
    if (!endless) return mission.walls;
    const out = [...entryCap(zForWaveStart(endlessOpts?.startWave ?? 1, endlessOpts?.seed ?? 1))];
    for (const r of chain.current.rooms) out.push(...r.walls);
    return out;
  }, [endless, mission.walls, geoTick, endlessOpts?.startWave, endlessOpts?.seed]);
  const LEVEL_COVER = useMemo(() => {
    if (!endless) return mission.cover;
    const out: typeof mission.cover = [];
    for (const r of chain.current.rooms) out.push(...r.cover);
    return out;
  }, [endless, mission.cover, geoTick]);

  // ── Player look / motion state (imperative — no React churn per frame) ──
  const yaw = useRef(0);
  const pitch = useRef(0);
  const recoilP = useRef(0);
  const recoilY = useRef(0);
  const pos = useRef(new THREE.Vector3(START[0], EYE_STAND, START[1]));
  const adsCur = useRef(0);
  const leanCur = useRef(0);
  const crouchCur = useRef(0);
  const bobPhase = useRef(0);
  const footstepAt = useRef(0);
  const swayT = useRef(0); // bodycam handheld drift (slice 7)

  // ── Slice 7 surfaces: Poly Haven CC0 PBR. The `repeat` passed here no longer
  // decides anything — the materials below are triplanar and derive their texture
  // coordinates from world position — but it is still what a non-triplanar reader
  // of these maps would get, so it stays truthful.
  const floorMaps = usePbr('burned_ground_01', [12, 20]);
  const brickMaps = usePbr('broken_brick_wall', [7, 1.6]);
  const plasterMaps = usePbr('damaged_plaster', [4, 1.4]);
  const plankMaps = usePbr('black_painted_planks', [1, 1]);

  /**
   * World-space materials for the level shell.
   *
   * Every wall and crate is the same UNIT_BOX scaled to size, so UV texturing gave
   * each one the whole texture across its face however big it was: brick smeared
   * six times wider on a long wall than on the crate next to it, mortar lines that
   * changed thickness per mesh. Triplanar sizes the texture in METRES instead, so a
   * `metresPerTile` slab of brick is the same slab of brick everywhere.
   *
   * Sizes below match what the old repeats worked out to on a typical wall, so the
   * surfaces read at the density they were art-directed at — they are just
   * consistent now. One material each, shared by every mesh of that surface, which
   * also retires the per-wall <meshStandardMaterial> the JSX used to allocate.
   */
  // `minimal` compiles the two extra octaves OUT of the shell shaders.
  //
  // Every wall, pillar and the floor is triplanar, and the detail + macro octaves are
  // one texture fetch each on top of the base map, roughness and normal — so ~5 fetches
  // per fragment across the surfaces that cover most of the screen. They exist to stop
  // large flat faces reading as tiled, which is a fair trade on a machine that can
  // afford it and a bad one on a phone that cannot hold framerate at all. Passing 0
  // does not merely zero their weight: `detail > 0` / `macro > 0` gate the shader
  // defines, so the sampling code is never emitted and the fetches genuinely disappear
  // rather than being multiplied by zero.
  // Memoised on `minimal` alone: a fresh object literal here would change identity on
  // every render, busting the shellMaterials memo below and rebuilding five triplanar
  // materials (and recompiling their shaders) continuously — far worse than the
  // octaves it is trying to save.
  const octaves = useMemo(
    () => (minimal ? { detail: 0, detailAmount: 0, macro: 0, macroAmount: 0 } : null),
    [minimal],
  );
  const shellMaterials = useMemo(() => ({
    floor: makeTriplanarMaterial(floorMaps, { color: theme.floorTint, roughness: 1, metalness: 0 }, { metresPerTile: 1.9, detail: 9.7, detailAmount: 0.6, macro: 0.11, macroAmount: 0.4, ...octaves }),
    brick: makeTriplanarMaterial(brickMaps, { color: theme.wallTint, roughness: 1, metalness: 0 }, { metresPerTile: 1.7, detail: 9.3, detailAmount: 0.62, macro: 0.13, macroAmount: 0.3, ...octaves }),
    plaster: makeTriplanarMaterial(plasterMaps, { color: theme.wallTint, roughness: 1, metalness: 0 }, { metresPerTile: 1.8, detail: 8.7, detailAmount: 0.68, macro: 0.13, macroAmount: 0.32, ...octaves }),
    // Cover boxes are the surface you are most often pressed right up against —
    // the compound's pillars are these — so the detail octave bites hardest here
    // and the base tile is small, which puts the boards at a believable width
    // instead of one 1.2m board per pillar face.
    //
    // NOT the plank maps, despite "scorched planking" being the right idea.
    // `black_painted_planks_diff` averages 27/255 (0.106 sRGB, ~0.8% LINEAR
    // reflectance once decoded). The brick walls that read correctly sit at 10%.
    // `color` MULTIPLIES the map, so a mid-brown tint took cover to roughly 2%,
    // darker than coal — which is why every cover box rendered as a flat black
    // slab in the middle of frame. Tinting cannot rescue it either: matching the
    // walls needs a gain around 12x, which clips the pale grout lines to white
    // streaks. A near-black albedo is simply the wrong base for a surface that
    // has to read.
    //
    // Plaster instead (133/255, the brightest set we have) tinted to weathered
    // timber-brown, at a third of the wall's tile size. Reads as the mud-plastered
    // board barricade a burned village would actually throw up, and the tile scale
    // plus tint keep it distinct from the plaster DIVIDERS at 1.8 — which matters
    // for gameplay, not just looks: cover you can hide behind must never read as
    // wall you cannot.
    plank: makeTriplanarMaterial(plasterMaps, { color: '#8a6f4e', roughness: 0.95, metalness: 0.05 }, { metresPerTile: 0.6, blend: true, detail: 8.3, detailAmount: 0.85, detailFade: [9, 20], macro: 0.16, macroAmount: 0.26, ...octaves }),
    // The cap on top of a wall. Was a flat grey box, which read as the graybox it
    // was; concrete at a coarse tile makes it a poured coping instead.
    coping: makeTriplanarMaterial(plasterMaps, { color: '#59565e', roughness: 0.9, metalness: 0 }, { metresPerTile: 1.3, detail: 9.1, detailAmount: 0.5, ...octaves }),
  }), [floorMaps, brickMaps, plasterMaps, plankMaps, theme.floorTint, theme.wallTint, octaves]);

  /**
   * Set-dressing surfaces.
   *
   * The clutter was the last thing in the compound still wearing flat vertex
   * colours: barrels, crates, sandbags and rubble were untextured plastic sat in
   * a scene where everything around them is PBR, which is most of why the corner
   * of a room reads as a prototype. They reuse the four map sets the shell already
   * has loaded — no extra downloads — retinted and retiled per material.
   *
   * `blend` on every one of them, unlike the shell. Props are placed at a RANDOM
   * yaw (and the barrels are cylinders), so there is no axis for hard projection to
   * pick that is actually perpendicular to the face: at 45° it stretches the texture
   * by √2 and smears visibly around the curve of a drum. Three fetches is the right
   * price on eleven small props; it would not be on every wall in the level.
   */
  const propMaterials = useMemo(() => ({
    // Two drum finishes so a cluster of three isn't a colour-matched set. World-space
    // texturing already gives each barrel a different patch of map; this varies the
    // tint on top of that.
    barrelA: makeTriplanarMaterial(plankMaps, { color: '#6d5a46', roughness: 0.5, metalness: 0.45 }, { metresPerTile: 0.7, blend: true, detail: 7.7, detailAmount: 0.7 }),
    barrelB: makeTriplanarMaterial(plankMaps, { color: '#54604c', roughness: 0.55, metalness: 0.4 }, { metresPerTile: 0.7, blend: true, detail: 7.7, detailAmount: 0.7 }),
    // Off the plank maps for the same reason the cover boxes are (see shellMaterials
    // above): a 0.8%-reflectance albedo made these read as black cubes rather than
    // the timber crates the tint is asking for. The drums above keep the plank maps —
    // they are metal at metalness 0.45, so the environment map carries them on
    // specular and a dark albedo is correct for an oil drum.
    crate: makeTriplanarMaterial(plasterMaps, { color: '#9c7a4c', roughness: 0.9, metalness: 0.02 }, { metresPerTile: 0.5, blend: true, detail: 7.3, detailAmount: 0.75 }),
    sandbag: makeTriplanarMaterial(plasterMaps, { color: '#a2946c', roughness: 1, metalness: 0 }, { metresPerTile: 0.4, blend: true, detail: 7.1, detailAmount: 0.8 }),
    rubble: makeTriplanarMaterial(brickMaps, { color: '#7c7880', roughness: 0.95, metalness: 0.03 }, { metresPerTile: 0.45, blend: true, detail: 7.7, detailAmount: 0.7 }),
  }), [plankMaps, plasterMaps, brickMaps]);

  useEffect(() => () => {
    for (const m of Object.values(shellMaterials)) m.dispose();
  }, [shellMaterials]);
  useEffect(() => () => {
    for (const m of Object.values(propMaterials)) m.dispose();
  }, [propMaterials]);

  // ── Image-based lighting ──
  //
  // Generated from this zone's own sky rather than loaded (see zoneEnvironment.ts
  // for why an HDRI is the wrong answer here). Without this, every `envMapIntensity`
  // in gunModels/GunMesh and ItemMesh multiplies a black environment and the
  // viewmodel — the thing on screen 100% of the time — reads as grey plastic
  // instead of steel.
  //
  // Kept on at every quality tier, `minimal` included: an environment map is a
  // texture lookup already in the standard material shader, so unlike the point
  // lights it costs nothing per pixel and cannot push a struggling phone further
  // down the degrade path.
  //
  // Keyed on the theme's PRIMITIVE fields, never the theme object. `themeForMission`
  // builds a fresh object (and a fresh `hemi` array) on every call for any op that
  // isn't the first of its zone, so a dep on `theme` would rebuild and re-prefilter
  // a cubemap every render. Same reason the triplanar memos above key on
  // `theme.floorTint` / `theme.wallTint`.
  const envParams = useMemo(() => ({
    skyTop: theme.sky.top,
    skyBottom: theme.sky.bottom,
    sunColor: theme.sun.color,
    sunIntensity: theme.sun.intensity,
    groundColor: theme.hemi[1],
    floorTint: theme.floorTint,
  }), [theme.sky.top, theme.sky.bottom, theme.sun.color, theme.sun.intensity, theme.hemi[1], theme.floorTint]);

  useEffect(() => {
    const target = buildZoneEnvironment(gl, envParams);
    scene.environment = target.texture;
    scene.environmentIntensity = ENV_INTENSITY;
    return () => {
      scene.environment = null;
      target.dispose();
    };
  }, [gl, scene, envParams]);

  // ── Impact VFX: sparks, dust, debris and the holes they leave behind ──
  const impactMaps = useImpactTextures();
  const impactFx = useMemo(
    // Same tier that drops the postprocessing stack and the set dressing: half the
    // particles, shorter-lived and fewer decals.
    () => new ImpactFX(impactMaps, { quality: !plan.particles || lowSpec ? 'lean' : 'full' }),
    [impactMaps, plan.particles, lowSpec],
  );
  useEffect(() => () => impactFx.dispose(), [impactFx]);
  const caOffset = useMemo(() => new THREE.Vector2(lowSpec ? 0.0003 : 0.0007, lowSpec ? 0.0004 : 0.0009), [lowSpec]);
  const heartbeatAt = useRef(0);
  /** Co-op Endless (party mode), host only — last time sim.snapshot() went
   *  out over the relay. Throttled well below frame rate on purpose: a
   *  handful of enemies/combatants is small either way, but there's no
   *  reason to broadcast 60x/sec what a lerp on the receiving end already
   *  smooths between ticks. */
  const lastCoopBroadcastAt = useRef(0);
  /** Co-op Endless, non-host only — this client's own last known REAL hp
   *  (from the host's broadcast `combatants` entry, not the local sim's
   *  always-full one), so a frame-to-frame drop can be detected and turned
   *  into a camera reaction. Null until the first broadcast arrives. */
  const lastCoopHp = useRef<number | null>(null);
  const downAt = useRef(-99);
  /**
   * Second wind. Going down doesn't end the attempt while you have one of these:
   * you get back up where you fell, at full health, with a moment of grace.
   *
   * One per op — a single mistake shouldn't cost you a whole clear. Two per endless
   * wave, because a wave is much longer and losing it to one unlucky corner is a
   * worse trade there.
   *
   * NONE in survival / the Gauntlet: that mode already sells a revive for G$, and
   * handing out free ones would undercut one of the few real sinks in the economy.
   *
   * A refilled death is NOT reported to `onDeath`. In campaign that call is what
   * writes the loss on-chain, and in endless it is what tells the page the run has
   * ENDED (Seasonal submits the score on it) — neither is true of a death you got
   * back up from. Only the final one counts.
   */
  const REFILLS = survival ? 0 : endless ? 2 : 1;
  const refills = useRef(REFILLS);
  /** Sim-time at which a downed player stands back up; 0 = no revive pending. */
  const reviveAt = useRef(0);
  const refillsShown = useRef(-1);   // last count painted to the HUD
  const vignetteHit = useRef(0); // decaying red damage-flash intensity
  const bossFlash = useRef(0);   // decaying pulse when a boss crosses a phase threshold
  // getting shot knocks the camera about (slice 8): stagger + shake
  const staggerP = useRef(0);
  const staggerY = useRef(0);
  const shake = useRef(0);
  const shoveX = useRef(0); // knocked off the line you were shot from
  const shoveZ = useRef(0);
  // mission flow (slice 4)
  const objective = useRef(0);
  const briefingUntil = useRef(3.5);
  const completeAt = useRef(-99);
  // varied objectives (A2): defend hold timer + reinforcement cadence
  const holdProgress = useRef(0);       // sim-seconds held on a defend point
  const wantHeal = useRef(false);
  const wantInspect = useRef(false);
  /** The quality tier in force, for the dev readout (props change without a remount). */
  const tierRef = useRef({ minimal, lightFx, plan });
  tierRef.current = { minimal, lightFx, plan };
  /** Toggle-to-interact: E starts a hold that runs until it completes, E again, or the target changes. */
  const interactLatch = useRef(false);
  /** Toggle-mode aim and crouch (Settings → Controls), latched by their keys. */
  const aimLatch = useRef(false);
  const crouchLatch = useRef(false);
  /** The player's key bindings, as code → actions; rebuilt when the binds change. */
  const bindCache = useRef<{ binds: Binds; byCode: Map<string, Action[]> }>({ binds: DEFAULT_BINDS, byCode: actionsByCode(DEFAULT_BINDS) });
  const bindsNow = () => {
    const b = settingsRef?.current.controls.binds ?? DEFAULT_BINDS;
    if (bindCache.current.binds !== b) bindCache.current = { binds: b, byCode: actionsByCode(b) };
    return bindCache.current;
  };
  /** Whether any key bound to an action is held. */
  const actHeld = (a: Action) => {
    const [x, y] = bindsNow().binds[a];
    return (!!x && keys.current.has(x)) || (!!y && keys.current.has(y));
  };
  const latchTarget = useRef<string | null>(null);
  const fieldToast = useRef<{ text: string; until: number; color: string }>({ text: '', until: 0, color: '#e9edf2' });
  const lastFieldHtml = useRef('');
  const lastBeep = useRef(-1);
  // Audio cues that fire once per run, and where each guard last was (for footsteps).
  const alertedRef = useRef(false);
  const finalAlarmRef = useRef(false);
  const enemyStepRef = useRef(new Map<number, { x: number; z: number; t: number }>());
  const lastHeartbeat = useRef(0);
  /** Guards' weapons still falling: field item id → its tumble physics. */
  const enemyDrops = useRef(new Map<string, DroppedWeapon>());
  const extractedLabel = useRef('');
  const lastReinforceAt = useRef(0);    // sim-time of the last reinforcement drop
  const hostageRef = useRef<THREE.Group>(null);
  // ── Survival wave state ──
  const survInit = useRef(false);
  const survWave = useRef(0);              // current wave (0 before the first)
  const survState = useRef<'intermission' | 'active'>('intermission');
  const survNextAt = useRef(0);            // sim-time the next wave begins
  const survOver = useRef(false);          // the run has ended (player down)
  const advanced = useRef(false);
  const completeWallAt = useRef(0);
  const waypointRef = useRef<THREE.Group>(null);
  // earn loop (slice 5)
  const careerXp = useRef(0);
  const xpPopHead = useRef(0);
  // story presence (slice 6)
  const storyFired = useRef<Set<PresenceTrigger>>(new Set());
  const voQueue = useRef<PresenceLine[]>([]);
  const voUntil = useRef(0);
  const voStartedAt = useRef(0);
  const voCurrentId = useRef<string | null>(null);

  const keys = useRef<Set<string>>(new Set());
  const mouseBtn = useRef<Set<number>>(new Set());
  const mouseDX = useRef(0);
  const mouseDY = useRef(0);
  const lookAccum = useRef({ x: 0, y: 0 }); // touch-drag buffer, eased out for smooth aim
  const wantReload = useRef(false);
  const cycleFireMode = useRef(false);
  const lockTarget = useRef<number | null>(null); // id of the locked-on enemy, or null
  const lockPulse = useRef(0); // brief pop on the reticle the frame a lock is acquired
  const locked = useRef(false);

  // ── Scene objects ──
  const vmRef = useRef<THREE.Group>(null);
  const swapRaise = useRef(0);          // 1 → 0 dip when a weapon is raised
  const wantSlot = useRef<number | null>(null); // 1/2 keys pick a slot
  const wantSwap = useRef(false);       // the swap key cycles
  // ── Attachments (toggleable kit) ──
  const wantToggle = useRef<Attachment | null>(null);
  const nvgAmt = useRef(0);             // 0..1 night-vision blend (exposure + green)
  const flashLight = useMemo(() => new THREE.SpotLight(0xeaf2ff, 0, 34, 0.5, 0.5, 1.1), []);
  const laserLine = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xd83228, transparent: true, opacity: 0.5, depthTest: false }));
    l.frustumCulled = false; l.visible = false; l.renderOrder = 998;
    return l;
  }, []);
  const laserDot = useMemo(() => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff4030, depthTest: false }));
    m.frustumCulled = false; m.visible = false; m.renderOrder = 999;
    return m;
  }, []);
  const muzzleLight = useRef<THREE.PointLight>(null);
  const flashRef = useRef<THREE.Mesh>(null);
  const flashUntil = useRef(0);

  // The mounted enemy rigs. An authored mission has one per enemy it declares; endless
  // declares none (they stream in per room) and gets a standing pool instead, which the
  // frame loop maps live sim enemies onto by index.
  const ENEMY_SLOTS = useMemo(
    () => (endless
      ? Array.from({ length: ENDLESS_ENEMY_POOL }, () => ({ pos: [0, 0] as [number, number] }))
      : ENEMIES),
    [endless, ENEMIES],
  );
  const dummyRefs = useRef<Array<THREE.Group | null>>([]);
  const dummyFlash = useRef<number[]>(ENEMY_SLOTS.map(() => 0));
  const rigApis = useRef<Array<OperatorApi | null>>([]);
  // Ground covered by each enemy since its last footfall, and where it was last
  // sampled — a puff of dust is spent per STRIDE walked (see the rig loop).
  const enemyStepDist = useRef<number[]>(ENEMY_SLOTS.map(() => 0));
  const enemyStepPos = useRef<[number, number][]>(ENEMY_SLOTS.map((e) => [e.pos[0], e.pos[1]]));

  // Co-op Endless (party mode) — a small fixed pool of teammate rigs,
  // repositioned each frame from the coop section of the loop below.
  // Unlike ENEMY_SLOTS this is never resized live: MAX_PARTY_SIZE - 1 is
  // the most teammates that can ever exist (the local player is the +1,
  // never a slot of its own — it's the first-person view).
  const teammateRefs = useRef<Array<THREE.Group | null>>([]);
  const teammateRigApis = useRef<Array<OperatorApi | null>>([]);
  const teammateStepDist = useRef<number[]>(Array.from({ length: MAX_PARTY_SIZE - 1 }, () => 0));
  const teammateStepPos = useRef<[number, number][]>(Array.from({ length: MAX_PARTY_SIZE - 1 }, () => [0, 0]));
  /** Host only — per-teammate remote-fire cooldown, wallet -> sim.time. */
  const teammateNextShotAt = useRef<Map<string, number>>(new Map());

  // Rounds you can SEE. Slow enough to read (a real bullet would be invisible),
  // fast enough to feel lethal. Yours fly out; theirs come at you.
  const BULLETS = 28;
  const PLAYER_BULLET_SPEED = 95; // m/s
  const ENEMY_BULLET_SPEED = 140; // fast: it snaps to the impact, never lingers in your face
  const bulletRefs = useRef<Array<THREE.Mesh | null>>([]);
  const bulletHead = useRef(0);
  const bullets = useRef(Array.from({ length: 28 }, () => ({
    // `normal` is the face the round is flying into, carried along so the burst on
    // arrival can throw its sparks back out of the wall rather than into it. Null
    // when the round is on its way to a body.
    active: false, t: 0, dur: 0, hit: false, normal: null as Vec3 | null,
    from: new THREE.Vector3(), to: new THREE.Vector3(),
  })));

  // The LINE of the shot: muzzle -> whatever it struck. Held briefly so a round
  // fired straight at your face still reads as a line and not a dot.
  const BEAMS = 16;
  const beamRefs = useRef<Array<THREE.Mesh | null>>([]);
  const beamUntil = useRef<number[]>(Array(16).fill(0));
  const beamHead = useRef(0);

  // (Impacts themselves are ImpactFX — a pooled particle + decal system, built above.)

  // enemy muzzle flashes (a bright, visible "they fired" pop) + a shared light
  const EFLASH = 6;
  const eFlashRefs = useRef<Array<THREE.Mesh | null>>([]);
  const eFlashUntil = useRef<number[]>(Array(EFLASH).fill(0));
  const eFlashHead = useRef(0);
  const eLight = useRef<THREE.PointLight>(null);

  // Build ALL five viewmodel guns once and hang them off the camera; each frame
  // only the active weapon is shown (see the transform block below), so buying a
  // better gun changes what you actually hold. Positioned to the camera each
  // frame so we don't depend on camera-child rendering.
  const gunProtos = useGunPrototypes();
  const gunMeshes = useMemo(() => {
    const out = {} as Record<GunId, THREE.Group>;
    // ALL guns, not just the GLB-backed ones. Iterating the loading list here
    // left every seasonal weapon without a viewmodel, and the muzzle lookup
    // below dereferences it immediately.
    for (const id of ALL_GUN_IDS) {
      const g = gunProtos[id].clone(true);
      // The viewmodel inherits the CAMERA's orientation, and a camera looks down
      // its own -Z. The barrel is +Z, so unturned it fires into your face.
      g.rotateY(Math.PI);
      g.scale.setScalar(WEAPON_VIEW[id].scale);
      // Hands go on the GUN, not on the viewmodel group. Everything the weapon does
      // — sights, recoil kick, the swap dip, the pullback against a wall — is applied
      // to the viewmodel or to this mesh, and a hand parented here inherits all of it
      // and can never drift off the grip. On the viewmodel group it would have to
      // re-implement each of those, and would break the next time ADS was retuned.
      //
      // Built BEFORE it is attached, and deliberately on its own line: the grips are
      // measured off the weapon's own geometry, so hands already in the hierarchy
      // would be measured as part of the weapon.
      const hands = buildViewmodelHands(id, g, GUN_LENGTH[id]);
      g.add(hands);
      out[id] = g;
    }
    return out;
  }, [gunProtos]);
  /**
   * A second set of clones, in WORLD space: when you go down, the weapon leaves
   * your hands and hits the deck in front of you.
   *
   * Clones rather than re-parenting the viewmodel's own mesh. Re-parenting is one
   * missed restart path away from a run where you hold nothing at all, and there
   * are several ways an op can restart (death timeout, pause menu, wave reset).
   * A clone costs a node hierarchy — geometry and materials are shared by
   * THREE.Object3D.clone — and cannot break the gun you play with.
   *
   * No rotateY(PI) here, unlike the viewmodel: that turn exists to cancel out the
   * CAMERA's -Z facing, and a weapon lying on the floor is not parented to a
   * camera.
   */
  const dropMeshes = useMemo(() => {
    const out = {} as Record<GunId, THREE.Group>;
    for (const id of ALL_GUN_IDS) {
      const g = gunProtos[id].clone(true);
      g.scale.setScalar(WEAPON_VIEW[id].scale);
      g.visible = false;
      // castShadow is per-MESH, not per-group: setting it on the clone's root does
      // nothing. A gun on the deck with no shadow floats.
      g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
      out[id] = g;
    }
    return out;
  }, [gunProtos]);

  // The falling weapon's physics (engine/vfx/DroppedWeapon). `active` also drives
  // whether the viewmodel is drawn, so the gun is never in two places at once.
  const dropPhysics = useRef(new DroppedWeapon({ restY: DROP_REST_Y }));
  const dropId = useRef<GunId | null>(null);

  // The active weapon's muzzle (tracers / flash / laser spawn here); repointed on
  // a weapon switch in the frame loop.
  // Falls back to the rifle rather than dereferencing whatever the player has
  // equipped. A weapon with no viewmodel is a content gap; taking the entire
  // route down with "undefined is not an object" is a bug, and this line is the
  // one that did it for anyone holding a seasonal gun.
  const startMesh = gunMeshes[LOADOUT[0]] ?? gunMeshes.assault_rifle;
  const muzzleRef = useRef<THREE.Object3D>(
    startMesh.getObjectByName('muzzle') ?? startMesh,
  );

  useEffect(() => {
    const p = camera as THREE.PerspectiveCamera;
    p.near = 0.01;
    p.far = 320;
    p.fov = 55;
    p.rotation.order = 'YXZ';
    p.updateProjectionMatrix();
  }, [camera]);

  // ── Input ──
  useEffect(() => {
    const canvas = gl.domElement;
    // Pointer lock is OPTIONAL — only for players who want mouse-look. It is
    // requested on a deliberate click (a trusted gesture), never on keydown, so
    // keyboard-only play (arrow keys aim) never triggers a lock error.
    const wantLock = () => {
      if (locked.current || document.pointerLockElement === canvas) return;
      try {
        const p: unknown = canvas.requestPointerLock?.();
        if (p && typeof (p as { catch?: unknown }).catch === 'function') (p as Promise<void>).catch(() => {});
      } catch { /* pointer lock unavailable (headless / blocked) — arrow keys still aim */ }
    };
    const down = (e: KeyboardEvent) => {
      // Don't swallow keys aimed at a control the player is actually using. Arrows and
      // Space and Tab are blocked here so they aim and fire instead of scrolling the
      // page — but that block is global, so it also disabled every keyboard-operated
      // control in the pause menu. The sensitivity slider is arrow-driven, and Tab is
      // the only way to reach these buttons without a mouse.
      //
      // Keys are still RECORDED below rather than returned on: a HUD button can hold
      // focus after a click, and dropping input entirely in that state would silently
      // stop movement working mid-fight. Only the preventDefault is skipped.
      const t = e.target as HTMLElement | null;
      const onControl = !!t && (
        t.tagName === 'INPUT' || t.tagName === 'BUTTON' ||
        t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable
      );
      const acts = bindsNow().byCode.get(e.code) ?? [];
      // Bound keys never reach the page (a bound ' or / would open Firefox's quick find).
      if (!onControl && (acts.length || ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code))) e.preventDefault();
      if (e.repeat) return;
      keys.current.add(e.code);
      const cs = settingsRef?.current;
      for (const a of acts) {
        switch (a) {
          case 'reload': wantReload.current = true; break;
          case 'heal': wantHeal.current = true; break;          // apply a field dressing
          case 'interact': if (cs?.access.toggleInteract) interactLatch.current = !interactLatch.current; break; // toggle mode
          case 'inspect': if (!inspectingRef?.current) wantInspect.current = true; break; // inspect what you're looking at
          case 'fireMode': cycleFireMode.current = true; break; // semi/burst/auto
          case 'primary': wantSlot.current = 0; break;
          case 'secondary': wantSlot.current = 1; break;
          case 'swap': wantSwap.current = true; break;
          case 'nvg': wantToggle.current = 'nvg'; break;
          case 'light': wantToggle.current = 'light'; break;
          case 'laser': wantToggle.current = 'laser'; break;
          case 'optic': wantToggle.current = 'optic'; break;
          case 'target': if (cs?.access.targetLock !== false) controls.current.lockCycle = true; break; // snap-lock the nearest enemy (cycle)
          case 'aim': if (cs?.controls.aim === 'toggle') aimLatch.current = !aimLatch.current; break;
          case 'crouch': if (cs?.controls.crouch === 'toggle') crouchLatch.current = !crouchLatch.current; break;
          default: break;
        }
      }
      audio.unlock();
      // Capture the mouse on the first keypress so MOVING the mouse aims (up/down
      // included) without needing a click. Guarded, so headless never throws.
      wantLock();
    };
    const up = (e: KeyboardEvent) => keys.current.delete(e.code);
    const mdown = (e: MouseEvent) => {
      mouseBtn.current.add(e.button);
      if (e.button === 2 && settingsRef?.current.controls.aim === 'toggle') aimLatch.current = !aimLatch.current;
      audio.unlock(); wantLock();
    };
    const mup = (e: MouseEvent) => mouseBtn.current.delete(e.button);
    const move = (e: MouseEvent) => {
      if (document.pointerLockElement === canvas) {
        // clamp per event — pointer-lock recenter jumps can spike movementX/Y huge
        mouseDX.current += Math.max(-MOUSE_MAX_STEP, Math.min(MOUSE_MAX_STEP, e.movementX));
        mouseDY.current += Math.max(-MOUSE_MAX_STEP, Math.min(MOUSE_MAX_STEP, e.movementY));
      }
    };
    const lockChange = () => { locked.current = document.pointerLockElement === canvas; };
    const noMenu = (e: Event) => e.preventDefault();

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('mousedown', mdown);
    window.addEventListener('mouseup', mup);
    window.addEventListener('mousemove', move);
    document.addEventListener('pointerlockchange', lockChange);
    canvas.addEventListener('contextmenu', noMenu);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('mousedown', mdown);
      window.removeEventListener('mouseup', mup);
      window.removeEventListener('mousemove', move);
      document.removeEventListener('pointerlockchange', lockChange);
      canvas.removeEventListener('contextmenu', noMenu);
    };
  }, [gl]);

  // A fresh mount (new mission / retry) must start with no stale overlays from
  // the previous run showing through (the "MISSION COMPLETE stuck on" bug).
  useEffect(() => {
    for (const el of [hud.current.complete, hud.current.survEnd, hud.current.down, hud.current.waveDone]) {
      if (el) el.style.opacity = '0';
    }
    if (hud.current.survEnd) hud.current.survEnd.style.pointerEvents = 'none';
  }, [hud]);

  // A directional light aims at its `target` object, which three.js defaults to a
  // detached one at the origin — so the aim point can only be moved by assigning our
  // own. Endless needs that to walk the shadow frustum along with the player; every
  // other mode keeps the default origin aim, which is what the authored ops expect.
  useEffect(() => {
    // A structured level aims the sun (and its shadow box) at the level's centre.
    if (LEVEL && sunRef.current && sunTargetRef.current) {
      sunTargetRef.current.position.set(levelCx, 0, levelCz);
      sunTargetRef.current.updateMatrixWorld();
      sunRef.current.target = sunTargetRef.current;
      return;
    }
    if (!endless || !sunRef.current || !sunTargetRef.current) return;
    sunRef.current.target = sunTargetRef.current;
    sunRef.current.updateMatrixWorld();
  }, [endless]);

  // Load this op's ambience bed (retunes the room tone + zone drone; the mission
  // remounts per op, so this fires whenever the zone changes).
  useEffect(() => { audio.setZone(ambienceKey(mission.zone, mission.level)); }, [audio, mission.zone, mission.level]);
  // The level's roofs: indoors and outdoors sound different (reverb follows the listener).
  useEffect(() => { audio.setLevel(LEVEL); return () => audio.setLevel(null); }, [audio, LEVEL]);
  // The refinery runs while you fight in it.
  useEffect(() => { audio.setMachinery(mission.level === 'cinder_yard'); return () => audio.setMachinery(false); }, [audio, mission.level]);

  // ── Probe hooks (headless verification; development builds only, see DEV_HOOKS) ──
  useEffect(() => {
    if (!DEV_HOOKS) return;
    const w = window as unknown as Record<string, unknown>;
    w.__czField = () => ({
      kind: FIELD.spec.kind, phase: FIELD.exfilPhase, progress: FIELD.exfilProgress, carried: FIELD.carried.slice(), planted: FIELD.planted.slice(),
      detonated: FIELD.detonated, target: FIELD.target?.id ?? null, hold: FIELD.hold, record: FIELD.record(),
      exfil: FIELD.spec.exfil ? { pos: FIELD.spec.exfil.pos, radius: FIELD.spec.exfil.radius, mode: FIELD.spec.exfil.mode } : null,
      items: [...FIELD.items.values()].map((i) => ({ id: i.id, kind: i.kind, pos: i.pos, state: i.state, rounds: i.rounds, medkits: i.medkits, units: i.units })),
      reserve: sim.reserve, medkits: sim.medkits, ammo: sim.ammo, speed: FIELD.speedMult,
    });
    w.__czState = () => sim.snapshot();
    w.__czProps = () => dressingFor(mission); // set-dressing placements (headless visual check)
    w.__czKillAll = () => sim.debugKillAll();
    // Endless probe: clear ONLY the room the player is standing in, leaving the
    // dormant rooms ahead intact so a breach still has something to wake.
    w.__czKillRoom = () => sim.debugKillRoom(chain.current.cursor + 1);
    w.__czKillPlayer = () => sim.debugKillPlayer();
    // Read-only: the mission's objectives, for scripted demo runs.
    w.__czObjectives = () => OBJECTIVES.map((o) => ({ kind: o.kind, text: o.text, pos: o.pos, room: o.room, holdSecs: o.holdSecs, item: o.item }));
    w.__czAim = () => ({ pitch: pitch.current, yaw: yaw.current });
    w.__czAudio = () => audio.stats();
    // `alive` / `refills` / `reviving` make the second wind observable: a mission
    // RESTART and a second wind both put health back to full, so the health bar
    // alone cannot tell you which one happened.
    w.__czMission = () => ({ objective: objective.current, total: OBJECTIVES.length, complete: completeAt.current > 0, briefing: sim.time < briefingUntil.current, survival, gauntlet: !!mission.gauntlet, wave: survWave.current, waveState: survState.current, survOver: survOver.current, kills: sim.snapshot().stats.kills, simTime: sim.time, alive: sim.snapshot().playerAlive, hp: sim.snapshot().playerHp, refills: refills.current, reviving: reviveAt.current > 0, weaponDown: dropPhysics.current.active, weaponLanded: dropPhysics.current.landed });
    // Endless chain state, for headless verification of the streamed room chain:
    // which room the player is in, how many are live, and whether the room is clear.
    w.__czEndless = () => {
      const c = chain.current;
      const cur = c.rooms.find((r) => r.index === c.cursor);
      return {
        endless, cursor: c.cursor, wave: c.wave, bankedThrough: c.bankedThrough, armed: c.armed,
        roomsLive: c.rooms.length, nextIndex: c.nextIndex, over: c.over,
        aliveInRoom: cur ? sim.roomAlive(cur.index + 1) : 0,
        aliveTotal: sim.aliveCount(),
        colliders: sim.getCover().length,
        exit: cur ? cur.exitPos : null,
        curZFar: cur ? cur.zFar : null,
        curWavesEnd: cur ? cur.wavesEnd : null,
        indices: c.rooms.map((r) => r.index),
        ticks: endlessTicks.current,
        // Rig-pool health. An endless mission declares no enemies, so if the pool were
        // ever sized from the mission (as it originally was) the sim would have enemies
        // shooting the player with no body rendered anywhere. `rigsMounted` must always
        // cover `aliveTotal`.
        rigsMounted: dummyRefs.current.filter(Boolean).length,
        rigsVisible: dummyRefs.current.filter((g) => g && g.visible).length,
        // Hardware-independent load proxies: what the GPU is actually asked to do.
        drawCalls: gl.info.render.calls,
        triangles: gl.info.render.triangles,
        programs: gl.info.programs?.length ?? 0,
        geometries: gl.info.memory.geometries,
        textures: gl.info.memory.textures,
        z: pos.current.z,
        kills: sim.snapshot().stats.kills,
      };
    };
    w.__czWarp = (x: number, z: number) => { pos.current.set(x, EYE_STAND, z); };
    // A walkable route from the player to a point (the autopilot follows it at walking pace).
    w.__czPath = (x: number, z: number) => sim.pathBetween(pos.current.x, pos.current.z, x, z);
    w.__czLook = (y: number, p = 0) => { yaw.current = y; pitch.current = p; };
    w.__czWakeAll = () => { sim.setRoomActive(1, true); sim.setRoomActive(2, true); };
    w.__czSkipBriefing = () => { briefingUntil.current = 0; };
    w.__czXp = () => ({ careerXp: careerXp.current, rank: rankForXp(careerXp.current), intoRank: xpIntoRank(careerXp.current) });
    w.__czStory = () => ({ fired: [...storyFired.current], queued: voQueue.current.length });
    w.__czRig = () => rigApis.current[0]?.debug() ?? null;
    w.__czPlayer = () => ({ x: +pos.current.x.toFixed(3), z: +pos.current.z.toFixed(3) });
    w.__czStagger = () => ({
      shoveX: +shoveX.current.toFixed(4), shoveZ: +shoveZ.current.toFixed(4),
      pitch: +staggerP.current.toFixed(4), yaw: +staggerY.current.toFixed(4), shake: +shake.current.toFixed(4),
    });
    w.__czColliders = () => COLLIDERS;
    w.__czCam = () => ({ x: +camera.position.x.toFixed(3), z: +camera.position.z.toFixed(3), fov: +(camera as THREE.PerspectiveCamera).fov.toFixed(1), roll: +camera.rotation.z.toFixed(4), pitch: +pitch.current.toFixed(4), yaw: +yaw.current.toFixed(4) });
    // Draw calls and triangles per frame, counted across every pass (post-processing
    // resets the renderer's counters each pass, so the default reading is the last quad).
    w.__czDrawStats = (frames = 30) => new Promise((res) => {
      const info = gl.info;
      info.autoReset = false;
      info.reset();
      let n = 0;
      const tick = () => {
        if (++n < frames) { requestAnimationFrame(tick); return; }
        const out = { calls: Math.round(info.render.calls / frames), triangles: Math.round(info.render.triangles / frames) };
        info.autoReset = true;
        res(out);
      };
      requestAnimationFrame(tick);
    });
    w.__czRender = () => {
      let casting = 0;
      scene.traverse((o) => { if ((o as THREE.Light).isLight && o.castShadow) casting++; });
      return { pixelRatio: gl.getPixelRatio(), shadowCasters: casting, ...tierRef.current };
    };
    // audition any presence line (also lets us verify which ids have a recording)
    w.__czVo = (id: string, speaker: Speaker) => audio.vo(id, speaker);
    w.__czAudio = audio; // probes: levels(), stats(), and driving sounds from a headless run
    w.__czSetXp = (n: number) => { careerXp.current = n; try { window.localStorage.setItem(XP_KEY, String(n)); } catch { /* ignore */ } };
    // headless: wound the live boss to a fraction of its health, to drive phases
    w.__czHurtBoss = (frac: number) => {
      const b = sim.getEnemies().find((e) => e.boss && e.alive);
      if (b) (b as { hp: number }).hp = Math.max(1, Math.round(b.maxHp * frac));
      return b ? { hp: b.hp, phase: b.phase } : null;
    };
    w.__czWakeRoom = (room: number) => sim.setRoomActive(room, true); // headless room activation
    w.__czSwitch = (n?: number) => (typeof n === 'number' ? sim.switchGun(n) : sim.nextWeapon());
    w.__czFire = (on: boolean) => { controls.current.fire = !!on; }; // headless: hold the trigger (aim-assist test)
    w.__czToggle = (a: Attachment) => sim.toggleAttachment(a);
    // C3: WebGL resource + draw snapshot — the soak probe watches memory.geometries/
    // textures/programs for growth (a disposal leak) over a long run.
    w.__czPerf = () => ({
      geometries: gl.info.memory.geometries,
      textures: gl.info.memory.textures,
      programs: gl.info.programs?.length ?? 0,
      calls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      sceneChildren: scene.children.length,
    });
    // ── Survival re-arm bridge (B1): applies a PAID re-arm's effect to the sim.
    //    The outer component charges the G$ first, then calls these on success. ──
    w.__czRevive = () => {
      if (!survival || sim.snapshot().playerAlive) return false;
      sim.revive();
      survOver.current = false;
      survState.current = 'intermission';
      survNextAt.current = performance.now() + 1600;      // a breath, then the next wave
      if (hud.current.survEnd) { hud.current.survEnd.style.opacity = '0'; hud.current.survEnd.style.pointerEvents = 'none'; }
      return true;
    };
    w.__czResupply = () => { if (!survival || !sim.snapshot().playerAlive) return false; sim.resupply(); return true; };
    w.__czWaveSkip = () => {
      if (!survival || !sim.snapshot().playerAlive) return false;
      sim.despawnAll();                                    // clear the field → next wave
      survState.current = 'intermission';
      survNextAt.current = performance.now() + 900;
      return true;
    };
    return () => {
      delete w.__czState; delete w.__czKillAll; delete w.__czKillRoom; delete w.__czKillPlayer; delete w.__czAim; delete w.__czAudio;
      delete w.__czMission; delete w.__czEndless; delete w.__czWarp; delete w.__czSkipBriefing;
      delete w.__czXp; delete w.__czSetXp; delete w.__czStory; delete w.__czVo; delete w.__czAudio; delete w.__czRig; delete w.__czPlayer; delete w.__czColliders; delete w.__czCam; delete w.__czStagger; delete w.__czHurtBoss; delete w.__czWakeRoom; delete w.__czSwitch; delete w.__czFire; delete w.__czToggle;
      delete w.__czRevive; delete w.__czResupply; delete w.__czWaveSkip; delete w.__czPerf; delete w.__czField; delete w.__czPath; delete w.__czRender; delete w.__czDrawStats;
    };
  }, [sim, audio]);

  // C1: with a real account, SEED the live rank bar from the server's rank/XP so
  // the HUD shows your true standing (re-seeds whenever the server value changes,
  // e.g. after an op-clear reconciles). Without an account (/dev/verb sandbox), fall
  // back to the locally-persisted career total.
  useEffect(() => {
    if (accountRank) {
      careerXp.current = careerXpFor(accountRank, accountXp ?? 0);
      return;
    }
    try {
      const v = Number(window.localStorage.getItem(XP_KEY));
      if (Number.isFinite(v) && v > 0) careerXp.current = v;
    } catch { /* private mode */ }
  }, [accountRank, accountXp]);

  const tmp = useMemo(() => new THREE.Vector3(), []);
  const tmp2 = useMemo(() => new THREE.Vector3(), []);
  const fwd = useMemo(() => new THREE.Vector3(), []);
  const arrowWp = useMemo(() => new THREE.Vector3(), []);
  const arrowCs = useMemo(() => new THREE.Vector3(), []);
  const lockVec = useMemo(() => new THREE.Vector3(), []); // scratch for world→screen projection
  const feel = GUN_FEEL[GUN];

  useFrame((frame, rawDt) => {
    // Paused for the Operations board, or frozen behind the server-readiness gate:
    // freeze the sim + drop any held input so nothing carries through the menu/overlay.
    if (pausedRef.current || gateRef.current) { keys.current.clear(); mouseBtn.current.clear(); return; }
    const dt = Math.min(rawDt, 1 / 20);
    // Inspecting: the world runs on, the player stands still with the weapon down.
    if (inspectingRef?.current) { keys.current.clear(); mouseBtn.current.clear(); }
    if (wantInspect.current) { wantInspect.current = false; openInspector(); }
    const ct = controls.current;

    // ── Stances FIRST (look sensitivity is reduced while aiming down sights) ──
    const cs = settingsRef?.current;
    // Hold or toggle (Settings → Controls). Touch keeps its own buttons either way.
    const adsKey = cs?.controls.aim === 'toggle' ? aimLatch.current : actHeld('aim') || mouseBtn.current.has(2);
    const adsWant = adsKey || ct.ads ? 1 : 0;
    const crouchKey = cs?.controls.crouch === 'toggle' ? crouchLatch.current : actHeld('crouch');
    const crouchWant = crouchKey || ct.crouch ? 1 : 0;
    const leanWant = (actHeld('leanRight') ? 1 : 0) - (actHeld('leanLeft') ? 1 : 0);
    adsCur.current += (adsWant - adsCur.current) * Math.min(1, dt * 12);
    crouchCur.current += (crouchWant - crouchCur.current) * Math.min(1, dt * 10);
    leanCur.current += (leanWant - leanCur.current) * Math.min(1, dt * 12);

    // ── Look: mouse (pointer-lock) + touch drag + arrow keys, slowed by ADS ──
    // The aiming multiplier (Settings → Controls) scales the tuned ADS slow-down.
    const adsMult = THREE.MathUtils.lerp(1, ADS_SENS * (cs?.controls.adsSens ?? 1), adsCur.current);
    const invY = cs?.controls.invertY ? -1 : 1;
    // Touch drag feeds a buffer we EASE out of, so aiming glides instead of
    // jittering frame-to-frame (mouse stays raw — desktop wants 1:1).
    const rawTouchX = ct.lookX, rawTouchY = ct.lookY; // this frame's actual finger travel
    lookAccum.current.x += rawTouchX; lookAccum.current.y += rawTouchY;
    ct.lookX = 0; ct.lookY = 0;
    // FRAME-RATE-INDEPENDENT smoothing. This was `Math.min(1, dt * 19)`, the linear
    // approximation of an exponential decay, and it fell apart exactly where it was
    // needed most: `dt` is capped at 1/20, so on a phone at 20fps the term reached 0.95
    // and the ENTIRE buffered swipe was dumped into one frame. Smoothing therefore
    // switched itself off as the device got slower, which is why aiming felt stepped on
    // Android and fine on desktop — 0.32 of the buffer per frame at 60fps against 0.95 at
    // 20fps.
    //
    // `1 - exp(-dt * rate)` is the real thing: the buffer's half-life is now a fixed
    // amount of REAL TIME, so 20fps and 60fps smooth identically. Total rotation for a
    // given swipe is unchanged — exponential decay only spreads it, so sensitivity feels
    // the same and only the delivery is smoother.
    const ease = 1 - Math.exp(-dt * LOOK_SMOOTH_RATE);
    const tx = lookAccum.current.x * ease, ty = lookAccum.current.y * ease;
    lookAccum.current.x -= tx; lookAccum.current.y -= ty;
    // A real manual look this frame (drag or mouse) drops any lock-on so you aim freely.
    // Measured on the RAW finger travel, not the eased output: the eased value is now
    // smaller per frame (that is the fix above working), and testing the smoothed number
    // against a fixed threshold would have quietly made lock-on harder to break by
    // dragging — worst on the slow devices this is all for.
    const manualLook = Math.abs(mouseDX.current) > 0.5 || Math.abs(mouseDY.current) > 0.5
      || Math.abs(rawTouchX) > 1.5 || Math.abs(rawTouchY) > 1.5;
    // The player's multiplier scales mouse and touch together — whichever they use is
    // the one they are tuning, and a device is effectively one or the other.
    const sens = adsMult * (ct.lookSens > 0 ? ct.lookSens : 1);
    yaw.current -= (mouseDX.current * LOOK_SENS + tx * TOUCH_LOOK_SENS) * sens;
    pitch.current -= (mouseDY.current * LOOK_SENS + ty * TOUCH_LOOK_SENS) * sens * invY;
    mouseDX.current = 0; mouseDY.current = 0;
    const keyStep = KEY_LOOK * adsMult * dt;
    if (actHeld('lookLeft')) yaw.current += keyStep;
    if (actHeld('lookRight')) yaw.current -= keyStep;
    if (actHeld('lookUp')) pitch.current += keyStep * invY;
    if (actHeld('lookDown')) pitch.current -= keyStep * invY;

    // ── Assisted targeting: hard lock-on + tap-to-target ──
    // Point-and-tap for people who can't flick-aim. A Target button locks the nearest
    // enemy (tap again to cycle); tapping an enemy locks that one. While locked we steer
    // firmly onto them and draw a reticle. Manual look always drops the lock (above).
    {
      const cam = frame.camera;
      const vw = frame.size.width, vh = frame.size.height;
      const eyeY = THREE.MathUtils.lerp(EYE_STAND, EYE_CROUCH, crouchCur.current);
      const px = pos.current.x, pz = pos.current.z;

      const project = (ex: number, ez: number): { x: number; y: number } | null => {
        lockVec.set(ex, 1.15, ez).project(cam);
        if (lockVec.z > 1) return null; // behind the camera
        return { x: (lockVec.x * 0.5 + 0.5) * vw, y: (-lockVec.y * 0.5 + 0.5) * vh };
      };

      // Living, on-screen, in-range enemies you're allowed to lock.
      const lockable = () => {
        const out: { id: number; sx: number; sy: number; d: number }[] = [];
        for (const e of sim.getEnemies()) {
          if (!e.alive || !e.active) continue;
          const dh = Math.hypot(e.x - px, e.z - pz);
          if (dh < 1.2 || dh > 45) continue;
          const sp = project(e.x, e.z);
          if (!sp || sp.x < 0 || sp.x > vw || sp.y < 0 || sp.y > vh) continue;
          out.push({ id: e.id, sx: sp.x, sy: sp.y, d: dh });
        }
        return out;
      };

      if (manualLook) lockTarget.current = null;

      // Tap-to-target: lock the enemy nearest the tapped point (generous radius).
      if (cs?.access.targetLock === false) { ct.lockCycle = false; ct.tapAimX = null; ct.tapAimY = null; lockTarget.current = null; }
      if (ct.tapAimX != null && ct.tapAimY != null) {
        let best: number | null = null, bestD2 = 90 * 90; // ~90px acquisition radius
        for (const c of lockable()) {
          const d2 = (c.sx - ct.tapAimX) ** 2 + (c.sy - ct.tapAimY) ** 2;
          if (d2 < bestD2) { bestD2 = d2; best = c.id; }
        }
        if (best != null) lockTarget.current = best;
        ct.tapAimX = null; ct.tapAimY = null;
      }

      // Target button: acquire nearest, or cycle to the next-nearest if already locked.
      // Always answer the press: a ping + reticle pop when a target is found, a dry
      // click when nothing's lockable — so the button never feels dead.
      if (ct.lockCycle) {
        ct.lockCycle = false;
        const cands = lockable().sort((a, b) => a.d - b.d);
        if (cands.length) {
          const i = lockTarget.current == null ? -1 : cands.findIndex((c) => c.id === lockTarget.current);
          lockTarget.current = cands[(i + 1) % cands.length].id;
          lockPulse.current = 1;
          audio.hitmarker(false); // acquisition ping
        } else {
          audio.empty();          // nothing to lock — a dry click
        }
      }
      if (lockPulse.current > 0) lockPulse.current = Math.max(0, lockPulse.current - dt * 4);

      // Steer firmly onto the locked enemy; drop the lock if it died or vanished.
      let reticleShown = false;
      if (lockTarget.current != null) {
        const e = sim.getEnemies().find((en) => en.id === lockTarget.current);
        if (!e || !e.alive) {
          lockTarget.current = null;
        } else {
          const dx = e.x - px, dz = e.z - pz, dyC = 1.15 - eyeY, dh = Math.hypot(dx, dz);
          const kk = Math.min(1, dt * 14); // firm, near-instant, but eased (no teleport snap)
          yaw.current += angleDiff(Math.atan2(-dx, -dz), yaw.current) * kk;
          pitch.current += (Math.atan2(dyC, dh) - pitch.current) * kk;
          const sp = project(e.x, e.z);
          if (sp && hud.current.lockReticle) {
            const pop = 1 + lockPulse.current * 0.7; // brief pop on acquire
            hud.current.lockReticle.style.transform = `translate(${sp.x}px, ${sp.y}px) translate(-50%, -50%) scale(${pop.toFixed(3)})`;
            hud.current.lockReticle.style.opacity = '1';
            reticleShown = true;
          }
        }
      }
      if (!reticleShown && hud.current.lockReticle) hud.current.lockReticle.style.opacity = '0';
    }

    // ── Mobile aim assist ──
    // On a phone you can't flick-aim, so while engaging (firing or aiming) we
    // gently magnetise the crosshair to the nearest ON-SCREEN, UNOCCLUDED enemy.
    // You still choose who by pointing roughly at them; the assist does the fine
    // targeting. Desktop keeps raw mouse aim (skill decides the hit). Skipped while a
    // hard lock is active — the lock already owns the aim.
    // Settings → Accessibility: on touch only (default), everywhere, or off.
    const assist = cs?.access.aimAssist ?? 'touch';
    const assistOn = assist === 'always' || (assist === 'touch' && lowSpec);
    if (assistOn && lockTarget.current == null && (ct.fire || actHeld('fire') || mouseBtn.current.has(0) || adsCur.current > 0.35)) {
      const eyeApprox = THREE.MathUtils.lerp(EYE_STAND, EYE_CROUCH, crouchCur.current);
      const px = pos.current.x, pz = pos.current.z;
      let bestDiff = 0.3; // ~17° acquisition cone
      let tYaw = 0, tPitch = 0, found = false;
      for (const e of sim.getEnemies()) {
        if (!e.alive || !e.active) continue;
        const dx = e.x - px, dz = e.z - pz, dyC = 1.15 - eyeApprox;
        const dh = Math.hypot(dx, dz);
        if (dh < 1.2 || dh > 42) continue;
        const len = Math.hypot(dx, dyC, dz);
        const dir: Vec3 = [dx / len, dyC / len, dz / len];
        const from: Vec3 = [px, eyeApprox, pz];
        let occluded = false;
        for (const c of COLLIDERS) {
          const tc = rayAABB(from, dir, aabbOfCover(c));
          if (tc !== null && tc < len - 0.5) { occluded = true; break; }
        }
        if (occluded) continue;
        const wantYaw = Math.atan2(-dx, -dz);
        const wantPitch = Math.atan2(dyC, dh);
        const diff = Math.hypot(angleDiff(wantYaw, yaw.current), wantPitch - pitch.current);
        if (diff < bestDiff) { bestDiff = diff; tYaw = wantYaw; tPitch = wantPitch; found = true; }
      }
      if (found) {
        const k = Math.min(0.22, (ct.fire ? 6 : 3.5) * dt); // gentle magnetism, not a snap
        yaw.current += angleDiff(tYaw, yaw.current) * k;
        pitch.current += (tPitch - pitch.current) * k;
      }
    }

    pitch.current = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch.current));

    // ── Movement (camera-relative on the ground plane; keyboard + touch stick) ──
    const mf = Math.max(-1, Math.min(1, (actHeld('moveForward') ? 1 : 0) - (actHeld('moveBack') ? 1 : 0) + ct.moveY));
    const ms = Math.max(-1, Math.min(1, (actHeld('moveRight') ? 1 : 0) - (actHeld('moveLeft') ? 1 : 0) + ct.moveX));
    const moving = Math.abs(mf) > 0.02 || Math.abs(ms) > 0.02;
    let speed = WALK * (1 - 0.45 * adsCur.current) * (1 - (1 - CROUCH_MOVE) * crouchCur.current);
    if (adsCur.current > 0.5) speed = Math.min(speed, WALK * ADS_MOVE);
    speed *= FIELD.speedMult; // carried cargo weighs you down
    const sinY = Math.sin(yaw.current), cosY = Math.cos(yaw.current);
    // forward on ground = (-sinY, 0, -cosY); right = (cosY, 0, -sinY)
    let nx = pos.current.x + (-sinY * mf + cosY * ms) * speed * dt;
    let nz = pos.current.z + (-cosY * mf - sinY * ms) * speed * dt;
    ({ x: nx, z: nz } = clampAndSlide(pos.current.x, pos.current.z, nx, nz));
    pos.current.x = nx; pos.current.z = nz;
    if (moving) bobPhase.current += dt * (adsCur.current > 0.5 ? 6 : 9);
    if (moving && sim.time - footstepAt.current > (adsCur.current > 0.5 ? 0.62 : 0.42)) {
      audio.footstep();
      footstepAt.current = sim.time;
      // Your own boot lifting the ash. Behind and below the eye, so it puffs out
      // around your feet at the edge of frame instead of in the middle of your view.
      impactFx.scuff([nx, 0, nz], 0.85);
    }

    // ── Drive the camera ──
    // Bodycam handheld drift — the signature of the look. Aiming down sights
    // steadies the hands, so precision is never fighting the camera.
    swayT.current += dt * (moving ? 6.2 : 1.5);
    const swayAmt = (moving ? 1 : 0.38) * (1 - adsCur.current * 0.85);
    const swayPitch = Math.sin(swayT.current * 1.07) * 0.0045 * swayAmt;
    const swayYaw = Math.sin(swayT.current * 0.63) * 0.0038 * swayAmt;
    const swayRoll = Math.sin(swayT.current * 0.51) * 0.0075 * swayAmt;

    const eyeY = THREE.MathUtils.lerp(EYE_STAND, EYE_CROUCH, crouchCur.current)
      + Math.sin(swayT.current * 2.1) * 0.011 * swayAmt;
    const lean = leanCur.current;
    const cam = camera as THREE.PerspectiveCamera;
    // Lateral lean offset. Peeking must never push the camera into geometry —
    // shorten the lean until the head is clear (0 = fully blocked, don't lean).
    let leanX = lean * 0.45;
    for (let t = 1; t > 0.001; t -= 0.2) {
      const lx = leanX * t;
      if (!blocked(pos.current.x + cosY * lx, pos.current.z - sinY * lx, 0.12)) { leanX = lx; break; }
      if (t - 0.2 <= 0.001) leanX = 0;
    }
    cam.position.set(
      pos.current.x + cosY * leanX + shoveX.current,
      eyeY,
      pos.current.z - sinY * leanX + shoveZ.current,
    );
    // Reduced motion: no shake or handheld sway, and a much gentler hit stagger.
    const calm = settingsRef?.current.access.reduceMotion ? 0 : 1;
    const sh = shake.current * calm;
    const stag = calm ? 1 : 0.3;
    cam.rotation.set(
      pitch.current + recoilP.current + swayPitch * calm + staggerP.current * stag + (Math.random() - 0.5) * sh * 0.5,
      yaw.current + recoilY.current + swayYaw * calm + staggerY.current * stag + (Math.random() - 0.5) * sh * 0.5,
      -lean * 0.14 + swayRoll * calm + (Math.random() - 0.5) * sh,
      'YXZ',
    );
    const baseFov = settingsRef?.current.fov ?? 55;
    const adsFov = THREE.MathUtils.lerp(baseFov, Math.min(baseFov, 42), adsCur.current);
    if (Math.abs(cam.fov - adsFov) > 0.05) { cam.fov = adsFov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert(); // for threat-arrow projection
    audio.setListener(pos.current.x, pos.current.z, yaw.current); // camera is the listener

    // ── Recoil recovery + damage-flash decay ──
    recoilP.current += (0 - recoilP.current) * Math.min(1, dt * RECOIL_RECOVER);
    recoilY.current += (0 - recoilY.current) * Math.min(1, dt * RECOIL_RECOVER);
    vignetteHit.current = Math.max(0, vignetteHit.current - dt * 2.5);
    bossFlash.current = Math.max(0, bossFlash.current - dt * 1.5);

    // Getting-shot stagger recovers to FULLY STABLE within a moment. The snap-to-
    // zero matters: exponential decay never quite reaches 0, and any leftover
    // `shake` jitters the view forever ("stagger through the whole game").
    const settle = (v: number) => {
      const n = v + (0 - v) * Math.min(1, dt * 7);
      return Math.abs(n) < 0.0006 ? 0 : n;
    };
    staggerP.current = settle(staggerP.current);
    staggerY.current = settle(staggerY.current);
    shake.current = settle(shake.current);
    shoveX.current = settle(shoveX.current);
    shoveZ.current = settle(shoveZ.current);

    // ── Viewmodel transform (locked to view + sway/bob/recoil + per-weapon framing) ──
    const activeId = sim.gun.id;
    const view = WEAPON_VIEW[activeId] ?? WEAPON_VIEW.assault_rifle;
    // Show only the weapon you're holding; repoint the muzzle to it.
    for (const id of ALL_GUN_IDS) gunMeshes[id].visible = id === activeId;
    // Same fallback as the initial muzzle: this runs every frame, so an unmapped
    // weapon here would throw sixty times a second.
    const activeMesh = gunMeshes[activeId] ?? gunMeshes.assault_rifle;
    muzzleRef.current = activeMesh.getObjectByName('muzzle') ?? activeMesh;
    /**
     * Hands are for the HIP pose only.
     *
     * The ADS framing (see VIEWMODEL_ADS) keeps the weapon at hip depth and only
     * lifts it toward centre, so the grip — and therefore the firing hand — ends up
     * in the middle of the sight picture. Compared against the same frame with hands
     * off, the hand was covering the thing you are aiming at. The alternative is to
     * retune the ADS pose to make room, and that pose is a deliberate feel decision
     * with its own reasoning; quietly rewriting it to suit a new prop would be the
     * wrong trade. So the hands tuck away as the weapon comes up, which is both what
     * the sights need and roughly what actually happens to your view of them.
     */
    const handsGroup = activeMesh.getObjectByName('hands');
    if (handsGroup) handsGroup.visible = adsCur.current < 0.45;
    swapRaise.current = Math.max(0, swapRaise.current - dt * 2.4);
    const vm = vmRef.current;
    // While the weapon is on the deck it must not also be in your hands.
    if (vm) vm.visible = !dropPhysics.current.active;
    if (vm) {
      const local = tmp.copy(VIEWMODEL_HIP).lerp(VIEWMODEL_ADS, adsCur.current);
      local.z += view.z; local.y += view.y;                 // where this weapon sits
      // bob: a gentle walk figure-8 on the viewmodel when moving
      const bob = BOB * (moving ? 1 : 0) * (settingsRef?.current.access.reduceMotion ? 0 : 1);
      local.x += Math.sin(bobPhase.current) * bob;
      local.y += Math.abs(Math.cos(bobPhase.current)) * bob;
      local.y -= swapRaise.current * 0.22;                  // dips down as it's raised
      local.z += recoilP.current * 2.2; // kick back toward the camera on fire
      // WALL PULLBACK: retract the viewmodel toward the eye when a wall is close ahead,
      // so the barrel can't poke through geometry when you press up against it. Cast the
      // camera's forward ray at the colliders; the nearer the wall, the further back the
      // gun is pulled (never fully collapsed, so it doesn't pop out of view).
      cam.getWorldDirection(fwd);
      const gco: Vec3 = [cam.position.x, cam.position.y, cam.position.z];
      const gcd: Vec3 = [fwd.x, fwd.y, fwd.z];
      let wallAhead = Infinity;
      for (const c of COLLIDERS) {
        const tc = rayAABB(gco, gcd, aabbOfCover(c));
        if (tc !== null && tc < wallAhead) wallAhead = tc;
      }
      const GUN_CLEAR = 1.1; // begin retracting when a wall is within this many metres
      if (wallAhead < GUN_CLEAR) {
        const k = Math.max(0.12, wallAhead / GUN_CLEAR);
        local.z *= k;                 // barrel drawn back toward the eye
        local.y -= (1 - k) * 0.06;    // and dipped a touch, like lowering the weapon
      }
      vm.position.copy(cam.localToWorld(local));
      vm.quaternion.copy(cam.quaternion);
      vm.rotateX(-recoilP.current * 1.6);
      vm.updateMatrixWorld();
    }

    // ── Attachments: night vision, optic zoom, flashlight, laser ──
    cam.getWorldDirection(fwd);
    // NVG lifts the exposure (and the HUD tints green) so the dark reads — unless
    // this op is a BLACKOUT (NVG jammed), where the dark is the whole point.
    nvgAmt.current += (((sim.hasAttachment('nvg') && !blackout) ? 1 : 0) - nvgAmt.current) * Math.min(1, dt * 8);
    gl.toneMappingExposure = 1.32 + nvgAmt.current * 1.7; // brighter base; NVG lifts further
    // Optic deepens the ADS zoom (narrower FOV); no optic = a gentler aim zoom.
    const fovTarget = THREE.MathUtils.lerp(settingsRef?.current.fov ?? 55, sim.hasAttachment('optic') ? 30 : 45, adsCur.current);
    if (Math.abs(cam.fov - fovTarget) > 0.02) { cam.fov = fovTarget; cam.updateProjectionMatrix(); }
    // Flashlight: a forward cone from the muzzle line.
    flashLight.intensity += ((sim.hasAttachment('light') ? 7 : 0) - flashLight.intensity) * Math.min(1, dt * 10);
    flashLight.position.copy(cam.position);
    flashLight.target.position.copy(tmp.copy(cam.position).addScaledVector(fwd, 10));
    flashLight.target.updateMatrixWorld();
    // Laser: a red line from the barrel to the first thing the aim ray meets.
    if (sim.hasAttachment('laser')) {
      const mp = muzzleRef.current.getWorldPosition(tmp);
      const o: Vec3 = [mp.x, mp.y, mp.z], d: Vec3 = [fwd.x, fwd.y, fwd.z];
      let t = 50;
      for (const c of COLLIDERS) { const tc = rayAABB(o, d, aabbOfCover(c)); if (tc !== null && tc < t) t = tc; }
      if (fwd.y < -1e-3) { const tf = -mp.y / fwd.y; if (tf > 0 && tf < t) t = tf; } // floor
      tmp2.copy(mp).addScaledVector(fwd, t);
      const pa = laserLine.geometry.attributes.position as THREE.BufferAttribute;
      pa.setXYZ(0, mp.x, mp.y, mp.z); pa.setXYZ(1, tmp2.x, tmp2.y, tmp2.z); pa.needsUpdate = true;
      laserDot.position.copy(tmp2);
      laserLine.visible = true; laserDot.visible = true;
    } else { laserLine.visible = false; laserDot.visible = false; }

    // ── Fire input → sim ──
    if (ct.reload) { wantReload.current = true; ct.reload = false; }
    if (wantHeal.current || ct.heal) {
      wantHeal.current = false; ct.heal = false;
      if (!sim.useMedkit()) toast(sim.medkits <= 0 ? 'NO DRESSINGS' : sim.playerHp >= sim.snapshot().maxPlayerHp ? 'HEALTH FULL' : '', '#ffb454');
    }
    if (cycleFireMode.current || ct.fireMode) {
      cycleFireMode.current = false; ct.fireMode = false;
      sim.cycleFireMode();
      audio.reloadEnd(); // a crisp mechanical click on the selector
    }
    if (wantSlot.current !== null) { sim.switchGun(wantSlot.current); wantSlot.current = null; }
    if (wantSwap.current || ct.swap) { wantSwap.current = false; ct.swap = false; sim.nextWeapon(); }
    if (wantToggle.current || ct.toggle) { sim.toggleAttachment(wantToggle.current ?? ct.toggle!); wantToggle.current = null; ct.toggle = null; }
    cam.getWorldDirection(fwd);
    const input: FpsInput = {
      firing: actHeld('fire') || mouseBtn.current.has(0) || ct.fire,
      wantReload: wantReload.current,
      origin: [cam.position.x, cam.position.y, cam.position.z] as Vec3,
      dir: [fwd.x, fwd.y, fwd.z] as Vec3,
      adsFactor: adsCur.current,
      moving,
      crouched: crouchCur.current > 0.5,
    };
    wantReload.current = false;

    // ── Co-op Endless (party mode) ──
    if (coop?.isHost) {
      // Register every teammate as a live AI target BEFORE stepping the sim,
      // so this frame's updateEnemies pass already sees them — see
      // FpsSim.ts's setCombatant/pickTarget. Also resolves their fire
      // intent directly against the host's enemy pool, gated to a fixed
      // cadence PER TEAMMATE (FpsSim.resolveRemoteShot itself has no
      // ammo/fire-rate gate — see its own doc — so this is the one place
      // that has to exist, or a held trigger would fire every frame).
      for (const [wallet, peer] of coop.latestPeerInputs?.current ?? []) {
        sim.setCombatant(wallet, peer.x, peer.z, peer.y);
        if (peer.firing) {
          const nextAt = teammateNextShotAt.current.get(wallet) ?? 0;
          if (sim.time >= nextAt) {
            teammateNextShotAt.current.set(wallet, sim.time + TEAMMATE_FIRE_INTERVAL);
            sim.resolveRemoteShot(wallet, [peer.x, peer.y, peer.z], [peer.dirX, peer.dirY, peer.dirZ], TEAMMATE_SPREAD);
          }
        }
      }
    } else if (coop && !coop.isHost) {
      // Report this frame's real position/aim to the host — the host's sim
      // is the only one that ever gets real enemies (see the endless flow
      // below), so this is what lets it target/render this player at all.
      coop.sendRemoteInput?.({
        x: cam.position.x, y: cam.position.y, z: cam.position.z,
        dirX: fwd.x, dirY: fwd.y, dirZ: fwd.z,
        firing: input.firing,
      });
    }

    sim.step(dt, input);

    // ── Consume events → VFX / HUD ──
    const now = sim.time;
    for (const ev of sim.drain()) {
      if (ev.kind === 'fire') {
        // muzzle flash + light + recoil kick
        muzzleRef.current.getWorldPosition(tmp2);
        // Reduced flashes: automatic fire would otherwise flicker the whole scene ~10×/s.
        if (muzzleLight.current) { muzzleLight.current.position.copy(tmp2); muzzleLight.current.intensity = feel.lightIntensity * (settingsRef?.current.access.reduceFlashes ? 0.25 : 1); }
        if (flashRef.current) { flashRef.current.position.copy(tmp2); flashRef.current.visible = true; flashRef.current.scale.setScalar(0.18 * feel.flashScale * (0.8 + Math.random() * 0.5)); }
        flashUntil.current = now + 0.045;
        const kick = 0.02 * feel.kick * (1 - 0.4 * adsCur.current);
        recoilP.current += kick;
        recoilY.current += (Math.random() - 0.5) * kick * 0.5;
        audio.shot((GUN_FEEL[sim.gun.id] ?? feel).audio); // the ACTIVE weapon's voice, not just the primary's
      } else if (ev.kind === 'hit' || ev.kind === 'wall' || ev.kind === 'miss') {
        muzzleRef.current.getWorldPosition(tmp2);
        spawnBeam(tmp2, ev.point, false);                       // your tracer line, restored
        // A `miss` struck nothing at all — it is the round still travelling at the
        // end of the weapon's reach, so there is no surface to spark off. It used to
        // get one anyway, which put a puff of dust in mid-air 60m out.
        if (ev.kind === 'hit') spawnFleshImpact(ev.point, tmp2);
        else if (ev.kind === 'wall') spawnImpact(ev.point, ev.normal, surfaceAt(ev.point, ev.normal), impactPower());
        if (ev.kind === 'hit') {
          audio.impact('flesh', ev.point);
          audio.hitmarker(ev.killed);
          flashHit(ev.enemyId, ev.killed);
          flashHitmarker(ev.killed, ev.crit);
          if (ev.killed) {
            addXp(xpForKill(ev.part)); // earn loop: XP per kill
            spawnDeathPool(ev.enemyId);
            // The guard's own weapon falls where they do: the gun the economy armed
            // them with (a rifle, or a sidearm when the faction was short of ammo),
            // with what was left in it. Temporary battlefield equipment.
            if (FINITE_AMMO) dropEnemyWeapon(ev.enemyId);
          }
        } else if (ev.kind === 'wall') {
          audio.impact('wall', ev.point);
        }
      } else if (ev.kind === 'attachment') {
        audio.reloadEnd();          // a soft toggle click
      } else if (ev.kind === 'weaponSwitch') {
        swapRaise.current = 1;      // the new weapon dips in from below
        audio.reloadEnd();          // a mechanical rack/click
      } else if (ev.kind === 'reloadStart') {
        audio.reloadStart();
      } else if (ev.kind === 'reloadEnd') {
        audio.reloadDone();         // mag-in + charging-handle rack
      } else if (ev.kind === 'empty') {
        audio.empty();
      } else if (ev.kind === 'noReserve') {
        audio.empty();
        toast('NO SPARE ROUNDS · FIND AMMUNITION', '#ff6a5a');
      } else if (ev.kind === 'healStart') {
        audio.pickup();
        toast('APPLYING DRESSING…', '#5fe0a8');
      } else if (ev.kind === 'healEnd') {
        toast(`PATCHED UP · ${Math.round(ev.hp)} HP`, '#5fe0a8');
      } else if (ev.kind === 'enemyFire') {
        // BRIGHT muzzle flash at the shooter — the clearly-visible "they fired" cue
        const fi = eFlashHead.current = (eFlashHead.current + 1) % EFLASH;
        const fm = eFlashRefs.current[fi];
        if (fm) { fm.position.set(ev.from[0], ev.from[1], ev.from[2]); fm.visible = true; fm.scale.setScalar(0.26 * (0.85 + Math.random() * 0.5)); eFlashUntil.current[fi] = now + 0.06; }
        if (eLight.current) { eLight.current.position.set(ev.from[0], ev.from[1], ev.from[2]); eLight.current.intensity = 7; }
        const shooter = sim.getEnemies().findIndex((en) => en.id === ev.enemyId);
        if (shooter >= 0) rigApis.current[shooter]?.playOnce('fire'); // recoil the rifle
        // The sim traced this round from their barrel to whatever it struck —
        // your head, your leg, a crate. Fly it exactly along that ray.
        const from = tmp2.set(ev.from[0], ev.from[1], ev.from[2]);
        spawnBeam(from, ev.impact, true);                          // the line from their gun to you
        spawnBullet(from, ev.impact, ev.hit, true, ev.normal);     // and the round travelling down it
        audio.enemyShot(ev.from, { impact: ev.impact, hit: ev.hit }); // spatialised, delayed and dulled when far; a miss that passes close is heard going by
      } else if (ev.kind === 'playerHit') {
        // A round landing should MOVE you: the head snaps, the view rolls, and
        // you're shoved off the axis you were shot from.
        // A rifle round is not a tap. Head snaps hard, torso rocks you, a limb
        // stings. The view kicks, rolls, AND you get physically shoved.
        // A clear nudge that tells you the direction, NOT a disorienting throw.
        // Capped so a burst can't stack into chaos.
        const partKick = ev.part === 'head' ? 1.6 : ev.part === 'torso' ? 1.0 : 0.6;
        const k = (0.02 + ev.damage * 0.0015) * partKick;
        staggerP.current = Math.min(0.05, staggerP.current + k);                          // small head bump
        staggerY.current += (ev.fromDir[0] >= 0 ? -1 : 1) * k * 0.5;
        staggerY.current = Math.max(-0.05, Math.min(0.05, staggerY.current));
        shake.current = Math.min(0.05, shake.current + k * 0.6);
        shoveX.current = Math.max(-0.10, Math.min(0.10, shoveX.current - ev.fromDir[0] * k * 0.8));
        shoveZ.current = Math.max(-0.10, Math.min(0.10, shoveZ.current - ev.fromDir[2] * k * 0.8));
        vignetteHit.current = Math.min(0.7, vignetteHit.current + 0.28 * partKick);
        audio.hurt();
        vignetteHit.current = 1;
        showHitDir(ev.fromDir);
      } else if (ev.kind === 'playerDown') {
        downAt.current = now;
        // Whatever you were carrying hits the ground where you fell.
        for (const fe of FIELD.down(pos.current.x, pos.current.z)) if (fe.kind === 'dropped') toast(`CARGO DROPPED · ${fe.ids.length} CASE${fe.ids.length === 1 ? '' : 'S'}`, '#ff6a5a');
        dropWeapon(cam);            // your hands let go of it
        if (refills.current > 0) {
          // Second wind: this attempt is not over. The endless and campaign
          // death paths below both stand down while a revive is pending.
          refills.current--;
          reviveAt.current = now + REVIVE_DELAY;
          showDown(refills.current > 0 ? `SECOND WIND · ${refills.current} LEFT` : 'SECOND WIND · LAST', '#ffb454');
          paintRefills();
        } else {
          reviveAt.current = 0;
          showDown('DOWN', '#ff5a47');
          // Record the death — only a FINAL one. In campaign this writes the loss;
          // firing it on a death you got back up from would log a loss for an op
          // you may still go on to clear.
          onDeath?.(sim.snapshot().stats);
        }
      } else if (ev.kind === 'bossPhase') {
        // The boss just escalated: pulse it, jolt the view, and let the handler call it.
        bossFlash.current = 1;
        shake.current = Math.min(0.05, shake.current + 0.028);
        say(ev.phase >= 3 ? 'bossEnrage' : 'bossEscalate');
      }
    }

    // ── Field: E interactions, supplies, cargo, charges, extraction (fps/field) ──
    {
      const cur = OBJECTIVES[objective.current];
      FIELD.exfilAllowed = !!cur && completeAt.current < 0 && sim.time > briefingUntil.current
        && (cur.kind === 'extract' || (cur.kind === 'secure' && FIELD.carried.length > 0));
      const view = { x: pos.current.x, z: pos.current.z, eyeY: cam.position.y, yaw: yaw.current, pitch: pitch.current };
      const toggle = !!settingsRef?.current.access.toggleInteract;
      if (toggle && interactLatch.current && latchTarget.current !== null && FIELD.target?.id !== latchTarget.current) interactLatch.current = false;
      latchTarget.current = interactLatch.current ? (FIELD.target?.id ?? null) : null;
      const pressing = toggle ? interactLatch.current || ct.interact : actHeld('interact') || ct.interact;
      const interact = sim.playerAlive && completeAt.current < 0 && pressing;
      const fevs = FIELD.update(dt, view, interact, sim, losClear);
      if (toggle && fevs.length) interactLatch.current = false; // done (or refused): release the latch
      for (const fe of fevs) onFieldEvent(fe);
      // A position heartbeat each second of game time lets the server check movement.
      if (FIELD.ms - lastHeartbeat.current >= 1000) { lastHeartbeat.current = FIELD.ms; FIELD.note('pos'); }
      if (FIELD.log.length) { const evs = FIELD.log.splice(0); onProtocol?.(evs); }
      if (FIELD.exfilPhase === 'counting' && FIELD.spec.exfil) {
        const left = Math.ceil(FIELD.spec.exfil.secs - FIELD.exfilProgress);
        if (left !== lastBeep.current) { lastBeep.current = left; audio.beep(left <= 3); }
      }
    }

    // ── Decay pooled VFX ──
    if (flashRef.current && now > flashUntil.current) flashRef.current.visible = false;
    if (muzzleLight.current && muzzleLight.current.intensity > 0) {
      muzzleLight.current.intensity = Math.max(0, muzzleLight.current.intensity - dt * 120);
    }
    for (let i = 0; i < BEAMS; i++) {
      const m = beamRefs.current[i];
      if (m && m.visible && now > beamUntil.current[i]) m.visible = false;
    }
    for (let i = 0; i < BULLETS; i++) {
      const st = bullets.current[i];
      const m = bulletRefs.current[i];
      if (!st.active || !m) continue;
      st.t += dt;
      const u = Math.min(1, st.t / st.dur);
      m.position.lerpVectors(st.from, st.to, u);
      m.lookAt(st.to);
      if (u >= 1) {
        st.active = false;
        m.visible = false;
        // The burst lands WITH the round, not when it was fired. A round that
        // struck the player gets none: at that range it would be a faceful of
        // sprite, and the red vignette + shake already say you were hit.
        if (!st.hit && st.normal) {
          const at: Vec3 = [st.to.x, st.to.y, st.to.z];
          spawnImpact(at, st.normal, surfaceAt(at, st.normal), 0.9);
        }
      }
    }
    // Ash in the air, spawned around the player so it follows them through an
    // endless run without needing a world-sized pool. Dropped on `minimal` with
    // the rest of the atmosphere — it is the definition of a nice-to-have.
    if (plan.particles) impactFx.ambient(dt, [pos.current.x, pos.current.y, pos.current.z]);
    impactFx.update(dt);
    stepDroppedWeapon(dt);
    stepEnemyDrops(dt);

    // Second wind: stand back up where you fell. Runs before either death path
    // below, both of which are gated on there being no revive pending.
    if (reviveAt.current > 0 && now >= reviveAt.current) {
      reviveAt.current = 0;
      sim.secondWind();
      holsterWeapon();                   // the rifle is back in your hands
      if (hud.current.down) hud.current.down.style.opacity = '0';
      vignetteHit.current = 0;
      staggerP.current = 0; staggerY.current = 0; shake.current = 0;
      shoveX.current = 0; shoveZ.current = 0;
    }
    for (let i = 0; i < EFLASH; i++) {
      const m = eFlashRefs.current[i];
      if (m && m.visible && now > eFlashUntil.current[i]) m.visible = false;
    }
    if (eLight.current && eLight.current.intensity > 0) {
      eLight.current.intensity = Math.max(0, eLight.current.intensity - dt * 90);
    }

    // ── Dummies: pose from snapshot (upright / falling), hit flash ──
    const snap = sim.snapshot();

    // Co-op Endless (party mode), host only — fan this same snapshot out to
    // the rest of the party at a conservative rate (~6-7Hz; tune up only if
    // playtesting shows visible jitter, per the plan). Every non-host client
    // reads it back via `latestHostSnapshot` for enemy positions/hp AND
    // teammate positions/hp — one payload, one source of truth.
    if (coop?.isHost && now - lastCoopBroadcastAt.current > 0.15) {
      lastCoopBroadcastAt.current = now;
      coop.sendHostState?.({ ...snap, hostPos: { x: cam.position.x, z: cam.position.z, eyeY: cam.position.y } });
    }
    // Co-op non-host: this client's own sim never has real enemies (only the
    // host's does — see FpsWorld's co-op section above), so what actually
    // gets rendered/animated comes from the host's broadcast instead. Every
    // other mode (including the host's own client) reads snap.enemies
    // exactly as before this existed.
    const liveEnemies = (coop && !coop.isHost)
      ? (coop.latestHostSnapshot?.current?.enemies ?? [])
      : snap.enemies;

    // Co-op non-host: this client's own playerHp/playerAlive is a LIE —
    // nothing ever damages an enemy-less local sim, so the real truth lives
    // in the host's broadcast combatants entry instead. `effectiveSnap` is
    // what every endless-flow read below uses in place of the raw `snap`
    // for anything survival-related (HUD, low-hp cues, the death/respawn
    // trigger) — every other mode (including the host's own client) is
    // untouched, `effectiveSnap` just IS `snap` there.
    let effectiveSnap = snap;
    if (coop && !coop.isHost) {
      const mine = coop.latestHostSnapshot?.current?.combatants[coop.myWallet];
      if (mine) {
        // A drop since the last frame is a hit landing — there's no discrete
        // event for it (FpsSim's enemyFire never fires one for a combatant
        // target, see its own doc), so this diff IS the detection. Reuses
        // the exact same camera stagger/shake/vignette refs a real
        // `playerHit` event already drives elsewhere in this loop — no part/
        // direction crosses the broadcast, so this is a fixed torso-weight
        // reaction rather than the fully directional one, a real but minor
        // v1 simplification.
        if (lastCoopHp.current !== null && mine.hp < lastCoopHp.current) {
          const dmg = lastCoopHp.current - mine.hp;
          const k = 0.02 + dmg * 0.0015;
          staggerP.current = Math.min(0.05, staggerP.current + k);
          shake.current = Math.min(0.05, shake.current + k * 0.6);
          vignetteHit.current = 1;
          audio.hurt();
        }
        lastCoopHp.current = mine.hp;
        effectiveSnap = { ...snap, playerHp: mine.hp, playerAlive: mine.alive };
      }
    }

    // ── Co-op teammates: rendered ENTIRELY from whichever source is
    // authoritative for THIS client, never predicted — same discipline
    // Face-Off's ArenaScene uses for its opponent. The host reads each
    // teammate's own raw report directly; a non-host reads the host's
    // broadcast, which covers the host itself (hostPos, since the host is
    // never a combatant of its own sim) plus every OTHER non-host teammate
    // (combatants, with this client's own wallet excluded). ──
    if (coop) {
      const seats: Array<{ x: number; z: number; facing?: number; alive: boolean }> = [];
      if (coop.isHost) {
        // The host's own client never learns a teammate's hp/alive from
        // their input reports (those only ever carry position/aim/fire-
        // intent) — sim.getCombatant is the one place it lives, since this
        // sim is the authoritative one actually applying enemy damage to it.
        for (const [wallet, peer] of coop.latestPeerInputs?.current ?? []) {
          const c = sim.getCombatant(wallet);
          seats.push({ x: peer.x, z: peer.z, facing: Math.atan2(peer.dirX, peer.dirZ), alive: c?.alive ?? true });
        }
      } else {
        const hostSnap = coop.latestHostSnapshot?.current;
        if (hostSnap) {
          seats.push({ x: hostSnap.hostPos.x, z: hostSnap.hostPos.z, alive: hostSnap.playerAlive });
          for (const [wallet, c] of Object.entries(hostSnap.combatants)) {
            if (wallet === coop.myWallet) continue;
            seats.push({ x: c.x, z: c.z, alive: c.alive });
          }
        }
      }

      for (let i = 0; i < teammateRefs.current.length; i++) {
        const g = teammateRefs.current[i];
        if (!g) continue;
        const seat = seats[i];
        if (!seat) { g.visible = false; continue; }
        g.visible = true;
        g.position.set(seat.x, 0, seat.z);

        const prev = teammateStepPos.current[i];
        const moved = Math.hypot(seat.x - prev[0], seat.z - prev[1]);
        // Facing: the host knows a teammate's REAL aim direction (reported
        // every frame); a non-host only ever sees positions, so it falls
        // back to facing the way they're walking — a real but minor v1
        // asymmetry, not worth carrying aim direction through the broadcast
        // for every party member just for this.
        const facing = seat.facing ?? (moved > 0.001 ? Math.atan2(seat.x - prev[0], seat.z - prev[1]) : null);
        if (facing !== null && seat.alive) g.rotation.set(0, facing, 0);
        if (moved > 0.001 && seat.alive) {
          prev[0] = seat.x; prev[1] = seat.z;
          teammateStepDist.current[i] += moved;
          if (teammateStepDist.current[i] >= STRIDE) {
            teammateStepDist.current[i] = 0;
            impactFx.scuff([seat.x, 0, seat.z], 0.7);
          }
        }
        teammateRigApis.current[i]?.setClip(!seat.alive ? 'death' : moved > 0.02 ? 'run' : 'idle');
      }
    }
    // Endless maps a live, changing enemy list onto a fixed rig pool, so any slot past
    // the current count is parked out of sight — otherwise a pruned room's bodies stay
    // frozen on screen as ghosts.
    for (let i = liveEnemies.length; i < dummyRefs.current.length; i++) {
      const g = dummyRefs.current[i];
      if (g) g.visible = false;
    }
    for (let i = 0; i < liveEnemies.length; i++) {
      const e = liveEnemies[i];
      const g = dummyRefs.current[i];
      if (!g) continue;
      // Bodies stay upright and un-squashed: the sim's hitboxes are fixed, so
      // moving the mesh for a crouch would break "what you see is what you hit".
      // A survival slot that's been despawned (deadAt < 0) is hidden entirely.
      //
      // ENDLESS also culls by DISTANCE. The live window holds four rooms, so ~24 skinned
      // characters can exist at once — but the ones two rooms ahead are dormant and
      // sealed behind a wall you cannot see through. Hiding them skips their draw AND
      // their skeleton update (OperatorRig bails when hidden), which is the single
      // biggest cost in the mode. The cull distance is well past the far wall of the
      // next room, so nothing you could actually see ever pops.
      // An ACTIVE enemy is fighting you and must never blink out, however far it has
      // chased you. A DORMANT one is asleep behind an unbreached wall, so it can be
      // culled close in — that is where nearly all the saving is, since the rooms
      // ahead are dormant by definition.
      const shown = e.alive || e.deadAt >= 0;
      const dz = Math.abs(e.z - pos.current.z);
      // The distance cull now applies to AUTHORED ops as well, not just endless. A
      // dormant enemy is one whose room you have not breached, so it is behind a wall
      // in either mode and the reasoning carries over unchanged; campaign just holds
      // the line further out (see CAMPAIGN_CULL_DORMANT).
      const cullAt = e.active
        ? ENDLESS_CULL_ACTIVE
        : (endless ? ENDLESS_CULL_DORMANT : CAMPAIGN_CULL_DORMANT);
      g.visible = shown && dz < cullAt;
      // Boots lifting the ash. Measured by DISTANCE COVERED rather than on a timer,
      // so a puff means a step was actually taken: a man holding still never smokes,
      // and one sprinting past leaves a trail at the right spacing. Only for the
      // ones on screen, so an unseen room isn't spending particles.
      if (e.alive && g.visible) {
        const prev = enemyStepPos.current[i];
        const moved = Math.hypot(e.x - prev[0], e.z - prev[1]);
        if (moved > 0.001) {
          prev[0] = e.x; prev[1] = e.z;
          enemyStepDist.current[i] += moved;
          if (enemyStepDist.current[i] >= STRIDE) {
            enemyStepDist.current[i] = 0;
            impactFx.scuff([e.x, 0, e.z], 0.7);
          }
        }
      } else {
        enemyStepPos.current[i][0] = e.x;
        enemyStepPos.current[i][1] = e.z;
      }
      g.position.set(e.x, 0, e.z);
      g.rotation.set(0, e.facing, 0); // face the player
      g.scale.set(1, 1, 1);

      const rig = rigApis.current[i];
      if (rig) {
        if (!e.alive) rig.setClip('death');
        else if (e.ai === 'seek') rig.setClip('run');   // maneuvering to a new angle
        else rig.setClip('idle');                        // rifle shouldered
        // No amber "I'm shooting you" glow: the shouldered rifle, the muzzle flash
        // and the round coming at you ARE the tell. Only a hit still flashes.
        const f = Math.max(0, dummyFlash.current[i] - now);
        if (f > 0) rig.setTint(0xff5a3a, Math.min(0.7, f * 5)); // your round landed
        else if (e.boss) {
          // a boss burns hotter each phase, and pulses on the moment it escalates
          const base = 0.30 + (e.phase - 1) * 0.11;
          rig.setTint(e.phase >= 3 ? 0xff2a1e : 0x6a1414, Math.min(0.75, base + bossFlash.current * 0.35));
        } else rig.setTint(0x000000, 0);
      }
    }

    // ── low-HP heartbeat ── (effectiveSnap: real broadcast hp for a co-op
    // non-host, unchanged snap everywhere else — see its own comment above)
    if (effectiveSnap.playerAlive && effectiveSnap.playerHp <= 35 && now - heartbeatAt.current > 0.45 + (effectiveSnap.playerHp / 35) * 0.4) {
      audio.heartbeat();
      heartbeatAt.current = now;
    }

    // ── off-screen threat arrows for enemies telegraphing / firing at you ──
    let ai = 0;
    const uiNow = settingsRef?.current.interface;
    for (const e of uiNow?.threatArrows === false ? [] : snap.enemies) {
      if (ai >= hud.current.arrows.length) break;
      if (!e.alive || (e.ai !== 'aim' && e.ai !== 'fire')) continue;
      arrowWp.set(e.x, 1.4, e.z);
      arrowCs.copy(arrowWp).applyMatrix4(cam.matrixWorldInverse);
      arrowWp.project(cam); // arrowWp is now NDC
      const arrow = computeEdgeArrow({ x: arrowCs.x, y: arrowCs.y, z: arrowCs.z }, { x: arrowWp.x, y: arrowWp.y });
      const el = hud.current.arrows[ai];
      if (arrow && el) {
        el.style.opacity = '1';
        el.style.left = `${arrow.leftPct}%`;
        el.style.top = `${arrow.topPct}%`;
        el.style.transform = `translate(-50%,-50%) rotate(${arrow.deg}deg)`;
        ai++;
      }
    }
    for (let j = ai; j < hud.current.arrows.length; j++) { const el = hud.current.arrows[j]; if (el) el.style.opacity = '0'; }

    // objective off-screen arrow (cyan — where to go)
    {
      const oc = OBJECTIVES[objective.current];
      const el = hud.current.objArrow;
      if (el) {
        if (oc && completeAt.current < 0 && uiNow?.objectiveArrow !== false) {
          arrowWp.set(oc.pos[0], 1.4, oc.pos[1]);
          arrowCs.copy(arrowWp).applyMatrix4(cam.matrixWorldInverse);
          arrowWp.project(cam);
          const a = computeEdgeArrow({ x: arrowCs.x, y: arrowCs.y, z: arrowCs.z }, { x: arrowWp.x, y: arrowWp.y });
          if (a) { el.style.opacity = '1'; el.style.left = `${a.leftPct}%`; el.style.top = `${a.topPct}%`; el.style.transform = `translate(-50%,-50%) rotate(${a.deg}deg)`; }
          else el.style.opacity = '0';
        } else el.style.opacity = '0';
      }
    }

    // ── Survival flow: escalating waves from a fixed pool ──
    if (survival) {
      // The wave timer runs on WALL time (like the mission-complete beat), so a
      // slow frame rate doesn't stretch the intermission.
      const wall = performance.now();
      if (!survInit.current) { sim.despawnAll(); survNextAt.current = wall + 3000; survInit.current = true; }
      if (!survOver.current && snap.playerAlive) {
        if (survState.current === 'active') {
          if (sim.aliveCount() === 0) { survState.current = 'intermission'; survNextAt.current = wall + 3200; }
        } else if (wall >= survNextAt.current) {
          survWave.current += 1;
          // The Gauntlet (prestige) runs a steeper curve than practice Survival.
          const waveCount = mission.gauntlet ? gauntletWaveCount : survivalWaveCount;
          const waveHp = mission.gauntlet ? gauntletWaveHp : survivalWaveHp;
          sim.startWave(waveCount(survWave.current), waveHp(survWave.current));
          survState.current = 'active';
        }
      }
      if (!snap.playerAlive && !survOver.current) {
        survOver.current = true;
        if (hud.current.survEnd) {
          hud.current.survEnd.style.opacity = '1';
          hud.current.survEnd.style.pointerEvents = 'auto';
          if (hud.current.survEndText) hud.current.survEndText.textContent =
            `you held ${Math.max(0, survWave.current - 1)} wave${survWave.current === 2 ? '' : 's'} · ${snap.stats.kills} down`;
        }
      }
      if (waypointRef.current) waypointRef.current.visible = false;
      pumpStory(now);
      updateHud(snap);
      return;
    }

    // ── Endless flow: clear the room → push through the door → the next one wakes ──
    //
    // No objective list and no extract. The loop is: the room you're in is live, you
    // clear it, the doorway ahead opens onto a room that is already built but asleep,
    // and crossing its threshold wakes it. Meanwhile the chain is extended ahead and
    // pruned behind, so the world stays a constant size however deep you get.
    if (endless) {
      endlessTicks.current++;
      const c = chain.current;
      const roomAt = (i: number) => c.rooms.find((r) => r.index === i);

      // Whether THIS client owns the AI — solo play is its own host by
      // definition. Every AI-authority statement below (waking a room,
      // detecting a wave clear, spawning real enemies) is gated on this;
      // a non-host still runs everything else in this block (geometry
      // streaming, the room cursor, its own breach/audio beats) driven by
      // its OWN position, exactly like a host would — only enemies
      // themselves are never real on a non-host's own sim (see FpsWorld's
      // co-op section above `sim.step`). Hoisted to the top of the whole
      // endless block (not just the room-flow branch) since the waypoint
      // check below also needs it.
      const isAiAuthority = !coop || coop.isHost;
      // Enemies-alive-in-room, whichever source is actually true for this
      // client: the local sim (host/solo) or the host's broadcast (non-
      // host, whose own sim never has real enemies to ask).
      const roomAliveCount = (room: number): number => {
        if (isAiAuthority) return sim.roomAlive(room);
        const hostSnap = coop!.latestHostSnapshot?.current;
        if (!hostSnap) return 0;
        let n = 0;
        for (const e of hostSnap.enemies) if (e.alive && e.room === room) n++;
        return n;
      };

      // ── The travelling rig: floor + sun follow the player ──
      //
      // The floor is a fixed-size plane and the sun's shadow camera only covers ±22
      // around wherever it points. An endless run leaves both behind within two rooms,
      // so they ride along. Two things matter here:
      //
      //  • SNAP, don't slide. Moving them every frame re-renders the shadow map every
      //    frame and drags the ground texture along with the mesh, which reads as the
      //    whole world sliding under you. Snapping to a grid means they only move when
      //    you cross a cell, and the floor's texture lands back on itself so the ground
      //    looks nailed down.
      //  • The grid step must divide the floor's texture tile exactly, or the snap
      //    itself becomes the visible jump.
      // The FLOOR snaps to a whole texture tile so its pattern lands back on itself.
      const floorZ = Math.round(pos.current.z / ENDLESS_RIG_STEP) * ENDLESS_RIG_STEP;
      if (floorZ !== rigCell.current.z) {
        rigCell.current.z = floorZ;
        if (floorRef.current) floorRef.current.position.z = floorZ;
      }
      // The SUN snaps to its own, far finer grid: one shadow-map texel. Sharing the
      // floor's 3m step meant the shadow frustum jumped ~140 texels at a time and every
      // shadow in the compound leapt with it, which reads as the building juddering.
      // A texel-sized step keeps shadow edges pinned to the world while still avoiding
      // the shimmer a continuously-sliding frustum produces.
      const sunX = Math.round(pos.current.x / ENDLESS_SHADOW_TEXEL) * ENDLESS_SHADOW_TEXEL;
      const sunZ = Math.round(pos.current.z / ENDLESS_SHADOW_TEXEL) * ENDLESS_SHADOW_TEXEL;
      if (sunX !== rigCell.current.x || sunZ !== rigCell.current.sunZ) {
        rigCell.current.x = sunX;
        rigCell.current.sunZ = sunZ;
        // Move the light and its aim point by the SAME delta, so only the shadow
        // frustum travels and the sun's angle never changes.
        if (sunRef.current && sunTargetRef.current) {
          sunTargetRef.current.position.set(sunX, 0, sunZ);
          sunTargetRef.current.updateMatrixWorld();
          sunRef.current.position.set(sunX + 9, 16, sunZ + 10);
          sunRef.current.updateMatrixWorld();
        }
      }

      if (effectiveSnap.playerAlive && !c.over) {
        const cur = roomAt(c.cursor);

        // ARMING BEAT: the room you spawn in holds its fire until you move. Step off
        // the mark (or shoot) and it wakes. This gives the run the same breach rhythm
        // as every later room instead of opening mid-gunfight, and it costs nothing
        // to a player who just walks in shooting.
        if (!c.armed) {
          const moved = Math.hypot(pos.current.x - START[0], pos.current.z - START[1]) > 1.2;
          if (moved || snap.stats.shotsFired > 0) {
            if (isAiAuthority) sim.setRoomActive(c.cursor + 1, true);
            c.armed = true;
            say('opBreach');
          }
        }

        // A wave banks the instant its LAST room is emptied — that's the beat the
        // "+G$ / WAVE N CLEARED" moment hangs on, not the walk to the next door.
        // Host-only: only the host's sim has real enemies to actually clear, and
        // only the host's own detection is trusted to fan a wave-clear out to the
        // rest of the party (see coop_server.rs's WaveCleared relay).
        if (isAiAuthority && cur && cur.wavesEnd && cur.wave > c.bankedThrough && sim.roomAlive(cur.index + 1) === 0) {
          c.bankedThrough = cur.wave;
          endlessOpts?.onWaveCleared?.(cur.wave);
          coop?.sendWaveCleared?.(cur.wave);
          say('missionCleared');
          // The wave-cleared beat. This is the payoff moment of the whole mode, and
          // without it a wave banks in total silence — the player has no way to know
          // they finished one. It does NOT pause the run; they read it while moving.
          if (hud.current.waveDoneText) hud.current.waveDoneText.textContent = `WAVE ${cur.wave} CLEAR`;
          if (hud.current.waveDoneSub) hud.current.waveDoneSub.textContent = `WAVE ${cur.wave + 1} — PUSH FORWARD`;
          if (hud.current.waveDone) hud.current.waveDone.style.opacity = '1';
          waveDoneUntil.current = performance.now() + 2200;
        }

        // Fade the beat once it has had its moment.
        if (waveDoneUntil.current > 0 && performance.now() > waveDoneUntil.current) {
          waveDoneUntil.current = 0;
          if (hud.current.waveDone) hud.current.waveDone.style.opacity = '0';
        }

        // Standing readout: which wave, and how far through it. Rooms are the unit of
        // progress inside a wave, so "ROOM 2 / 3" is what tells the player how close
        // the next clear is.
        if (cur) {
          const first = firstRoomOfWave(cur.wave);
          const roomInWave = cur.index - first + 1;
          const ofWave = roomsForWave(cur.wave);
          if (hud.current.waveLabel) hud.current.waveLabel.textContent = `WAVE ${cur.wave}`;
          if (hud.current.waveRooms) {
            const left = roomAliveCount(cur.index + 1);
            hud.current.waveRooms.textContent = left > 0
              ? `ROOM ${roomInWave} / ${ofWave} · ${left} LEFT`
              : `ROOM ${roomInWave} / ${ofWave} · CLEAR — MOVE UP`;
          }
        }

        // Crossing the far wall puts the player in the next room: wake it, build one
        // more room ahead, and drop the one that's now well behind. Geometry
        // streaming (generateRoom/appendCover/pruneBehind) runs for EVERY client —
        // it's pure and seeded, so a non-host needs it too, purely to give their own
        // movement real walls to collide with. Only appendEnemies/setRoomActive are
        // AI-authority — a non-host's own sim never gets real enemies at all.
        if (cur && pos.current.z < cur.zFar) {
          c.cursor = cur.index + 1;
          if (isAiAuthority) sim.setRoomActive(c.cursor + 1, true);
          c.wave = roomAt(c.cursor)?.wave ?? c.wave;
          if (c.cursor === firstRoomOfWave(c.wave)) say('opBreach');

          const built = generateRoom(c.nextIndex, c.nextZ, endlessOpts?.seed ?? 1);
          sim.appendCover([...built.walls, ...built.cover]);
          if (isAiAuthority) sim.appendEnemies(built.enemies);
          c.rooms.push(built);
          c.nextIndex += 1;
          c.nextZ = built.zFar;

          // Prune behind. Everything dropped here is regenerable from the seed, so
          // this costs nothing but the memory it frees.
          const keepFrom = c.cursor - ENDLESS_TRAIL;
          const trailRoom = roomAt(keepFrom);
          if (trailRoom) {
            sim.pruneBehind(keepFrom + 1, trailRoom.zNear);
            c.rooms = c.rooms.filter((r) => r.index >= keepFrom);
          }
          // Keep the enemy safety box on the live window as it travels.
          sim.setBounds(-ENDLESS_HALF_W, ENDLESS_HALF_W, c.rooms[c.rooms.length - 1].zFar, c.rooms[0].zNear);
          setGeoTick((t) => t + 1);
        }
      }

      // Death ends the run outright — no auto-restart. The page decides what happens
      // next (Seasonal submits the score; Campaign Endless saves the checkpoint).
      // DEATH: you drop back to the START of the wave you were on, never to wave 1 and
      // never further. You lose the rooms you had cleared inside this wave and nothing
      // else, so a death costs real ground without undoing a session's work. The run
      // itself continues — there is no run-over screen out here.
      // A pending second wind holds the wave restart off entirely — you are getting
      // back up, so the run has not ended and endlessOpts.onDeath (which is what
      // banks the checkpoint / submits a Seasonal score) must not fire.
      if (!effectiveSnap.playerAlive && !c.dying && reviveAt.current === 0) {
        c.dying = true;
        waveDoneUntil.current = 0;
        if (hud.current.waveDone) hud.current.waveDone.style.opacity = '0';
        const st = sim.snapshot().stats;
        endlessOpts?.onDeath?.(c.wave, { kills: st.kills, headshots: st.headshots });
        respawnAt.current = performance.now() + 2400;
        if (hud.current.down) hud.current.down.style.opacity = '1';
      }
      if (c.dying && performance.now() >= respawnAt.current) {
        c.dying = false;
        respawnAt.current = 0;
        if (hud.current.down) hud.current.down.style.opacity = '0';
        restartWave(c.wave);
      }

      // Waypoint: point at the doorway once the room is clear, so "push forward" is
      // always legible. While enemies are up, the fight is the objective.
      if (waypointRef.current) {
        const cur = roomAt(c.cursor);
        const clear = cur ? roomAliveCount(cur.index + 1) === 0 : false;
        if (cur && clear && !c.over) {
          waypointRef.current.visible = true;
          waypointRef.current.position.set(cur.exitPos[0], 0, cur.exitPos[1]);
          const beacon = waypointRef.current.children[0] as THREE.Mesh | undefined;
          if (beacon) beacon.rotation.y += dt * 2;
        } else {
          waypointRef.current.visible = false;
        }
      }

      if (now > briefingUntil.current) say('opStart');
      if (effectiveSnap.playerAlive && effectiveSnap.playerHp < 35) say('lowHp');
      if (!effectiveSnap.playerAlive) say('opHeroDown');
      pumpStory(now);
      updateHud(effectiveSnap);
      return;
    }

    // ── Mission flow (slice 4 + A2 verbs): breach → clear/defend/rescue → extract ──
    const obj = OBJECTIVES[objective.current];
    if (obj && snap.playerAlive && completeAt.current < 0 && now > briefingUntil.current) {
      const nearObj = Math.hypot(pos.current.x - obj.pos[0], pos.current.z - obj.pos[1]) < REACH_RADIUS;
      let done = false;
      if (obj.kind === 'reach') {
        done = nearObj;
      } else if (obj.kind === 'clear') {
        done = sim.roomAlive(obj.room ?? 0) === 0;
      } else if (obj.kind === 'defend') {
        // Hold the point: bank time while you're near it (in cover counts) and alive,
        // so retreating a step to recover doesn't stall the hold or feed more spawns.
        const holding = Math.hypot(pos.current.x - obj.pos[0], pos.current.z - obj.pos[1]) < HOLD_RADIUS;
        if (holding) holdProgress.current += dt;
        const hold = obj.holdSecs ?? 20;
        // Keep the pressure up — trickle reinforcements in until the clock runs out.
        if (holdProgress.current < hold && sim.time - lastReinforceAt.current > (obj.reinforceEvery ?? 3.5)) {
          lastReinforceAt.current = sim.time;
          sim.reinforce(obj.reinforceRoom ?? obj.room ?? 0, obj.reinforceCount ?? 2);
        }
        done = holdProgress.current >= hold;
      } else if (obj.kind === 'secure' || obj.kind === 'plant' || obj.kind === 'retrieve' || obj.kind === 'extract') {
        // The physical objectives: the field runtime says what has actually been done.
        const near = Math.hypot(pos.current.x - obj.pos[0], pos.current.z - obj.pos[1]) < HOLD_RADIUS;
        const working = obj.kind === 'extract' ? FIELD.exfilPhase === 'counting'
          : obj.kind === 'secure' ? near && FIELD.carried.length < FIELD.cases.length
          : near;
        if (working && (obj.reinforceCount ?? 0) > 0 && sim.time - lastReinforceAt.current > (obj.reinforceEvery ?? 3.5)) {
          lastReinforceAt.current = sim.time;
          sim.reinforce(obj.reinforceRoom ?? obj.room ?? 0, obj.reinforceCount ?? 2);
        }
        if (obj.kind === 'secure') done = FIELD.carried.length >= Math.min(FIELD.cases.length, CARRY_MAX) || FIELD.exfilPhase === 'counting' || FIELD.exfilPhase === 'done';
        else if (obj.kind === 'plant') done = FIELD.planted.includes(obj.item ?? '');
        else if (obj.kind === 'retrieve') done = FIELD.carried.includes(obj.item ?? '');
        else done = FIELD.exfilPhase === 'done';
      } else if (obj.kind === 'rescue') {
        // Reach the hostage; from here they trail you to extract.
        const h = snap.hostage;
        const nearHostage = h ? Math.hypot(pos.current.x - h.x, pos.current.z - h.z) < REACH_RADIUS : nearObj;
        if (nearHostage) sim.rescueHostage();
        done = nearHostage;
      }
      if (done) {
        holdProgress.current = 0; lastReinforceAt.current = 0;
        // Survive a hold → the counter-attack BREAKS: the enemies that piled up during
        // the hold fall back, so the extract is a walk-out, not a second gunfight.
        if (obj.kind === 'defend') sim.breakAttack(obj.reinforceRoom ?? obj.room ?? 0);
        if (obj.activateRoom) sim.setRoomActive(obj.activateRoom, true); // breach wakes the room
        if (obj.milestone) FIELD.note('reach', obj.milestone); // the server checks we were there
        // story beats keyed to the objective just completed. The "troops cleared"
        // and push-in lines are doorkicker beats — only fire them after a real room
        // clear, so a defend/rescue op doesn't announce "Four down".
        if (obj.beats) {
          // Contract operations name their own beats; a live contract (with the
          // server's radio) hears its target every time, training only once.
          for (const beat of obj.beats) {
            if (beat !== 'rivalFirstWord' || mission.radio) { say(beat); continue }
            try {
              if (!window.localStorage.getItem('cz_heard')) { say('rivalFirstWord'); window.localStorage.setItem('cz_heard', '1'); }
            } catch { say('rivalFirstWord'); }
          }
        } else if (objective.current === 0) say('opBreach');
        else if (objective.current === 1 && obj.kind === 'clear') {
          say('troopsCleared');
          // The convoy owner comes on the channel ONCE per session.
          try {
            if (!window.localStorage.getItem('cz_heard')) { say('rivalFirstWord'); window.localStorage.setItem('cz_heard', '1'); }
          } catch { say('rivalFirstWord'); }
        } else if (objective.current === 2 && obj.kind === 'clear') {
          say(isFinale ? 'finaleReveal' : 'opPushIn'); // the finale: he's finally in the room
        }
        objective.current++;
        if (objective.current >= OBJECTIVES.length) {
          completeAt.current = now;
          completeWallAt.current = performance.now();
          addXp(XP_REWARD.MISSION_COMPLETE); // completion bonus on top of the kills
          if (isFinale) { say('zoneClear'); say('zoneClearTag'); } // the payoff lands here, not every op
          else say('missionCleared');
          if (hud.current.complete) {
            if (extractedLabel.current) hud.current.complete.textContent = extractedLabel.current;
            hud.current.complete.style.opacity = '1';
          }
        }
      }
    }

    // story beats not tied to an objective, then pump one line at a time.
    // Ember opens only once the briefing card has faded, so they never overlap.
    if (now > briefingUntil.current) say('opStart');
    if (snap.playerAlive && snap.playerHp < 35) say('lowHp');
    if (!snap.playerAlive) say('opHeroDown');
    pumpStory(now);
    // waypoint beacon follows the current objective
    if (waypointRef.current) {
      const cur = OBJECTIVES[objective.current];
      if (cur && completeAt.current < 0) {
        waypointRef.current.visible = true;
        waypointRef.current.position.set(cur.pos[0], 0, cur.pos[1]);
        const beacon = waypointRef.current.children[0] as THREE.Mesh | undefined;
        if (beacon) beacon.rotation.y += dt * 2;
      } else {
        waypointRef.current.visible = false;
      }
    }
    // the hostage: waits at the mark, then trails you out; its marker pulses
    if (hostageRef.current) {
      const h = snap.hostage;
      if (h) {
        hostageRef.current.visible = true;
        hostageRef.current.position.set(h.x, 0, h.z);
        hostageRef.current.rotation.y = Math.atan2(pos.current.x - h.x, pos.current.z - h.z);
        const marker = hostageRef.current.children[hostageRef.current.children.length - 1] as THREE.Mesh | undefined;
        if (marker) { marker.rotation.y += dt * 2.4; marker.position.y = 2.15 + Math.sin(now * 3) * 0.06; }
      } else {
        hostageRef.current.visible = false;
      }
    }
    // DOWN or COMPLETE → restart the operation after a beat
    if (!snap.playerAlive && reviveAt.current === 0 && now - downAt.current > 2.2 && !endOnDeath) restartMission();
    // MISSION COMPLETE holds for a beat, then hands off to the debrief interstitial.
    if (completeAt.current > 0 && performance.now() - completeWallAt.current > 2200 && !advanced.current) {
      advanced.current = true;
      const st = sim.snapshot().stats;
      onComplete({ kills: st.kills, headshots: st.headshots, record: FIELD.record() }); // per-run performance → capped skill bonus
    }

    updateHud(snap);
  });

  // ── helpers bound to refs ──
  /** A short line under the crosshair: what you just picked up, or why you couldn't. */
  function toast(text: string, color = '#e9edf2') {
    if (!text) return;
    fieldToast.current = { text, color, until: performance.now() + 2600 };
  }

  /** Nothing solid between two points (walls, crates, vehicles). */
  function losClear(a: [number, number, number], b: [number, number, number]): boolean {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-3) return true;
    const dir: Vec3 = [dx / d, dy / d, dz / d];
    for (const c of COLLIDERS) {
      const t = rayAABB(a as Vec3, dir, aabbOfCover(c));
      if (t !== null && t < d - 0.35) return false;
    }
    return true;
  }

  /** What I shows: the thing you're looking at, or the weapon in your hands. */
  function openInspector() {
    if (!onInspect) return;
    const t = FIELD.target;
    const ownStatus = (g: GunId) => (g === PRIMARY && hasChosenGun ? 'owned' as const : LOADOUT.includes(g) ? 'standard' as const : 'battlefield' as const);
    if (t?.kind === 'weapon' && t.gun) onInspect({ type: 'weapon', gun: t.gun, status: t.origin === 'enemy' ? 'battlefield' : ownStatus(t.gun), mag: t.mag, reserve: t.reserve });
    else if (t?.kind === 'ammo_crate' || t?.kind === 'pouch') onInspect({ type: 'ammo', cls: t.ammoClass ?? 'rifle', rounds: t.rounds ?? 0 });
    else if (t?.kind === 'med_case') onInspect({ type: 'med', count: t.medkits ?? 0 });
    else if (t?.kind === 'cargo_case' || t?.kind === 'seized_case') onInspect({ type: 'cargo', resource: (FIELD.spec.cargoLabel ?? 'cargo').toLowerCase(), units: t.units ?? 0, seized: t.kind === 'seized_case' });
    else onInspect({ type: 'weapon', gun: sim.gun.id, status: ownStatus(sim.gun.id), mag: sim.ammo, reserve: Number.isFinite(sim.reserve) ? sim.reserve : undefined });
  }

  /** Turn what the field runtime did this frame into sound, radio, and the sim. */
  function onFieldEvent(fe: FieldEvent) {
    switch (fe.kind) {
      case 'ammo':
        audio.pickup();
        toast(`+${fe.rounds} ${fe.cls.toUpperCase()} ROUNDS${fe.left > 0 ? ` · ${fe.left} LEFT IN THE CRATE` : ''}`, '#e6c766');
        break;
      case 'med':
        audio.pickup();
        toast(`+${fe.taken} FIELD DRESSING${fe.taken === 1 ? '' : 'S'} · H TO USE`, '#5fe0a8');
        break;
      case 'full':
        toast(fe.what === 'ammo' ? 'AMMUNITION FULL' : fe.what === 'med' ? 'CARRYING ALL THE DRESSINGS YOU CAN' : `HANDS FULL · ${CARRY_MAX} CASES AT MOST`, '#ffb454');
        break;
      case 'secured': {
        audio.reloadDone();
        const c = FIELD.items.get(fe.id);
        toast(c?.kind === 'seized_case' ? 'SEIZED CASE IN HAND · IT IS HEAVY' : `CASE SECURED · CARRYING ${fe.carried} · ${FIELD.carriedUnits} UNITS`, '#5fe0a8');
        say('cargoSecured');
        break;
      }
      case 'planted':
        audio.reloadDone();
        say('chargePlaced');
        if (fe.planted >= fe.total) {
          toast('BOTH CHARGES SET · FUSE LIT · GET CLEAR', '#ff8a5a');
          audio.alarm(5, 2); // the fuse is lit
          sim.setRoomActive(1, true); sim.setRoomActive(2, true);
        } else toast(`CHARGE SET · ${fe.planted}/${fe.total}`, '#ff8a5a');
        break;
      case 'detonation':
        for (const [x, z] of fe.at) {
          audio.explosion([x, 1, z]);
          const d = Math.hypot(pos.current.x - x, pos.current.z - z);
          if (d < BLAST_RADIUS && sim.playerAlive) {
            sim.playerHp = Math.max(1, sim.playerHp - Math.round(80 * (1 - d / BLAST_RADIUS)));
            vignetteHit.current = 1;
          }
          shake.current = Math.min(0.08, shake.current + (d < 25 ? 0.05 : 0.015));
        }
        say('detonation');
        toast('THE LINE IS BURNING', '#ff8a5a');
        sim.reinforce(2, 2);
        break;
      case 'extractCalled':
        say('extractCalled');
        audio.extractCall(); audio.setExtraction(true);
        toast(FIELD.spec.exfil?.mode === 'handover' ? 'HANDOVER SIGNALLED · HOLD THE ZONE' : 'EXTRACTION CALLED · HOLD THE ZONE', '#5fe0a8');
        break;
      case 'extractLeft':
        say('extractBroken');
        audio.extractLeft(); audio.setExtraction(false);
        toast('OUTSIDE THE ZONE · COUNTDOWN SLIPPING', '#ff6a5a');
        break;
      case 'extracted': {
        say('extractDone');
        audio.setExtraction(false); audio.extractSuccess();
        const k = FIELD.spec.kind;
        const label = FIELD.spec.cargoLabel ?? '';
        const units = fe.carried.reduce((n, id) => n + (FIELD.items.get(id)?.units ?? 0), 0);
        extractedLabel.current = k === 'raid' ? `EXTRACTED · ${fe.carried.length} CASE${fe.carried.length === 1 ? '' : 'S'} · ${units} ${label}`
          : k === 'recovery' ? `HANDED OVER · ${units} ${label}`
          : k === 'sabotage' ? 'EXTRACTED · CHARGES SET' : 'EXTRACTED';
        break;
      }
      case 'refused':
        toast(fe.why, '#ffb454');
        break;
      case 'weapon':
        audio.reloadDone();
        if (fe.ammoOnly) toast(`+${fe.reserve} ROUNDS FROM THE ${getGun(fe.gun).name.toUpperCase()}`, '#e6c766');
        else {
          swapRaise.current = 1;
          toast(`${getGun(fe.gun).name.toUpperCase()} · ${fe.mag}/${fe.reserve}${fe.swapped ? ` · ${getGun(fe.swapped).name.toUpperCase()} LEFT ON THE GROUND` : ''} · BATTLEFIELD PICKUP`, '#e9edf2');
        }
        break;
      case 'dropped':
        break;
    }
  }

  /** True if a point (inflated by `pad`) sits inside any wall or crate. */
  function blocked(x: number, z: number, pad: number): boolean {
    for (const c of COLLIDERS) {
      if (Math.abs(x - c.x) < c.w / 2 + pad && Math.abs(z - c.z) < c.d / 2 + pad) return true;
    }
    return false;
  }

  /** Last-resort eject if the body is already buried in geometry (shoved off a corpse,
   *  clamped into a wall). Normal movement never reaches an inside state because
   *  slideMove blocks at the entry face; this only catches the degenerate cases. */
  function ejectFromGeometry(x: number, z: number): { x: number; z: number } {
    let cx = x, cz = z;
    for (const c of COLLIDERS) {
      const hx = c.w / 2 + PLAYER_R, hz = c.d / 2 + PLAYER_R;
      const dx = cx - c.x, dz = cz - c.z;
      if (Math.abs(dx) < hx && Math.abs(dz) < hz) {
        const px = hx - Math.abs(dx), pz = hz - Math.abs(dz);
        if (px < pz) cx = c.x + Math.sign(dx || 1) * hx;
        else cz = c.z + Math.sign(dz || 1) * hz;
      }
    }
    return { x: cx, z: cz };
  }

  /** Move the player from their CURRENT position (ox,oz) toward (x,z), sliding along
   *  walls so they can never pass through one. Takes the origin, not just the target,
   *  because blocking has to know which face the body is entering (see slideMove). */
  function clampAndSlide(ox: number, oz: number, x: number, z: number): { x: number; z: number } {
    // Swept slide against every wall + crate — solid, no tunnelling on a slow frame.
    let [cx, cz] = slideMove(ox, oz, x, z, PLAYER_R, COLLIDERS);
    if (endless) {
      // The endless chain runs toward -Z without end, so the authored arena box below
      // would pin the player at z = -17.6 and stall them in room 1. Bound them to the
      // LIVE chain window instead: they can always push forward into generated rooms,
      // never back out through the entry, and never past the last room built so far.
      const rooms = chain.current.rooms;
      const back = rooms.length ? rooms[0].zNear : 0;
      const front = rooms.length ? rooms[rooms.length - 1].zFar : -1;
      cx = Math.max(-ENDLESS_HALF_W, Math.min(ENDLESS_HALF_W, cx));
      cz = Math.max(front + 0.5, Math.min(back - 0.2, cz));
    } else if (LEVEL) {
      // A structured level: its own bounds (its fences and walls do the real work).
      const B = LEVEL.bounds;
      cx = Math.max(B.minX + 0.4, Math.min(B.maxX - 0.4, cx));
      cz = Math.max(B.minZ + 0.4, Math.min(B.maxZ - 0.4, cz));
    } else {
      // Arena bounds.
      cx = Math.max(-9.4, Math.min(9.4, cx));
      cz = Math.max(-17.6, Math.min(17.4, cz));
    }

    // You cannot walk through people either.
    const rr = PLAYER_R + 0.35;
    for (const e of sim.getEnemies()) {
      if (!e.alive) continue;
      const dx = cx - e.x, dz = cz - e.z;
      const d = Math.hypot(dx, dz);
      if (d < rr && d > 1e-4) { cx = e.x + (dx / d) * rr; cz = e.z + (dz / d) * rr; }
    }
    // Being shoved off a body (or clamped) must not leave us inside a wall.
    ({ x: cx, z: cz } = ejectFromGeometry(cx, cz));
    return { x: cx, z: cz };
  }

  /** The tracer LINE: muzzle -> impact, held for a beat so you can see it. */
  function spawnBeam(from: THREE.Vector3, to: Vec3, enemyRound: boolean) {
    const i = beamHead.current = (beamHead.current + 1) % BEAMS;
    const m = beamRefs.current[i];
    if (!m) return;
    const b = tmp.set(to[0], to[1], to[2]);
    const len = from.distanceTo(b);
    m.position.copy(from).lerp(b, 0.5);
    m.lookAt(b);
    m.scale.set(enemyRound ? 1.5 : 1, enemyRound ? 1.5 : 1, len);
    (m.material as THREE.MeshBasicMaterial).color.setHex(enemyRound ? 0xff7a44 : 0xffe6a8);
    m.visible = true;
    beamUntil.current[i] = sim.time + (enemyRound ? 0.09 : 0.05);
  }

  /** Launch a visible round from `from` to `to`. It sparks on arrival, not on fire. */
  function spawnBullet(from: THREE.Vector3, to: Vec3, isHit: boolean, enemyRound: boolean, normal: Vec3 | null = null) {
    const i = bulletHead.current = (bulletHead.current + 1) % BULLETS;
    const m = bulletRefs.current[i];
    const st = bullets.current[i];
    if (!m) return;
    st.from.copy(from);
    st.to.set(to[0], to[1], to[2]);
    const speed = enemyRound ? ENEMY_BULLET_SPEED : PLAYER_BULLET_SPEED;
    st.dur = Math.max(0.02, st.from.distanceTo(st.to) / speed);
    st.t = 0; st.active = true; st.hit = isHit; st.normal = normal;
    m.scale.set(enemyRound ? 1.1 : 1, enemyRound ? 1.1 : 1, enemyRound ? 0.8 : 1);
    (m.material as THREE.MeshBasicMaterial).color.setHex(enemyRound ? 0xff6a3a : 0xffe6a8);
    m.position.copy(st.from);
    m.visible = true;
  }

  /** You went down: the weapon leaves your hands, tumbles, and lands on the deck
   *  where it stays until the op restarts. Thrown roughly the way you were facing,
   *  because a rifle dropped by a falling body carries their momentum. */
  function dropWeapon(cam: THREE.Camera) {
    const id = sim.gun.id;
    if (!dropMeshes[id]) return;
    for (const gid of ALL_GUN_IDS) dropMeshes[gid].visible = gid === id;
    dropId.current = id;
    // Own vector, not the frame loop's shared scratch: this runs from the event
    // drain, where `tmp`/`tmp2` are live with the muzzle position.
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    dropPhysics.current.throwFrom(cam.position, fwd, cam.quaternion);
  }

  /** A guard's weapon leaves their hands as they fall, tumbles and comes to rest. */
  function dropEnemyWeapon(enemyId: number) {
    const en = sim.getEnemies().find((x) => x.id === enemyId);
    if (!en) return;
    const gun: GunId = (en.dmgMult ?? 1) < 1 ? 'sidearm' : 'assault_rifle';
    const mag = getGun(gun).magazine;
    // What they hadn't fired yet, and one spare magazine (deterministic per guard).
    const left = Math.max(2, Math.round(mag * (0.35 + ((enemyId * 37) % 50) / 100)));
    const item = FIELD.dropWeapon(en.x, en.z, gun, left, mag, 'enemy');
    if (enemyDrops.current.size >= 8) return; // a burst of kills: the rest just lie where they fell
    const d = new DroppedWeapon({ restY: DROP_REST_Y });
    const a = (enemyId * 2.399) % (Math.PI * 2);
    d.throwFrom(new THREE.Vector3(en.x, 1.25, en.z), new THREE.Vector3(Math.cos(a), -0.2, Math.sin(a)).normalize(), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, a, 0)));
    enemyDrops.current.set(item.id, d);
  }

  function stepEnemyDrops(dt: number) {
    for (const [id, d] of enemyDrops.current) {
      const item = FIELD.items.get(id);
      if (!item || item.state !== 'idle') { enemyDrops.current.delete(id); continue; }
      d.step(dt, (x, z, nx, nz) => slideMove(x, z, nx, nz, 0.12, COLLIDERS), (x, y, z) => audio.impact('wall', [x, y, z]));
      item.pos = [d.position.x, d.position.z];
      item.pose = { y: d.position.y, q: [d.quaternion.x, d.quaternion.y, d.quaternion.z, d.quaternion.w] };
      if (!d.active || d.landed) enemyDrops.current.delete(id);
    }
  }

  /** Put the weapon back in your hands (a restart, a new wave, a new op). */
  function holsterWeapon() {
    dropPhysics.current.clear();
    dropId.current = null;
    for (const gid of ALL_GUN_IDS) dropMeshes[gid].visible = false;
  }

  /** Ballistic tumble → clatter → lie still, then copy onto the mesh. */
  function stepDroppedWeapon(dt: number) {
    const d = dropPhysics.current;
    const id = dropId.current;
    if (!d.active || !id) return;
    d.step(
      dt,
      // Stopped by exactly the geometry the player is: a gun thrown at a crate
      // lands in front of it, not inside it.
      (x, z, nx, nz) => slideMove(x, z, nx, nz, 0.12, COLLIDERS),
      (x, y, z) => audio.impact('wall', [x, y, z]),
    );
    const mesh = dropMeshes[id];
    mesh.position.copy(d.position);
    mesh.quaternion.copy(d.quaternion);
  }

  /** What a round landing here is going through. The sim only knows "a box" — the
   *  scene is what knows that the boxes in LEVEL_COVER are scorched planking and
   *  everything else is the compound's brick and plaster. */
  function surfaceAt(at: Vec3, normal: Vec3): ImpactSurface {
    if (normal[1] > 0.9 && at[1] < 0.06) return 'dirt';
    for (const c of LEVEL_COVER) {
      if (
        Math.abs(at[0] - c.x) <= c.w / 2 + 0.08
        && Math.abs(at[2] - c.z) <= c.d / 2 + 0.08
        && at[1] <= c.h + 0.08
      ) return 'wood';
    }
    return 'concrete';
  }

  /** How big a burst the ACTIVE weapon throws. Rides the muzzle-flash scale each gun
   *  is already tuned with, so a new gun gets a matching impact for free. */
  function impactPower(): number {
    const f = GUN_FEEL[sim.gun.id] ?? feel;
    return Math.max(0.7, Math.min(1.5, f.flashScale));
  }

  /** A round lands: flash, sparks, dust, chips, and a hole left in the surface. */
  function spawnImpact(at: Vec3, normal: Vec3, surface: ImpactSurface, power = 1) {
    impactFx.burst(at, normal, surface, power);
  }

  /** A hit on a BODY sprays back toward whoever fired it, so the mist is visible to
   *  the shooter instead of being hidden behind the target. */
  function spawnFleshImpact(at: Vec3, shotFrom: THREE.Vector3) {
    const dx = shotFrom.x - at[0], dy = shotFrom.y - at[1], dz = shotFrom.z - at[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    impactFx.burst(at, [dx / len, dy / len, dz / len], 'flesh', 1);
  }

  /** The blood a body leaves where it went down. Read off the SIM rather than the
   *  rig, because the rig for a dead enemy is about to be recycled onto whoever
   *  spawns next — by the time it moves, the pool has to already be on the floor. */
  function spawnDeathPool(enemyId: number) {
    const e = sim.getEnemies().find((en) => en.id === enemyId);
    if (e) impactFx.pool([e.x, 0, e.z], 1);
  }

  function flashHit(enemyId: number, killed = false) {
    const idx = sim.getEnemies().findIndex((e) => e.id === enemyId);
    if (idx >= 0) {
      dummyFlash.current[idx] = sim.time + 0.12;
      // they FLINCH when your round lands (sped up: the raw clip is ~2.4s)
      if (!killed) rigApis.current[idx]?.playOnce('hit', 2.6);
    }
  }

  /** The full-screen down card. Reads SECOND WIND when the attempt continues, so
   *  you know in the moment whether to expect to get back up or to start over. */
  function showDown(text: string, color: string) {
    const el = hud.current.down;
    if (!el) return;
    el.textContent = text;
    el.style.color = color;
    el.style.fontSize = text.length > 8 ? '30px' : '46px';
    el.style.opacity = '1';
  }

  /** Pips for the second winds left in this attempt, beside the health bar. Only
   *  touches the DOM when the count actually changes — this is called per frame. */
  function paintRefills() {
    const el = hud.current.refills;
    if (!el || refillsShown.current === refills.current) return;
    refillsShown.current = refills.current;
    el.innerHTML = Array.from({ length: REFILLS }, (_, i) =>
      `<span style="color:${i < refills.current ? '#5fe0a8' : '#39434d'}">&#9679;</span>`).join(' ');
  }

  function flashHitmarker(killed: boolean, crit = false) {
    const el = hud.current.hit;
    if (!el || settingsRef?.current.interface.hitMarkers === false) return;
    el.style.opacity = '1';
    // A kill always reads red; a non-lethal crit pops gold + a touch bigger so the
    // random burst of damage is legible in the moment.
    el.style.color = killed ? palette().hostile : crit ? '#ffc72a' : '#ffffff';
    el.style.transform = `translate(-50%,-50%) scale(${killed ? 1.5 : crit ? 1.3 : 1})`;
    window.setTimeout(() => { if (el) el.style.opacity = '0'; }, killed ? 220 : crit ? 180 : 130);
  }

  /** First-time tips: shown once each (and only with tips on), for 7 s. */
  const tipNow = useRef<{ until: number; shown: Set<Tip>; medkits: number }>({ until: 0, shown: new Set(), medkits: -1 });
  function showTip(t: Tip, text: string) {
    const el = hud.current.tip;
    if (!el || settingsRef?.current.interface.tips === false || tipNow.current.shown.has(t) || tipSeen(t)) return;
    tipNow.current.shown.add(t);
    markTipSeen(t);
    el.textContent = text;
    el.style.opacity = '1';
    tipNow.current.until = performance.now() + 7000;
  }

  /** The colour set in force (Settings → Accessibility → colour palette). */
  function palette() { return PALETTES[settingsRef?.current.access.palette ?? 'standard']; }

  function updateHud(snap: ReturnType<FpsSim['snapshot']>) {
    const h = hud.current;
    const ui = settingsRef?.current.interface;
    const binds = bindsNow().binds;
    if (h.ammo) {
      h.ammo.textContent = Number.isFinite(snap.reserve) ? `${snap.ammo} / ${snap.reserve}` : `${snap.ammo} / ${snap.magazine}`;
      h.ammo.style.color = snap.ammo === 0 ? '#ff4d3d' : snap.ammo <= 5 ? '#ffb454' : '#e9edf2';
    }
    if (h.reload && h.reloadBar) {
      if (snap.reloading) {
        h.reload.style.opacity = '1';
        const p = 1 - snap.reloadRemaining / sim.gun.reloadTime;
        h.reloadBar.style.width = `${Math.round(p * 100)}%`;
      } else {
        h.reload.style.opacity = '0';
      }
    }
    if (h.reloadHint) {
      // the prompt hides while reloading, and brightens when you're running low
      if (snap.reloading) h.reloadHint.style.opacity = '0';
      else { h.reloadHint.style.opacity = '1'; h.reloadHint.style.color = snap.ammo <= 5 ? '#ffb454' : '#6f7d8c'; }
    }
    if (h.kills) h.kills.textContent = `KILLS ${snap.stats.kills}   ·   HS ${snap.stats.headshots}`;
    if (h.fireMode) h.fireMode.textContent = snap.fireMode.toUpperCase();
    if (h.weapon) h.weapon.textContent = snap.gunName.toUpperCase();
    if (h.loadout) {
      // two-slot readout: the active weapon's number is bright, the other dim
      h.loadout.innerHTML = snap.loadout.length < 2 ? '' :
        snap.loadout.map((_, i) => `<span style="color:${i === snap.slot ? '#37d0e0' : '#7d8a96'}">${i + 1}</span>`).join('<span style="color:#39434d"> · </span>');
    }
    if (h.nvgTint) h.nvgTint.style.opacity = String(nvgAmt.current);
    if (h.scope) h.scope.style.opacity = String(snap.attachments.includes('optic') ? adsCur.current : 0);
    if (h.attachments) {
      // one chip per attachment; lit when active, dim + its key when not
      const on = new Set(snap.attachments);
      h.attachments.innerHTML = ATTACH_CHIPS.map((c) => {
        const active = on.has(c.id);
        return `<span style="font-size:10px;letter-spacing:1px;padding:3px 7px;border-radius:4px;border:1px solid ${active ? c.color : '#2a3440'};background:${active ? c.color + '22' : 'transparent'};color:${active ? c.color : '#7d8a96'}">${c.label}<span style="opacity:.55"> ${bindLabel(binds, c.id as Action)}</span></span>`;
      }).join('');
    }
    // Mobile kit chips carry no on/off state in their static style, so light them
    // here from the sim — a tapped optic/laser/nvg/light now visibly turns on.
    if (h.attachChips) {
      const onSet = new Set(snap.attachments);
      for (const c of ATTACH_CHIPS) {
        const el = h.attachChips[c.id];
        if (!el) continue;
        const active = onSet.has(c.id);
        el.style.borderColor = active ? c.color : `${c.color}77`;
        el.style.background = active
          ? `linear-gradient(180deg, ${c.color}66, ${c.color}22)`
          : `linear-gradient(180deg, ${c.color}1f, ${c.color}0a)`;
        el.style.boxShadow = active
          ? `0 0 10px ${c.color}66, inset 0 1px 0 ${c.color}55`
          : `inset 0 1px 0 ${c.color}33`;
        el.style.color = active ? '#fff' : c.color;
      }
    }
    if (h.lock) h.lock.style.opacity = locked.current ? '0' : '1';
    // crosshair gap grows with spread + recoil
    // (Settings → Interface: size scales gap and tick, a static crosshair ignores spread)
    const spread = sim.spreadFor(adsCur.current, false, crouchCur.current > 0.5);
    const chSize = ui?.crosshair.size ?? 1;
    const gap = ((ui?.crosshair.dynamic ?? true) ? 5 + spread * 620 + Math.abs(recoilP.current) * 340 : 5) * chSize;
    const len = 8 * chSize;
    const { t, b, l, r } = h.ch;
    if (t) t.style.transform = `translate(-50%, ${-gap - len}px)`;
    if (b) b.style.transform = `translate(-50%, ${gap}px)`;
    if (l) l.style.transform = `translate(${-gap - len}px, -50%)`;
    if (r) r.style.transform = `translate(${gap}px, -50%)`;
    if (h.chRing) { const d = Math.round((gap + len * 0.5) * 2); h.chRing.style.width = `${d}px`; h.chRing.style.height = `${d}px`; }

    paintRefills();   // no-ops unless the count moved
    // The score follows the fight: calm, alerted, under fire, boss.
    {
      let lvl: 0 | 1 | 2 | 3 = 0;
      for (const e of snap.enemies) {
        if (!e.alive || !e.active) continue;
        if (e.boss && e.ai !== 'hidden') { lvl = 3; break; }
        if (e.ai === 'aim' || e.ai === 'fire') lvl = 2;
        else if (e.ai !== 'hidden' && lvl < 1) lvl = 1;
      }
      audio.setMusicIntensity(lvl);
      // A site raises the alarm the first time its guards open fire, and escalates when the fuse is
      // down to its last seconds. Each fires once per run.
      if (LEVEL && lvl >= 2 && !alertedRef.current) { alertedRef.current = true; audio.alarm(4, 1); }
      const fuse = FIELD.fuseLeft;
      if (fuse > 0 && fuse <= 8 && !finalAlarmRef.current) { finalAlarmRef.current = true; audio.alarm(Math.max(3, Math.ceil(fuse)), 3); }
      // Guards on the move within earshot are heard: a step each time one has covered ground.
      const stepNow = performance.now();
      for (const e of snap.enemies) {
        if (!e.alive || !e.active || e.ai === 'hidden') continue;
        const last = enemyStepRef.current.get(e.id);
        if (!last) { enemyStepRef.current.set(e.id, { x: e.x, z: e.z, t: stepNow }); continue; }
        if (stepNow - last.t < 320) continue;
        const moved = Math.hypot(e.x - last.x, e.z - last.z);
        enemyStepRef.current.set(e.id, { x: e.x, z: e.z, t: stepNow });
        if (moved > 0.45) audio.enemyStep([e.x, 0, e.z]);
      }
    }
    // health bar + damage vignette (red flash on hit, and a base tint when low)
    if (h.healthFill) {
      const frac = Math.max(0, snap.playerHp / snap.maxPlayerHp);
      h.healthFill.style.width = `${frac * 100}%`;
      const pal = palette();
      h.healthFill.style.background = frac > 0.5 ? pal.healthHi : frac > 0.25 ? '#ffb454' : pal.healthLo;
    }
    if (h.vignette) {
      const lowHp = 1 - Math.min(1, snap.playerHp / 35);
      // Reduced flashes: the hit flash is a steady tint, never a full-screen pulse.
      const cap = settingsRef?.current.access.reduceFlashes ? 0.3 : 0.85;
      h.vignette.style.opacity = String(Math.min(cap, Math.max(vignetteHit.current, lowHp * 0.5)));
    }

    // mission HUD: current objective + distance, and the briefing fade
    const objN = OBJECTIVES[objective.current];
    if (h.objText) {
      if (survival) {
        // wave banner: count up between waves, "left" while fighting
        if (survOver.current) h.objText.style.opacity = '0';
        else if (survState.current === 'active') {
          h.objText.style.opacity = '1';
          h.objText.textContent = `WAVE ${survWave.current}  ·  ${snap.aliveCount} LEFT`;
        } else {
          h.objText.style.opacity = '1';
          const t = Math.max(0, Math.ceil((survNextAt.current - performance.now()) / 1000));
          h.objText.textContent = survWave.current === 0 ? `FIRST WAVE IN ${t}` : `WAVE ${survWave.current + 1} IN ${t}`;
        }
      } else if (objN && completeAt.current < 0 && sim.time > briefingUntil.current - 0.5) {
        h.objText.style.opacity = '1';
        const dm = Math.round(Math.hypot(pos.current.x - objN.pos[0], pos.current.z - objN.pos[1]));
        if (objN.kind === 'secure') {
          const total = FIELD.cases.length;
          h.objText.textContent = `OBJECTIVE  ·  ${objN.text}  ·  ${FIELD.carried.length}/${total} CASES${FIELD.carried.length ? '  ·  OR EXTRACT WITH WHAT YOU CARRY' : `  ·  ${dm}m`}`;
        } else if (objN.kind === 'plant' || objN.kind === 'retrieve') {
          h.objText.textContent = `OBJECTIVE  ·  ${objN.text}  ·  ${dm}m`;
        } else if (objN.kind === 'extract') {
          const z = FIELD.spec.exfil;
          if (FIELD.exfilPhase === 'counting' && z) {
            const inside = Math.hypot(pos.current.x - z.pos[0], pos.current.z - z.pos[1]) <= z.radius;
            h.objText.textContent = `${z.mode === 'handover' ? 'HANDOVER' : 'EXTRACTION'}  ·  ${Math.ceil(z.secs - FIELD.exfilProgress)}s  ·  ${inside ? 'HOLD THE ZONE' : 'GET BACK IN THE ZONE'}`;
          } else {
            h.objText.textContent = `OBJECTIVE  ·  ${objN.text}  ·  ${dm}m${dm <= (z?.radius ?? 3) ? `  ·  ${bindLabel(binds, 'interact')} TO CALL IT` : ''}`;
          }
        } else if (objN.kind === 'defend') {
          // a hold objective counts down the seconds you still owe on the point
          const left = Math.max(0, Math.ceil((objN.holdSecs ?? 20) - holdProgress.current));
          // Match the banking ring (HOLD_RADIUS), not the tighter reach ring, so holding
          // from adjacent cover reads as "HOLD" and never a misleading "GET TO THE POINT".
          const onPoint = Math.hypot(pos.current.x - objN.pos[0], pos.current.z - objN.pos[1]) < HOLD_RADIUS;
          h.objText.textContent = `OBJECTIVE  ·  ${objN.text}  ·  ${onPoint ? `HOLD ${left}s` : 'GET TO THE POINT'}`;
        } else {
          const d = Math.round(Math.hypot(pos.current.x - objN.pos[0], pos.current.z - objN.pos[1]));
          h.objText.textContent = `OBJECTIVE  ·  ${objN.text}  ·  ${d}m`;
        }
      } else {
        h.objText.style.opacity = '0';
      }
    }
    if (h.briefing) h.briefing.style.opacity = String(Math.max(0, Math.min(1, briefingUntil.current - sim.time)));
    // First-time tips, at the moments they matter (never over the fight's own HUD).
    if (sim.time > briefingUntil.current && completeAt.current < 0) {
      const k = (a: Action) => bindLabel(binds, a);
      showTip('controls', lowSpec
        ? 'Stick moves · drag to aim · fire pad shoots · hold USE on objects · pause top left'
        : `${k('moveForward')}${k('moveLeft')}${k('moveBack')}${k('moveRight')} move · mouse aims · click or ${k('fire')} fires · hold ${k('interact')} to use · ${k('reload')} reloads · Esc pauses`);
      const t = FIELD.target;
      if (t && (t.kind === 'ammo_crate' || t.kind === 'med_case' || t.kind === 'pouch')) showTip('loot', `Hold ${lowSpec ? 'USE' : k('interact')} until the bar fills. Rounds go straight to your reserve.`);
      // The first time you gain field dressings (a medical case, not the issued ones).
      if (tipNow.current.medkits >= 0 && snap.medkits > tipNow.current.medkits) showTip('heal', `Field dressing: ${lowSpec ? 'tap MED' : `press ${k('heal')}`} to heal. It takes a moment and lowers your weapon, so get into cover first.`);
      tipNow.current.medkits = snap.medkits;
      if (FIELD.carried.length > 0) showTip('cargo', `Cargo: carry up to ${CARRY_MAX}; each case slows you. Only what you carry out through extraction counts.`);
      if (FIELD.exfilPhase === 'counting' || t?.kind === 'exfil') showTip('extract', 'Extraction: stay in the zone for 8 seconds. Leaving bleeds the countdown; going down drops your cargo.');
    }
    if (h.tip && tipNow.current.until && performance.now() > tipNow.current.until) { h.tip.style.opacity = '0'; tipNow.current.until = 0; }

    // ── Field HUD ──
    {
      const t = FIELD.target;
      let prompt = '';
      if (t && snap.playerAlive && completeAt.current < 0) {
        const sameGun = t.kind === 'weapon' && !!t.gun && sim.loadout.includes(t.gun);
        const verb = t.kind === 'cargo_case' ? 'SECURE' : t.kind === 'seized_case' ? 'RETRIEVE' : t.kind === 'charge' ? '' : t.kind === 'exfil' ? '' : t.kind === 'weapon' ? (sameGun ? 'TAKE ROUNDS ·' : `SWAP ${getGun(sim.loadout[sim.slotFor(t.gun!)]).name.toUpperCase()} FOR`) : 'TAKE';
        const extra = t.kind === 'ammo_crate' || t.kind === 'pouch' ? ` · ${t.rounds} RDS` : t.kind === 'med_case' ? ` · ${t.medkits} LEFT` : t.kind === 'weapon' ? ` · ${t.mag}/${t.reserve}` : '';
        const p = t.holdSecs > 0 ? Math.round(Math.min(1, FIELD.hold / t.holdSecs) * 20) * 5 : 0;
        const label = t.kind === 'weapon' ? getGun(t.gun!).name.toUpperCase() : t.label;
        // Settings: the bound key, optional secondary hints, and a high-contrast panel.
        const hc = !!settingsRef?.current.access.highContrastPrompts;
        const cap = hc
          ? `<span style="display:inline-block;min-width:26px;padding:2px 8px;margin-right:10px;background:#fff;color:#000;border-radius:4px;font-weight:900">${bindLabel(binds, 'interact')}</span>`
          : `<span style="display:inline-block;min-width:22px;padding:1px 6px;margin-right:8px;border:1px solid #e9edf2;border-radius:4px;font-weight:800">${bindLabel(binds, 'interact')}</span>`;
        const hint = ui?.promptHints === false ? '' : `<div style="margin-top:3px;font-size:${hc ? 13 : 11}px;letter-spacing:2px;color:${hc ? '#fff' : '#8a97a3'}">${bindLabel(binds, 'inspect')} · INSPECT</div>`;
        const body = `<div style="font-size:${hc ? 17 : 15}px;letter-spacing:2px;color:#fff;font-weight:${hc ? 800 : 400}">${cap}${verb ? verb + ' ' : ''}${label}${extra}</div>${hint}`
          + `<div style="margin:6px auto 0;width:180px;height:${hc ? 6 : 4}px;background:${hc ? '#555' : '#ffffff22'};border-radius:2px;overflow:hidden"><div style="height:100%;width:${p}%;background:${palette().success}"></div></div>`;
        prompt = hc ? `<div data-hc="1" style="display:inline-block;background:#000;border:2px solid #fff;border-radius:8px;padding:8px 14px;text-shadow:none">${body}</div>` : body;
      }
      const ft = fieldToast.current;
      if (performance.now() < ft.until) prompt += `<div style="margin-top:8px;font-size:13px;letter-spacing:2px;color:${ft.color}">${ft.text}</div>`;
      if (snap.healing) prompt += `<div style="margin-top:6px;font-size:12px;letter-spacing:2px;color:#5fe0a8">DRESSING THE WOUND</div>`;
      const inv: string[] = [];
      if (Number.isFinite(snap.reserve)) inv.push(`<span style="color:#9fb4c8">DRESSINGS</span> ${snap.medkits} <span style="opacity:.55">[${bindLabel(binds, 'heal')}]</span>`);
      if (FIELD.cases.length) {
        const c = FIELD.carried.length;
        inv.push(`<span style="color:#9fb4c8">CARGO</span> ${c}/${CARRY_MAX}${c ? ` · ${FIELD.carriedUnits} ${FIELD.spec.cargoLabel ?? ''}` : ''}${c ? ` · <span style="color:#ffb454">-${Math.round((1 - FIELD.speedMult) * 100)}% SPEED</span>` : ''}`);
      }
      if (FIELD.spec.charges?.length) inv.push(`<span style="color:#9fb4c8">CHARGES</span> ${FIELD.planted.length}/${FIELD.spec.charges.length}${FIELD.fuseAt > 0 && !FIELD.detonated ? ' · <span style="color:#ff6a5a">FUSE LIT</span>' : ''}`);
      const html = prompt + '\u0001' + inv.join('<br/>');
      if (html !== lastFieldHtml.current) {
        lastFieldHtml.current = html;
        if (h.fieldPrompt) h.fieldPrompt.innerHTML = prompt;
        if (h.field) h.field.innerHTML = inv.join('<br/>');
      }
      if (h.fieldExfil) {
        const z = FIELD.spec.exfil;
        if (z && FIELD.exfilPhase === 'counting') {
          h.fieldExfil.style.opacity = '1';
          const inside = Math.hypot(pos.current.x - z.pos[0], pos.current.z - z.pos[1]) <= z.radius;
          h.fieldExfil.style.color = inside ? palette().success : palette().hostile;
          h.fieldExfil.textContent = `${Math.max(0, Math.ceil(z.secs - FIELD.exfilProgress))}`;
        } else h.fieldExfil.style.opacity = '0';
      }
    }

    // boss health bar (top-centre) — only while a boss is alive on a boss op
    if (h.bossWrap && h.bossFill && h.bossName) {
      const boss = mission.boss ? snap.enemies.find((e) => e.boss && e.alive) : undefined;
      if (boss) {
        h.bossWrap.style.opacity = '1';
        // name + phase pips (I / II / III) so the escalation reads on the HUD
        h.bossName.textContent = `${mission.name}${boss.phase >= 2 ? '  ·  ' + (['', '', 'II', 'III'][boss.phase] ?? '') : ''}`;
        h.bossFill.style.width = `${Math.max(0, Math.round((boss.hp / boss.maxHp) * 100))}%`;
        // a hotter bar as it enrages, and a glow pulse on the moment it escalates
        h.bossFill.style.background = boss.phase >= 3 ? 'linear-gradient(90deg,#ff2a1e,#ff6a3d)' : 'linear-gradient(90deg,#ff4d3d,#e0455a)';
        h.bossWrap.style.filter = bossFlash.current > 0.02 ? `drop-shadow(0 0 ${Math.round(10 * bossFlash.current)}px #ff3020)` : 'none';
      } else {
        h.bossWrap.style.opacity = '0';
      }
    }

    // earn loop: rank + progress toward the next rank. The bar SIZE varies now that
    // the ladder is progressive, so it is read per-rank rather than being a constant.
    const rank = rankForXp(careerXp.current);
    const into = xpIntoRank(careerXp.current);
    const bar  = xpBarSize(careerXp.current);
    if (h.rankText) {
      h.rankText.textContent = `${rank.toUpperCase()}  ·  ${into} / ${bar} XP`;
      h.rankText.style.color = RANK_COLORS[rank];
    }
    if (h.xpBar) {
      h.xpBar.style.width = `${Math.round((into / bar) * 100)}%`;
      h.xpBar.style.background = RANK_COLORS[rank];
    }
  }

  // ── Earn loop: XP per kill → 1000 → rank up → G$ ──
  function popXp(amount: number) {
    const i = xpPopHead.current = (xpPopHead.current + 1) % XP_POPS;
    const el = hud.current.xpPops[i];
    if (!el) return;
    el.textContent = `+${amount} XP`;
    el.style.transition = 'none';
    el.style.opacity = '1';
    el.style.transform = 'translate(-50%, 0)';
    void el.offsetHeight; // reflow so the float replays on rapid kills
    el.style.transition = 'opacity .9s ease-out, transform .9s ease-out';
    el.style.opacity = '0';
    el.style.transform = 'translate(-50%, -46px)';
  }

  function showRankUp(rank: Rank) {
    audio.reward();
    if (hud.current.rankUpRank) {
      hud.current.rankUpRank.textContent = rank.toUpperCase();
      hud.current.rankUpRank.style.color = RANK_COLORS[rank];
    }
    if (hud.current.rankUpG) hud.current.rankUpG.textContent = "";
    const el = hud.current.rankUp;
    if (el) {
      el.style.opacity = '1';
      window.setTimeout(() => { if (el) el.style.opacity = '0'; }, 3200);
    }
  }

  function addXp(amount: number) {
    popXp(amount); // floating "+N" — the REAL value you'll be credited (see = get)
    const before = careerXp.current;
    const after = before + amount;
    careerXp.current = after; // the bar climbs LIVE as you kill — a running preview
    // Signed in: the SERVER owns rank + G$. The live bar previews what you're earning
    // (kills are real XP now, so it reconciles truthfully at op-end); the actual rank-up
    // and its payout are confirmed on the debrief, never guessed locally mid-fight.
    if (accountRank) return;
    // Sandbox / signed-out: the local total is the only source of truth — celebrate here.
    try { window.localStorage.setItem(XP_KEY, String(after)); } catch { /* private mode */ }
    for (const r of rankUpsBetween(before, after)) showRankUp(r);
  }

  // ── Story presence: the fight is where the story arrives, never a menu ──
  /** Queue a trigger's lines. Fires at most once per operation. */
  function say(trigger: PresenceTrigger) {
    if (storyFired.current.has(trigger)) return;
    storyFired.current.add(trigger);
    for (const line of linesFor(trigger, mission.radio)) voQueue.current.push(line);
  }

  /** One line at a time: radio static + subtitle, held long enough to read. */
  function pumpStory(now: number) {
    const h = hud.current;
    // Hold the whole story until a gesture has unlocked audio. Otherwise the
    // opening line is dequeued into silence (autoplay blocked) and never repeats.
    if (!audio.isUnlocked()) return;
    if (voQueue.current.length && now >= voUntil.current) {
      const line = voQueue.current.shift()!;
      audio.vo(line.id, line.speaker);
      const meta = SPEAKER_META[line.speaker];
      const subs = settingsRef?.current.subtitles;
      if (h.subName) { h.subName.textContent = meta.name; h.subName.style.color = subs?.speakerColors === false ? '#e9edf2' : meta.color; }
      if (h.subText) h.subText.textContent = line.text;
      // Subtitles off: the radio still plays, the text doesn't.
      if (h.subWrap) h.subWrap.style.opacity = subs?.on === false ? '0' : '1';
      voStartedAt.current = now;
      voCurrentId.current = line.id;
      voUntil.current = now + Math.max(2.8, line.text.length * 0.055); // read-speed guess
    } else if (now >= voUntil.current && h.subWrap) {
      h.subWrap.style.opacity = '0';
      voCurrentId.current = null;
    }
    // Once the recording's real length is known, hold the caption for all of it —
    // the text-length guess can cut a slow line off.
    const id = voCurrentId.current;
    if (id) {
      const d = audio.voDuration(id);
      if (d) voUntil.current = Math.max(voUntil.current, voStartedAt.current + d + 0.45);
    }
  }

  function restartMission() {
    holsterWeapon();               // pick the rifle back up
    // A fresh attempt gets a fresh second wind.
    refills.current = REFILLS;
    reviveAt.current = 0;
    paintRefills();
    storyFired.current.clear();
    voQueue.current.length = 0;
    voUntil.current = 0;
    voCurrentId.current = null;
    voStartedAt.current = 0;
    if (hud.current.subWrap) hud.current.subWrap.style.opacity = '0';
    sim.resetEncounter();
    sim.setAllActive(false);
    objective.current = 0;
    holdProgress.current = 0; lastReinforceAt.current = 0;
    briefingUntil.current = sim.time + 3.5;
    completeAt.current = -99;
    advanced.current = false;
    pos.current.set(START[0], EYE_STAND, START[1]);
    yaw.current = 0; pitch.current = 0;
    vignetteHit.current = 0;
    if (hud.current.down) hud.current.down.style.opacity = '0';
    if (hud.current.complete) hud.current.complete.style.opacity = '0';
    staggerP.current = 0; staggerY.current = 0; shake.current = 0;
    shoveX.current = 0; shoveZ.current = 0;
    // survival: clear the field and reset the wave counter for a fresh run
    if (survival) {
      sim.despawnAll();
      survWave.current = 0; survState.current = 'intermission'; survNextAt.current = performance.now() + 3000;
      survOver.current = false; survInit.current = true;
      if (hud.current.survEnd) { hud.current.survEnd.style.opacity = '0'; hud.current.survEnd.style.pointerEvents = 'none'; }
    }
  }

  // Rotate the red damage indicator to point at where the shot came from.
  function showHitDir(fromDir: Vec3) {
    const el = hud.current.hitDir;
    if (!el || settingsRef?.current.interface.damageDirection === false) return;
    const cy = Math.cos(yaw.current), sy = Math.sin(yaw.current);
    const f = fromDir[0] * -sy + fromDir[2] * -cy; // forward component
    const rr = fromDir[0] * cy + fromDir[2] * -sy; // right component
    el.style.opacity = '1';
    el.style.transform = `rotate(${Math.atan2(rr, f)}rad)`;
    window.setTimeout(() => { if (el) el.style.opacity = '0'; }, 500);
  }

  // ── Render ──
  return (
    <>
      <color attach="background" args={[theme.bg]} />
      <fog attach="fog" args={theme.fog} />
      <SkyDome top={theme.sky.top} bottom={theme.sky.bottom} />

      {/* low ash-lit sun + cold fill, then restrained practicals so darkness has
          shape. Point-light intensity is in physical units: single digits, not tens. */}
      <hemisphereLight args={theme.hemi} />
      <directionalLight
        ref={sunRef}
        position={LEVEL ? [levelCx + 22, 34, levelCz + 26] : [9, 16, 10]} intensity={theme.sun.intensity} color={theme.sun.color} castShadow={plan.shadows}
        shadow-mapSize={[lightFx ? 1024 : 2048, lightFx ? 1024 : 2048]}
        shadow-camera-left={-(LEVEL?.shadowHalf ?? 22)} shadow-camera-right={LEVEL?.shadowHalf ?? 22}
        shadow-camera-top={LEVEL?.shadowHalf ?? 22} shadow-camera-bottom={-(LEVEL?.shadowHalf ?? 22)}
        shadow-camera-far={LEVEL ? 140 : 70} shadow-bias={-0.0008}
      />
      {/* The sun's aim point. Authored ops all fit inside the shadow camera's ±22
          box around the origin, but an endless run walks hundreds of metres past it,
          so in endless both the light and this target ride along with the player. */}
      <object3D ref={sunTargetRef} />
      <directionalLight position={[-10, 7, -12]} intensity={theme.fill.intensity} color={theme.fill.color} />
      {/* `minimal` lifts ambient to pay back some of the light the practicals below
          are no longer providing, so the compound reads as dim rather than black. */}
      <ambientLight intensity={minimal ? theme.ambient * 1.9 : theme.ambient} />
      {/* practicals are ACCENTS, not floodlights: they shape darkness, not expose it.
          They are placed for the authored compound and sit near the origin with a 9-10m
          falloff, so in endless the player leaves them behind in the first room and they
          become four lights lighting nothing — while still costing every lit material a
          slot in its shader's light loop. Endless runs daylight and drops them.

          `minimal` drops them too, and this is the tier's biggest remaining lever.
          Cost here is PER PIXEL, not per object: three.js compiles NUM_POINT_LIGHTS
          from how many point lights are in the scene, so every lit fragment in the
          frame walks the whole list — and it does so whatever their intensity, which
          is why the two flash lights further down count even while dark. Six point
          lights plus two directionals plus a hemisphere is a heavy shader to run over
          every pixel of a compound, and NO quality tier was touching it: it is
          invisible to draw calls and triangle counts, which is exactly why the
          geometry work did not fix a phone that was fill-bound rather than
          vertex-bound. Dropping these four leaves the two flash lights, which have to
          stay — they are the "someone fired" read. */}
      {!endless && !minimal && !LEVEL && <>
        <pointLight position={[0, 2.6, 12]} intensity={theme.practicalIntensity * 0.9} distance={9} decay={2} color={theme.practical} />
        <pointLight position={[0, 2.6, 4]} intensity={theme.practicalIntensity} distance={10} decay={2} color={theme.practical} />
        <pointLight position={[0, 2.6, -4]} intensity={theme.practicalIntensity} distance={10} decay={2} color={theme.practical} />
        <pointLight position={[-3, 2.6, -13]} intensity={theme.practicalIntensity * 0.9} distance={9} decay={2} color={theme.practical} />
      </>}

      {/* burned ground */}
      {/* endless rides this plane along under the player (see the endless flow), so
          the chain can run to -Z forever without an enormous floor */}
      <mesh ref={floorRef} rotation={[-Math.PI / 2, 0, 0]} position={LEVEL ? [levelCx, 0, levelCz] : undefined} receiveShadow>
        <planeGeometry args={LEVEL ? [LEVEL.bounds.maxX - LEVEL.bounds.minX + 120, LEVEL.bounds.maxZ - LEVEL.bounds.minZ + 120] : [FLOOR_W, endless ? ENDLESS_FLOOR_D : FLOOR_D]} />
        {/* World-space texturing pins the ground to the WORLD, not to the plane, so
            the endless floor can jump along Z to follow the player without the
            texture visibly sliding under their feet. */}
        <primitive object={shellMaterials.floor} attach="material" />
      </mesh>

      {/* compound walls: brick perimeter, plastered interior dividers, each capped
          with a concrete coping so the tops read as built, not sliced graybox */}
      {/* Keys are the box's own geometry, not its array index. Endless prunes rooms
          off the FRONT of this list, which shifts every later index and would make
          React re-render every wall in the world on each room advance — a hitch per
          doorway. Keyed this way, the walls that didn't change keep their identity. */}
      {LEVEL && <LevelArt level={LEVEL} minimal={minimal} lit={mission.zone !== 'DUSTLINE'} night={mission.conditions ? mission.conditions.phase === 'night' : undefined} calm={settingsRef?.current.access.reduceFlashes} />}
      {!LEVEL && LEVEL_WALLS.map((c, i) => (
        <group key={`w${c.x}_${c.z}_${c.w}_${c.d}`}>
          {/* Every wall SHARES one unit cube and is scaled to size. Authoring a fresh
              boxGeometry per wall allocates and frees a GPU buffer per wall — fine for
              a fixed mission, but endless streams rooms in and out continuously, so it
              meant churning ~10 GPU buffers every time the player crossed a doorway. */}
          <mesh geometry={UNIT_BOX} position={[c.x, c.h / 2, c.z]} scale={[c.w, c.h, c.d]} castShadow receiveShadow>
            <primitive object={i < 3 ? shellMaterials.brick : shellMaterials.plaster} attach="material" />
          </mesh>
          {/* The coping is a decorative cap on top of a wall. Endless drops it entirely:
              it doubles the wall mesh count and every one of those is a draw call, for a
              detail you do not read at all in a procedurally generated corridor. */}
          {!endless && (
            <mesh geometry={UNIT_BOX} position={[c.x, c.h + 0.02, c.z]} scale={[c.w + 0.14, 0.18, c.d + 0.14]} castShadow receiveShadow>
              <primitive object={shellMaterials.coping} attach="material" />
            </mesh>
          )}
        </group>
      ))}

      {/* cover: scorched planking */}
      {!LEVEL && LEVEL_COVER.map((c) => (
        <mesh key={`c${c.x}_${c.z}_${c.w}_${c.d}`} geometry={UNIT_BOX} position={[c.x, c.h / 2, c.z]} scale={[c.w, c.h, c.d]} castShadow receiveShadow>
          <primitive object={shellMaterials.plank} attach="material" />
        </mesh>
      ))}

      {/* set dressing: barrels, crates, sandbags, rubble hugging the walls. Solid
          now — the footprints went into COLLIDERS above. Dropped on `minimal`
          (struggling desktop/laptop) to cut draw calls; the colliders stay, so on
          that tier alone the clutter is felt rather than seen. */}
      {plan.dressing && <SetDressing props={DRESSING} mats={propMaterials} />}

      {/* the op's physical objects: supplies, cargo, charges, the extraction zone */}
      <FieldProps field={FIELD} lowSpec={lowSpec || minimal} guns={gunProtos} calm={settingsRef?.current.access.reduceFlashes} />

      {/* waypoint beacon at the current objective */}
      <group ref={waypointRef}>
        <mesh position={[0, 2.3, 0]}>
          <octahedronGeometry args={[0.34, 0]} />
          <meshBasicMaterial color="#37d0e0" transparent opacity={0.9} />
        </mesh>
        <mesh position={[0, 1.15, 0]}>
          <cylinderGeometry args={[0.05, 0.05, 2.3, 6]} />
          <meshBasicMaterial color="#37d0e0" transparent opacity={0.32} />
        </mesh>
      </group>

      {/* the hostage: a distinct unarmed friendly, marked cyan so it never reads
          as a target. Shown only on rescue ops; positioned each frame from the sim. */}
      <group ref={hostageRef} visible={false}>
        <mesh position={[0, 1.18, 0]} castShadow>
          <capsuleGeometry args={[0.22, 0.7, 4, 8]} />
          <meshStandardMaterial color="#8fdce6" emissive="#1c6c78" emissiveIntensity={0.5} roughness={0.7} />
        </mesh>
        <mesh position={[0, 1.72, 0]} castShadow>
          <sphereGeometry args={[0.17, 12, 12]} />
          <meshStandardMaterial color="#cfeef2" emissive="#2a7c88" emissiveIntensity={0.4} roughness={0.8} />
        </mesh>
        {/* floating friendly marker (downward chevron) */}
        <mesh position={[0, 2.15, 0]} rotation={[Math.PI, 0, 0]}>
          <coneGeometry args={[0.2, 0.32, 4]} />
          <meshBasicMaterial color="#37e0c0" transparent opacity={0.92} />
        </mesh>
      </group>

      {/* enemies: rifle-carrying operator rigs. Placeholder body, real animation —
          the mesh swaps out without touching clip names or the skeleton. */}
      {ENEMY_SLOTS.map((e, i) => (
        <group key={i} ref={(g) => { dummyRefs.current[i] = g; }} position={[e.pos[0], 0, e.pos[1]]}>
          <OperatorRig ref={(a) => { rigApis.current[i] = a; }} modelPath={OPERATOR_GLB} />
        </group>
      ))}

      {/* co-op teammates: same rig, no weapon tint — never a target, never
          hostile. Hidden by default; the frame loop's coop section decides
          each frame who (if anyone) occupies which slot. */}
      {!!coop && Array.from({ length: MAX_PARTY_SIZE - 1 }).map((_, i) => (
        <group key={`coop-${i}`} ref={(g) => { teammateRefs.current[i] = g; }} visible={false}>
          <OperatorRig ref={(a) => { teammateRigApis.current[i] = a; }} modelPath={OPERATOR_GLB} />
        </group>
      ))}

      {/* viewmodel — all five guns mounted; the frame loop shows only the active one */}
      <group ref={vmRef}>
        {ALL_GUN_IDS.map((id) => (
          <primitive key={id} object={gunMeshes[id]} />
        ))}
        {/* The hands are children of each GUN (see gunMeshes), not of this group,
            so they ride the weapon through ADS, recoil and the wall pullback. What
            used to be here was a single 6cm cube of brown that the framing never
            actually put on screen. */}
      </group>

      {/* the weapon after you go down: in the world, not in your hands */}
      <group>
        {ALL_GUN_IDS.map((id) => (
          <primitive key={id} object={dropMeshes[id]} />
        ))}
      </group>

      {/* attachments: flashlight cone + laser line/dot (positioned each frame) */}
      <primitive object={flashLight} />
      <primitive object={flashLight.target} />
      <primitive object={laserLine} />
      <primitive object={laserDot} />

      {/* muzzle flash + light */}
      <pointLight ref={muzzleLight} distance={9} decay={2} intensity={0} color="#ffd39a" />
      <mesh ref={flashRef} visible={false}>
        <sphereGeometry args={[1, 8, 6]} />
        <meshBasicMaterial color="#ffdca0" transparent opacity={0.9} />
      </mesh>

      {/* enemy muzzle flashes + shared light */}
      <pointLight ref={eLight} distance={11} decay={2} intensity={0} color="#ffd089" />
      {Array.from({ length: EFLASH }).map((_, i) => (
        <mesh key={i} ref={(m) => { eFlashRefs.current[i] = m; }} visible={false}>
          <sphereGeometry args={[1, 8, 6]} />
          <meshBasicMaterial color="#ffe08a" transparent opacity={0.95} />
        </mesh>
      ))}

      {/* tracer lines: muzzle -> impact */}
      {Array.from({ length: BEAMS }).map((_, i) => (
        <mesh key={`b${i}`} ref={(m) => { beamRefs.current[i] = m; }} visible={false}>
          <boxGeometry args={[0.02, 0.02, 1]} />
          <meshBasicMaterial color="#ffe6a8" transparent opacity={0.85} />
        </mesh>
      ))}

      {/* bullets in flight: yours warm, theirs hot orange */}
      {Array.from({ length: BULLETS }).map((_, i) => (
        <mesh key={i} ref={(m) => { bulletRefs.current[i] = m; }} visible={false}>
          <boxGeometry args={[0.035, 0.035, 0.6]} />
          <meshBasicMaterial color="#ffe6a8" transparent opacity={0.95} />
        </mesh>
      ))}

      {/* impacts: sparks, dust, debris and the bullet holes they leave behind.
          Five instanced draw calls for the whole firefight, however heavy it gets. */}
      <primitive object={impactFx.group} />

      {/* ── bodycam post ── C3: the LIGHT stack drops N8AO (a whole normal re-render
          pass) and Bloom (a mipmap blur) — the two priciest effects — keeping only the
          cheap chromatic edge + vignette that sell the "lens". Used on touch AND on any
          desktop/laptop that can't hold framerate on the full stack (adaptive: see the
          PerformanceMonitor → `degraded` in ContractZeroScene). Capable machines keep the full look. */}
      {/* Endless always takes the LIGHT stack. N8AO runs `enableNormalPass`, which is a
          second full render of the scene every frame — affordable on an authored op,
          not on top of a streamed four-room compound and a pool of skinned characters.
          It also buys least exactly here, on flat generated boxes. */}
      {/* `minimal` runs NO composer at all. Even the two-effect light stack is not
          cheap the way an effect count suggests: mounting a composer redirects the
          whole scene into an offscreen render target and then blits it back through
          each pass, so the frame pays several extra FULL-SCREEN reads and writes on
          top of the one it needed. That is pure fill cost, and fill is precisely what
          a struggling phone has least of. The chromatic edge and vignette are lens
          flavour; a playable frame rate is not. */}
      {plan.post === 'off' ? null : (plan.post === 'light' || endless) ? (
        <EffectComposer multisampling={0}>
          <ChromaticAberration offset={caOffset} radialModulation modulationOffset={0.35} blendFunction={BlendFunction.NORMAL} />
          <Vignette darkness={0.5} offset={0.3} blendFunction={BlendFunction.NORMAL} />
        </EffectComposer>
      ) : LEVEL ? (
        // Structured levels: bloom for the practicals, but no N8AO. Its normal pass
        // re-renders a 60 m level every frame for contact shadows the sun map gives anyway.
        <EffectComposer multisampling={0}>
          {mission.zone !== 'DUSTLINE' ? <Bloom intensity={0.22} luminanceThreshold={0.85} luminanceSmoothing={0.2} mipmapBlur /> : <></>}
          <ChromaticAberration offset={caOffset} radialModulation modulationOffset={0.35} blendFunction={BlendFunction.NORMAL} />
          <Vignette darkness={0.5} offset={0.3} blendFunction={BlendFunction.NORMAL} />
        </EffectComposer>
      ) : (
        <EffectComposer multisampling={0} enableNormalPass>
          <N8AO aoRadius={1.4} intensity={2.6} distanceFalloff={1} quality="medium" color="#0a0a0e" />
          <Bloom intensity={0.18} luminanceThreshold={0.9} luminanceSmoothing={0.2} mipmapBlur />
          <ChromaticAberration offset={caOffset} radialModulation modulationOffset={0.35} blendFunction={BlendFunction.NORMAL} />
          <Noise premultiply blendFunction={BlendFunction.SCREEN} opacity={0.3} />
          <Vignette darkness={0.5} offset={0.3} blendFunction={BlendFunction.NORMAL} />
        </EffectComposer>
      )}
    </>
  );
}

/**
 * The Operations board (mission select). Soft-gated: every op up to your
 * furthest-unlocked is replayable; the rest are locked. Grouped by zone so the
 * three theatres of the campaign read at a glance.
 */
function MissionSelect({ current, progress, onPick, onSurvival, onGauntlet, gauntletUnlocked, onClose }: {
  current: number; progress: number; onPick: (i: number) => void; onSurvival: () => void;
  onGauntlet: () => void; gauntletUnlocked: boolean; onClose: () => void;
}) {
  const zones = CAMPAIGN.reduce<Record<string, { m: Mission; i: number }[]>>((acc, m, i) => {
    (acc[m.zone] ??= []).push({ m, i });
    return acc;
  }, {});
  const zoneOrder = Array.from(new Set(CAMPAIGN.map((m) => m.zone)));

  return (
    <div
      style={{ position: 'absolute', inset: 0, zIndex: 40, background: 'rgba(3,6,10,.985)', color: '#e9edf2', fontFamily: UI_FONT, cursor: 'auto', pointerEvents: 'auto', overflowY: 'auto', padding: '30px 24px 40px' }}
      onClick={onClose}
    >
      <div style={{ maxWidth: 760, margin: '0 auto' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 22 }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: 8, color: '#37d0e0' }}>TRAINING</div>
            <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: 4 }}>OPERATIONS</div>
          </div>
          <button
            onClick={onClose}
            style={{ pointerEvents: 'auto', cursor: 'pointer', background: 'transparent', border: '1px solid #37d0e0', color: '#37d0e0', fontFamily: 'inherit', fontSize: 13, letterSpacing: 2, padding: '8px 14px', borderRadius: 5 }}
          >
            {iconRow('chevron', 'RESUME', 14)}
          </button>
        </div>

        {zoneOrder.map((zone) => {
          const theme = ZONE_THEMES[zone];
          return (
            <div key={zone} style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 12, letterSpacing: 5, color: theme?.practical ?? '#9fb4c8', marginBottom: 10, borderBottom: `1px solid ${theme?.practical ?? '#2a3440'}55`, paddingBottom: 6 }}>
                {zone}
              </div>
              <div style={{ display: 'grid', gap: 10 }}>
                {zones[zone].map(({ m, i }) => {
                  const locked = i > progress;
                  const cleared = i < progress;
                  const isCurrent = i === current;
                  const accent = m.boss ? '#e0455a' : '#37d0e0';
                  return (
                    <button
                      key={m.id}
                      disabled={locked}
                      onClick={() => !locked && onPick(i)}
                      style={{
                        pointerEvents: 'auto', textAlign: 'left', font: 'inherit',
                        cursor: locked ? 'not-allowed' : 'pointer',
                        display: 'flex', alignItems: 'center', gap: 14,
                        padding: '12px 16px', borderRadius: 7,
                        border: `1px solid ${isCurrent ? accent : locked ? '#1a2028' : '#2a3440'}`,
                        background: locked ? 'rgba(255,255,255,.015)' : isCurrent ? `${accent}14` : 'rgba(255,255,255,.04)',
                        opacity: locked ? 0.45 : 1, color: 'inherit',
                      }}
                    >
                      <div style={{ width: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', color: accent }}>
                        <Icon name={locked ? 'lock' : m.boss ? 'alert' : cleared ? 'check' : 'chevron'} size={18} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                          <span style={{ fontSize: 11, letterSpacing: 2, color: '#6f7d8c' }}>OP {i + 1}</span>
                          <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: 1, color: m.boss ? accent : '#e9edf2' }}>{m.name}</span>
                          {m.boss && <span style={{ fontSize: 10, letterSpacing: 2, color: accent, border: `1px solid ${accent}66`, padding: '1px 6px', borderRadius: 3 }}>BOSS</span>}
                        </div>
                        <div style={{ fontSize: 12, color: '#9fb4c8', marginTop: 3 }}>{locked ? 'clear the previous operation to unlock' : m.brief}</div>
                      </div>
                      <div style={{ fontSize: 10, letterSpacing: 2, color: isCurrent ? accent : cleared ? '#5fe0a8' : '#6f7d8c' }}>
                        {isCurrent ? 'CURRENT' : cleared ? 'CLEARED' : locked ? 'LOCKED' : 'READY'}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* Survival — always available, sits apart from the campaign */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 12, letterSpacing: 5, color: '#ff5a52', marginBottom: 10, borderBottom: '1px solid #ff5a5255', paddingBottom: 6 }}>ENDLESS</div>
          <button
            onClick={onSurvival}
            style={{ pointerEvents: 'auto', textAlign: 'left', font: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 14, width: '100%', padding: '12px 16px', borderRadius: 7, border: '1px solid #ff5a5255', background: 'rgba(255,90,82,.08)', color: 'inherit' }}
          >
            <div style={{ width: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ff5a52' }}><Icon name="infinity" size={20} /></div>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: 1, color: '#ff8a7a' }}>SURVIVAL</span>
                <span style={{ fontSize: 10, letterSpacing: 2, color: '#ff5a52', border: '1px solid #ff5a5266', padding: '1px 6px', borderRadius: 3 }}>THE KILL-HOUSE</span>
              </div>
              <div style={{ fontSize: 12, color: '#9fb4c8', marginTop: 3 }}>endless waves · every kill still pays XP · how long can you hold?</div>
            </div>
            <div style={{ fontSize: 10, letterSpacing: 2, color: '#ff5a52' }}>OPEN</div>
          </button>

          {/* Gauntlet — the prestige, ranked tier. Locked until the campaign is done. */}
          <button
            onClick={() => gauntletUnlocked && onGauntlet()}
            disabled={!gauntletUnlocked}
            style={{ pointerEvents: 'auto', textAlign: 'left', font: 'inherit', cursor: gauntletUnlocked ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', gap: 14, width: '100%', marginTop: 10, padding: '12px 16px', borderRadius: 7, border: `1px solid ${gauntletUnlocked ? '#e0b737' : '#2a3440'}`, background: gauntletUnlocked ? 'rgba(224,183,55,.08)' : 'rgba(255,255,255,.015)', opacity: gauntletUnlocked ? 1 : 0.5, color: 'inherit' }}
          >
            <div style={{ width: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', color: gauntletUnlocked ? '#e0b737' : '#6f7d8c' }}><Icon name={gauntletUnlocked ? 'alert' : 'lock'} size={20} /></div>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: 1, color: gauntletUnlocked ? '#e6c766' : '#9fb4c8' }}>GAUNTLET</span>
                <span style={{ fontSize: 10, letterSpacing: 2, color: '#e0b737', border: '1px solid #e0b73766', padding: '1px 6px', borderRadius: 3 }}>RANKED</span>
              </div>
              <div style={{ fontSize: 12, color: '#9fb4c8', marginTop: 3 }}>{gauntletUnlocked ? 'harder every wave · your best run climbs the season leaderboard' : 'finish the campaign to unlock the ranked Gauntlet'}</div>
            </div>
            <div style={{ fontSize: 10, letterSpacing: 2, color: gauntletUnlocked ? '#e0b737' : '#6f7d8c' }}>{gauntletUnlocked ? 'RANKED' : 'LOCKED'}</div>
          </button>
        </div>

        <div style={{ fontSize: 11, color: '#7d8a96', letterSpacing: 1, textAlign: 'center', marginTop: 8 }}>
          selecting an operation restarts it from the breach · press M to toggle this board
        </div>
      </div>
    </div>
  );
}

/** Server-authoritative reward for a cleared op (a structural subset of the app's
 *  FightReward). The debrief shows THIS — the real XP / rank-up / G$ — never a local
 *  guess, so a rank-up and its G$ only ever appear when the server actually paid them. */
export interface OpReward {
  xpAwarded: number;
  rankedUp: boolean;
  newRank: string | null;
  gAwarded: number;      // rank-up G$ actually credited (0 unless a real rank-up landed)
  bountyAwarded: number; // first-clear G$ actually credited
  firstClear: boolean;
}

/**
 * The between-mission debrief. After an op is cleared this takes over: it shows
 * the story lead-in for what's next and lets the player DEPLOY into it, RETRY the
 * op they just finished, or EXIT to the Operations board. On the last op it
 * becomes the campaign's ending instead.
 */
function MissionDebrief({ mode, cleared, next, reward, onDeploy, onRetry, onExit }: {
  mode: 'next' | 'finale'; cleared: Mission; next: Mission | null; reward: OpReward | null;
  onDeploy: () => void; onRetry: () => void; onExit: () => void;
}) {
  const btn = (color: string): React.CSSProperties => ({
    pointerEvents: 'auto', cursor: 'pointer', background: 'transparent', border: `1px solid ${color}`,
    color, fontFamily: 'inherit', fontSize: 12, letterSpacing: 3, padding: '11px 22px', borderRadius: 5,
  });
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 40, background: 'rgba(3,6,10,.97)', color: '#e9edf2', fontFamily: UI_FONT, cursor: 'auto', pointerEvents: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '30px 24px' }}>
      <div style={{ maxWidth: 620, textAlign: 'center' }}>
        {/* The REAL, server-confirmed reward for the op just cleared. A rank-up / G$
            line only appears when the server actually credited it. */}
        {reward && (
          <div style={{ marginBottom: 22 }}>
            <div style={{ fontSize: 14, letterSpacing: 3, color: '#5fe0a8', fontWeight: 700 }}>+{reward.xpAwarded} XP</div>
            {reward.bountyAwarded > 0 && (
              <div style={{ fontSize: 12, letterSpacing: 2, color: '#ffcf5f', marginTop: 7 }}>{reward.firstClear ? 'FIRST CLEAR BONUS' : 'OP BOUNTY'} · +{reward.bountyAwarded} CR</div>
            )}
            {reward.rankedUp && reward.newRank && (
              <div style={{ fontSize: 16, letterSpacing: 3, color: '#37d0e0', fontWeight: 800, marginTop: 7 }}>RANK UP → {reward.newRank.toUpperCase()} · +{reward.gAwarded} CR</div>
            )}
          </div>
        )}
        {mode === 'finale' ? (
          <>
            <div style={{ fontSize: 13, letterSpacing: 8, color: '#9fb4c8' }}>THE FIRE IS OUT</div>
            <div style={{ fontSize: 48, fontWeight: 800, letterSpacing: 5, margin: '10px 0', color: '#ff5a47' }}>DIRECTOR DOWN</div>
            <div style={{ fontSize: 14, color: '#c6b4ae', letterSpacing: 1, lineHeight: 1.6 }}>You walked all the way into the dark and out the other side. The radio is quiet now. Ashfall can begin again.</div>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 30 }}>
              <button onClick={onRetry} style={btn('#ff8a7a')}>{iconRow('refresh', 'REPLAY FINALE', 14)}</button>
              <button onClick={onExit} style={btn('#9fb4c8')}>{iconRow('menu', 'OPERATIONS', 14)}</button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 12, letterSpacing: 6, color: '#5fe0a8' }}>{cleared.name} · CLEARED</div>
            <div style={{ width: 60, height: 1, background: '#2a3440', margin: '18px auto' }} />
            <div style={{ fontSize: 12, letterSpacing: 6, color: '#37d0e0' }}>{next?.op}</div>
            <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: 3, margin: '8px 0 14px' }}>{next?.name}</div>
            <div style={{ fontSize: 15, color: '#c7d2dc', letterSpacing: 0.3, lineHeight: 1.7 }}>{next?.story ?? next?.brief}</div>
            <div style={{ fontSize: 12, color: '#7f8c99', letterSpacing: 1, marginTop: 12 }}>{next?.brief}</div>
            <div style={{ fontSize: 13, letterSpacing: 3, color: '#9fb4c8', marginTop: 26 }}>ready?</div>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 12 }}>
              <button onClick={onDeploy} style={{ ...btn('#37d0e0'), background: 'rgba(55,208,224,.12)', fontWeight: 700 }}>{iconRow('play', 'DEPLOY', 13)}</button>
              <button onClick={onRetry} style={btn('#9fb4c8')}>{iconRow('refresh', 'RETRY', 14)}</button>
              <button onClick={onExit} style={btn('#6f7d8c')}>{iconRow('menu', 'EXIT', 14)}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Outcome stats for a contract run. `secs` is wall time from deploy to the end. */
export interface ContractRunStats { kills: number; headshots: number; secs: number; record?: FieldRecord }

export interface ContractRun {
  mission: Mission;
  /** Open the server mission session. Resolve false to hold the scene on Retry. */
  onStart?: () => Promise<boolean>;
  onExtracted: (stats: ContractRunStats) => void;
  onKilled: (stats: ContractRunStats) => void;
  /** The mission protocol events, streamed to the server as they happen. */
  onProtocol?: (events: ProtoEvent[]) => void;
}

export function ContractZeroScene({ contract, onOpStart, onOpCleared, onOpFailed, startMission, resumeLevel, accountRank, accountXp, equippedGun, equippedAmmo, equippedMods, fieldKit, onExit, endless, seasonal, coop }: {
  /** Boot straight into an ENDLESS run on the generated room chain, bypassing the
   *  campaign entirely. Present for Campaign Endless and the Seasonal Campaign;
   *  absent everywhere else. */
  endless?: EndlessOpts;
  /** CONTRACT ZERO: run exactly this one contract mission. The page owns the
   *  flow around it (board → loadout → here → extraction results), so the scene
   *  hands the outcome back instead of advancing a campaign. */
  contract?: ContractRun;
  /** Co-op Endless (party mode) — present only when `endless` is also present
   *  AND the run is a party, not solo. See `CoopOpts`. */
  coop?: CoopOpts;
  /** Label the run as the Seasonal Campaign rather than Campaign Endless. Cosmetic
   *  only — the rules difference lives in what the page passes as `endless`
   *  (seasonal always starts at wave 1 and never resumes). */
  seasonal?: boolean;
  /** Leave the fight entirely and return to the mode-select page (Campaign /
   *  Live PvP / Challenge). `/fight` wires this to router.push('/battle'). In a
   *  standalone PWA there is NO browser back button, so this is the only way out —
   *  surfaced both as a HUD "EXIT" button and inside the pause menu. */
  onExit?: () => void;
  /** Fires when a campaign op BEGINS (1-based level) — `/fight` uses it to open a
   *  server-authoritative fight session (the anti-forgery token). Resolves TRUE once a
   *  session is confirmed (or the player is signed out); FALSE if the server can't be
   *  reached, which puts the scene on a Retry gate instead of into an uncounted run.
   *  Omitted at `/dev/verb`. */
  onOpStart?: (level: number) => Promise<boolean> | void;
  /** Fires when a campaign op is cleared — `/fight` uses it to record the real,
   *  server-authoritative reward (XP → rank → G$). Omitted at `/dev/verb`, which
   *  stays a self-contained sandbox. */
  onOpCleared?: (level: number, stats?: { kills: number; headshots: number }) => Promise<OpReward | null> | void;
  /** Fires when the player is KILLED on a campaign op (once per death). `/fight` uses
   *  it to record the loss on-chain (player as loser) via the sessionless flat path,
   *  which never touches the op token — the in-place retry still clears for full
   *  reward. Omitted at `/dev/verb`. */
  onOpFailed?: (stats?: { kills: number; headshots: number }) => void;
  /** Boot straight into this operation index (chosen on the external Operations
   *  list). Selection lives OUTSIDE the game, so we drop right into the op. */
  startMission?: number;
  /** Server-authoritative campaign progress (pve_level = ops cleared). When no op is
   *  chosen, RESUME here — survives a sign-out that cleared local storage, and unlocks
   *  the board up to it (so progress is never lost to a fresh device/session). */
  resumeLevel?: number;
  /** The real account rank + XP-into-rank (C1). When present, the in-game rank bar
   *  reflects your true server standing instead of a local number. */
  accountRank?: Rank;
  accountXp?: number;
  /** The player's equipped marketplace gun (A). Raises the floor of each op's
   *  issued weapon — you carry whichever tier is higher. Omitted at `/dev/verb`. */
  equippedGun?: GunId;
  /** The player's equipped ammo + stat attachments (B) — folded into gun stats
   *  and, for incendiary, a burn DoT. Omitted at `/dev/verb`. */
  equippedAmmo?: AmmoId;
  equippedMods?: Partial<Record<AttachmentSlot, AttachmentId>>;
  /** Standard-issue field kit chosen on the Loadout screen (flashlight / NVG /
   *  laser), fitted on top of whatever the op issues. */
  fieldKit?: Attachment[];
} = {}) {
  // Server progress (ops cleared), clamped to a valid campaign index — the resume
  // target and the unlock floor.
  const serverResume = typeof resumeLevel === 'number' && resumeLevel >= 0
    ? Math.min(resumeLevel, CAMPAIGN.length - 1) : -1;
  const hud = useRef<Hud>({
    root: null, ammo: null, fireMode: null, weapon: null, loadout: null, attachments: null, nvgTint: null, scope: null, reload: null, reloadBar: null, reloadHint: null, hit: null,
    ch: { t: null, b: null, l: null, r: null }, chDot: null, chRing: null, tip: null, lock: null, kills: null,
    healthFill: null, refills: null, vignette: null, hitDir: null, down: null, arrows: [],
    field: null, fieldPrompt: null, fieldExfil: null, objText: null, survEnd: null, survEndText: null, waveHud: null, waveLabel: null, waveRooms: null, waveDone: null, waveDoneText: null, waveDoneSub: null, objArrow: null, briefing: null, complete: null, perf: null,
    lockReticle: null,
    adsBtn: null,
    crouchBtn: null,
    attachChips: {},
    rankText: null, xpBar: null, xpPops: [], rankUp: null, rankUpRank: null, rankUpG: null,
    subWrap: null, subName: null, subText: null,
    bossWrap: null, bossName: null, bossFill: null,
  });

  // Mobile is a first-class target: a left move-stick, a right
  // look-pad, and fire/ADS/reload buttons write into this, read by FpsWorld.
  const controls = useRef<Controls>({ moveX: 0, moveY: 0, lookX: 0, lookY: 0, lookSens: loadLookSens(), fire: false, ads: false, crouch: false, reload: false, fireMode: false, swap: false, interact: false, heal: false, toggle: null, lockCycle: false, tapAimX: null, tapAimY: null });
  const audio = useMemo(() => new FpsAudio(), []);
  useEffect(() => () => audio.dispose(), [audio]);

  // ── Mission campaign (slice 8): run CAMPAIGN[missionIndex]; complete → next ──
  // A `startMission` (from the external Operations list) wins over the resume slot.
  const [missionIndex, setMissionIndex] = useState(() => {
    if (typeof startMission === 'number' && startMission >= 0 && startMission < CAMPAIGN.length) return startMission;
    if (serverResume >= 0) return serverResume; // resume at the server's next op (survives sign-out)
    try { const v = Number(window.localStorage.getItem(CAMPAIGN_KEY)); if (Number.isFinite(v) && v >= 0 && v < CAMPAIGN.length) return v; } catch { /* private mode */ }
    return 0;
  });
  const [campaignDone, setCampaignDone] = useState(false);
  // How far you've unlocked (soft gating). Never behind the op you started on OR the
  // server's cleared progress, so a chosen op is always reachable and progress isn't
  // lost when local storage is cleared.
  const [progress, setProgress] = useState(() => {
    try {
      const p = Number(window.localStorage.getItem(PROGRESS_KEY));
      const m = Number(window.localStorage.getItem(CAMPAIGN_KEY));
      return Math.min(CAMPAIGN.length, Math.max(Number.isFinite(p) ? p : 0, Number.isFinite(m) ? m : 0, startMission ?? 0, serverResume, 0));
    } catch { return Math.max(startMission ?? 0, serverResume, 0); }
  });
  const [runNonce, setRunNonce] = useState(0); // bump to remount = restart the op
  const [selectOpen, setSelectOpen] = useState(false);
  const [paused, setPaused] = useState(false); // C4: deliberate pause menu (Esc / ⏸)
  const menuOpenRef = useRef(false); // read by FpsWorld's frame loop to pause
  const [inspecting, setInspecting] = useState<InspectItem | null>(null);
  const inspectingRef = useRef(false);
  const openInspect = useCallback((item: InspectItem) => {
    inspectingRef.current = true;
    try { document.exitPointerLock?.(); } catch { /* ignore */ }
    setInspecting(item);
  }, []);
  const closeInspect = useCallback(() => { inspectingRef.current = false; setInspecting(null); }, []);
  const setSelect = (v: boolean) => {
    menuOpenRef.current = v; setSelectOpen(v);
    if (v) { try { document.exitPointerLock?.(); } catch { /* ignore */ } }
  };
  const [mode, setMode] = useState<'campaign' | 'survival' | 'gauntlet' | 'endless' | 'contract'>(contract ? 'contract' : endless ? 'endless' : 'campaign');
  const contractRef = useRef(contract);
  contractRef.current = contract;
  const [debrief, setDebrief] = useState<null | 'next' | 'finale'>(null);
  const [lastReward, setLastReward] = useState<OpReward | null>(null); // real server reward for the debrief
  const missionStartWall = useRef(performance.now()); // for the op's clear time
  // Latest onOpStart in a ref so firing it can't churn the op-start effect's deps.
  const onOpStartRef = useRef(onOpStart);
  onOpStartRef.current = onOpStart;
  // ── Server-readiness gate ──
  // A campaign op must open a server session (the token that makes it count) BEFORE the
  // fight begins. We freeze the sim and show a "connecting / retry" screen until that
  // token is confirmed, so a cold or asleep server can never let you play a run that
  // silently won't count. 'ok' = clear to fight; 'connecting' / 'error' = frozen.
  const [gate, setGate] = useState<'ok' | 'connecting' | 'error'>('ok');
  const gateRef = useRef(false);             // read by the frame loop to freeze the sim
  const gateConnectRef = useRef<(() => void) | null>(null); // Retry re-runs this
  // The PREVIOUS op's completion request. Starting the next op must wait for it: clearing
  // op N advances pve_level SERVER-side, and op N+1's session-start is unlock-gated
  // (level ≤ pve_level+1). Deploying before the clear records would 403 the next op and
  // strand the player on the gate — this ordering closes that race.
  const pendingClear = useRef<Promise<unknown> | null>(null);
  useEffect(() => {
    missionStartWall.current = performance.now();
    // Only campaign ops carry a server session; survival/gauntlet aren't gated here, and
    // /dev/verb (no onOpStart) plays ungated too.
    const startFn = mode === 'contract'
      ? contractRef.current?.onStart
      : mode === 'campaign' ? (() => onOpStartRef.current?.(missionIndex + 1)) : undefined;
    if (!startFn || (mode === 'campaign' && !onOpStartRef.current)) { setGate('ok'); gateRef.current = false; return; }
    let cancelled = false;
    const connect = () => {
      setGate('connecting'); gateRef.current = true;
      (async () => {
        // Let the prior op's clear finish recording first (bounded, so a slow/hung one
        // can't strand us — the unlock check + Retry cover the rest).
        if (pendingClear.current) {
          await Promise.race([pendingClear.current.catch(() => {}), new Promise((r) => setTimeout(r, 12000))]);
        }
        if (cancelled) return;
        const ok = await Promise.resolve(startFn());
        if (cancelled) return;
        if (ok === false) { setGate('error'); gateRef.current = true; }      // frozen, offer Retry
        else { setGate('ok'); gateRef.current = false; missionStartWall.current = performance.now(); }
      })();
    };
    gateConnectRef.current = connect;
    connect();
    return () => { cancelled = true; };
  }, [missionIndex, runNonce, mode]);
  const retryConnect = () => gateConnectRef.current?.();
  const mission = mode === 'contract' && contract ? contract.mission
    : mode === 'endless' ? (seasonal ? SEASONAL_MISSION : ENDLESS_MISSION)
    : mode === 'gauntlet' ? GAUNTLET_MISSION
    : mode === 'survival' ? SURVIVAL_MISSION
    : CAMPAIGN[Math.min(missionIndex, CAMPAIGN.length - 1)];
  // The Gauntlet is a prestige tier — earned by finishing the campaign.
  const gauntletUnlocked = progress >= CAMPAIGN.length;

  const unlock = (upto: number) => setProgress((pr) => {
    const np = Math.min(CAMPAIGN.length, Math.max(pr, upto));
    try { window.localStorage.setItem(PROGRESS_KEY, String(np)); } catch { /* ignore */ }
    return np;
  });
  const advance = () => {
    unlock(missionIndex + 1); // clearing an op unlocks the next
    if (missionIndex + 1 >= CAMPAIGN.length) { setCampaignDone(true); return; }
    const next = missionIndex + 1;
    try { window.localStorage.setItem(CAMPAIGN_KEY, String(next)); } catch { /* ignore */ }
    setMissionIndex(next);
  };
  const pickMission = (i: number) => {
    if (i < 0 || i >= CAMPAIGN.length || i > progress) return;
    try { window.localStorage.setItem(CAMPAIGN_KEY, String(i)); } catch { /* ignore */ }
    setMode('campaign');
    setCampaignDone(false);
    setSelect(false);
    setMissionIndex(i);
    setRunNonce((n) => n + 1); // force a fresh mount even if it's the same op
  };
  const pickSurvival = () => {
    setMode('survival');
    setCampaignDone(false);
    setDebrief(null);
    setSelect(false);
    setRunNonce((n) => n + 1);
  };
  const pickGauntlet = () => {
    if (!gauntletUnlocked) return; // prestige tier — locked until the campaign is done
    setMode('gauntlet');
    setCampaignDone(false);
    setDebrief(null);
    setSelect(false);
    setRunNonce((n) => n + 1);
  };

  // ── Between-mission debrief: clear an op → story of the next → deploy/retry/exit ──
  const clearComplete = () => { if (hud.current.complete) hud.current.complete.style.opacity = '0'; };
  const handleComplete = (stats: { kills: number; headshots: number; record?: FieldRecord }) => {
    if (mode === 'contract') {
      menuOpenRef.current = true; // freeze the scene; the page takes over
      try { document.exitPointerLock?.(); } catch { /* ignore */ }
      contractRef.current?.onExtracted({ ...stats, secs: (performance.now() - missionStartWall.current) / 1000 });
      return;
    }
    unlock(missionIndex + 1); // the next op is unlocked the moment this one is cleared
    const last = missionIndex >= CAMPAIGN.length - 1;
    if (last) setCampaignDone(true);
    setDebrief(last ? 'finale' : 'next');
    menuOpenRef.current = true;                 // freeze the scene behind the debrief
    try { document.exitPointerLock?.(); } catch { /* ignore */ }
    // Record the op with the server (kills/headshots feed the capped skill bonus) and
    // surface the REAL reward on the debrief. Clear any prior reward first so a stale
    // one never flashes while this one is recording.
    setLastReward(null);
    // Hold the completion promise so the NEXT op's session-start waits for it (the clear
    // advances pve_level server-side, which the next op's unlock gate checks).
    pendingClear.current = Promise.resolve(onOpCleared?.(missionIndex + 1, stats)).then((r) => { if (r) setLastReward(r); return r; });
  };
  // Killed in action on a campaign op. Record the loss (on-chain, via the sessionless
  // flat path) without disturbing the op token — the op restarts in place and the
  // eventual clear still earns full reward. Only campaign runs record a loss; survival
  // and the gauntlet have their own (unsessioned) flows.
  const handleDeath = (stats: { kills: number; headshots: number }) => {
    if (mode === 'contract') {
      try { document.exitPointerLock?.(); } catch { /* ignore */ }
      contractRef.current?.onKilled({ ...stats, secs: (performance.now() - missionStartWall.current) / 1000 });
      return;
    }
    if (mode !== 'campaign') return;
    onOpFailed?.(stats);
  };
  const deployNext = () => {
    const next = Math.min(CAMPAIGN.length - 1, missionIndex + 1);
    try { window.localStorage.setItem(CAMPAIGN_KEY, String(next)); } catch { /* ignore */ }
    clearComplete(); setDebrief(null); menuOpenRef.current = false;
    setMissionIndex(next); setRunNonce((n) => n + 1);
  };
  const retryMission = () => {
    clearComplete(); setDebrief(null); menuOpenRef.current = false;
    setRunNonce((n) => n + 1); // remount the same op fresh
  };
  const exitHome = () => {
    clearComplete(); setCampaignDone(false); setDebrief(null);
    setSelect(true); // straight to the Operations board (stays paused)
  };
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__czCampaign = () => ({ index: missionIndex, total: CAMPAIGN.length, name: mission.name, zone: mission.zone, done: campaignDone, progress, selectOpen });
    w.__czNextMission = () => advance();
    w.__czResetCampaign = () => {
      try { window.localStorage.removeItem(CAMPAIGN_KEY); window.localStorage.removeItem(PROGRESS_KEY); } catch { /* ignore */ }
      setCampaignDone(false); setSelect(false); setProgress(0); setMissionIndex(0); setRunNonce((n) => n + 1);
    };
    w.__czOpenSelect = (v = true) => setSelect(!!v);
    w.__czPickMission = (i: number) => pickMission(i);
    w.__czSurvival = () => pickSurvival();
    w.__czGauntlet = () => { setMode('gauntlet'); setCampaignDone(false); setDebrief(null); setSelect(false); setRunNonce((n) => n + 1); }; // probe: force ranked mode (bypasses unlock)
    w.__czPause = (v = true) => (v ? openPause() : resume()); // C4 probe
    w.__czProgress = () => progress;
    return () => {
      delete w.__czCampaign; delete w.__czNextMission; delete w.__czResetCampaign;
      delete w.__czOpenSelect; delete w.__czPickMission; delete w.__czSurvival; delete w.__czGauntlet; delete w.__czPause; delete w.__czProgress;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missionIndex, campaignDone, progress, selectOpen]);

  // M toggles the Operations board; Esc drives the pause menu (close board →
  // resume → open pause). Kept at the page level so it works with the pointer
  // unlocked. Depends on the overlay states so it always sees the current one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ops = settingsRef.current.controls.binds.opsMenu;
      if ((e.code === ops[0] || e.code === ops[1]) && !contractRef.current) { e.preventDefault(); setSelect(!menuOpenRef.current); }
      else if (e.code === 'Escape') {
        e.preventDefault();
        if (selectOpen) setSelect(false);
        else if (paused) resume();
        else if (!debrief) openPause();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectOpen, paused, debrief]);
  const [isTouch] = useState(detectTouchDevice);
  // Graphics quality. 'auto' = detect (default), 'high' = force full effects,
  // 'low' = force the minimal tier. Persisted so a weak machine stays fixed.
  // Every player setting (graphics, audio, subtitles, controls, accessibility) comes
  // from one place (lib/settings) and applies live; the pause menu writes to it too.
  const settings = useSettings();
  const settingsRef = useRef<Settings>(settings);
  settingsRef.current = settings;
  const quality = settings.quality;
  const pickQuality = useCallback((q: Settings['quality']) => {
    // Choosing a tier (or Auto again) forgets what auto had learned: Auto re-measures.
    setAutoLevel(0);
    try { window.localStorage.removeItem('cz_degraded'); } catch { /* private mode */ }
    updateSettings((s) => ({ ...s, quality: q }));
  }, []);
  // Look sensitivity: the frame loop reads controls.current.lookSens, so a change in
  // the pause menu is felt the moment play resumes.
  useEffect(() => { controls.current.lookSens = settings.lookSens; }, [settings.lookSens]);
  // The player's mix, and silence while the tab is in the background (if chosen).
  useEffect(() => { audio.setMix(settings.audio); }, [audio, settings.audio]);
  // The pause menu stops the audio clock; closing it carries on. (Held by reason, so a key press
  // while paused cannot restart it.)
  useEffect(() => { if (paused) audio.suspend('pause'); else audio.resume('pause'); return () => audio.resume('pause'); }, [audio, paused]);
  useEffect(() => {
    const apply = () => audio.setBackgroundMuted(settingsRef.current.muteInBackground && document.hidden);
    apply();
    document.addEventListener('visibilitychange', apply);
    return () => document.removeEventListener('visibilitychange', apply);
  }, [audio, settings.muteInBackground]);
  // Crosshair (Settings → Interface): style, colour, size and opacity. The frame loop
  // still moves the ticks for spread; this sets everything else.
  useEffect(() => {
    const h = hud.current, c = settings.interface.crosshair;
    const showTicks = c.style === 'cross' || c.style === 'cross-dot';
    const L = Math.round(8 * c.size), W = Math.max(2, Math.round(2 * c.size));
    [h.ch.t, h.ch.b, h.ch.l, h.ch.r].forEach((el, i) => {
      if (!el) return;
      const vertical = i < 2;
      Object.assign(el.style, { display: showTicks ? 'block' : 'none', background: c.color, opacity: String(c.opacity), width: `${vertical ? W : L}px`, height: `${vertical ? L : W}px` });
    });
    if (h.chDot) {
      const d = c.style === 'cross' ? 2 : Math.max(3, Math.round(4 * c.size));
      Object.assign(h.chDot.style, { width: `${d}px`, height: `${d}px`, borderRadius: c.style === 'cross' ? '0' : '50%', background: c.color, opacity: String(c.opacity) });
    }
    if (h.chRing) Object.assign(h.chRing.style, { display: c.style === 'circle' ? 'block' : 'none', borderColor: c.color, opacity: String(c.opacity) });
  }, [settings.interface.crosshair]);

  // Subtitles: size, backing and speaker colours (on/off is read as each line plays).
  useEffect(() => {
    const h = hud.current;
    const px = settings.subtitles.size === 's' ? 13 : settings.subtitles.size === 'l' ? 21 : 16;
    if (h.subText) { h.subText.style.fontSize = `${px}px`; h.subText.style.lineHeight = '1.5'; }
    if (h.subName) h.subName.style.fontSize = `${Math.round(px * 0.72)}px`;
    if (h.subWrap) {
      h.subWrap.style.background = `rgba(0,0,0,${settings.subtitles.background})`;
      h.subWrap.style.padding = settings.subtitles.background > 0 ? '8px 14px' : '0';
      h.subWrap.style.borderRadius = '6px';
      h.subWrap.dataset.speakerColors = settings.subtitles.speakerColors ? '1' : '0';
    }
  }, [settings.subtitles]);

  // Auto-detect: PerformanceMonitor flags a machine that can't hold framerate even
  // after AdaptiveDpr has dropped the resolution. A warmup window + a small counter
  // avoid tripping on the one-time load hitch. PERSISTED: once a machine degrades we
  // remember it, so the NEXT launch starts minimal immediately instead of re-suffering
  // ~5s of full-quality slowdown before detection kicks in. (Only used in 'auto'.)
  // Auto quality (engine/perf/autoQuality): measured frame rate steps the tier down
  // one level at a time (high → medium → low), and the step is remembered so the
  // next launch starts where this machine settled.
  const [autoLevel, setAutoLevel] = useState<AutoLevel>(() => {
    if (typeof window === 'undefined') return 0;
    try { return readAutoLevel(window.localStorage.getItem('cz_degraded')); } catch { return 0; }
  });
  const stepDown = useCallback((l: AutoLevel) => {
    setAutoLevel(l);
    try { const v = writeAutoLevel(l); if (v) window.localStorage.setItem('cz_degraded', v); } catch { /* private mode */ }
  }, []);

  // minimal = the aggressive tier (dpr 1, no shadows, no set-dressing, lean impacts).
  // lightFx = drop the heavy postprocessing passes.
  //
  // This USED to read `!isTouch && autoMinimal`, i.e. phones could never reach the
  // minimal tier at all: the shadow pass, the set dressing and the ambient impact
  // particles stayed on no matter how badly the device was drowning, and the only
  // thing touch got was `lightFx`, which it already had unconditionally. Two things
  // followed from that, both bad:
  //
  //   1. a struggling Android phone had NO escape hatch — AdaptiveDpr trimming the
  //      resolution was the entire adaptive budget, and it can't touch the shadow
  //      map or the draw calls, which is where the cost actually is;
  //   2. the GRAPHICS → LOW button in the pause menu was a NO-OP on touch. It flips
  //      `autoMinimal`, which was ANDed away here, so a player who felt the lag,
  //      found the setting and chose LOW got exactly nothing and reasonably
  //      concluded the game was broken.
  //
  // Every consumer of `minimal` is a pure performance lever (see the shadow, set
  // dressing, ImpactFX and dpr sites) — none of it changes what you can see, hit or
  // stand on — so there is nothing device-specific to protect here. Mobile gets the
  // same tier, and the auto-degrade path that already ran on phones now does
  // something when it fires.
  // The tier in force: a fixed choice, or where Auto has settled.
  const tier = quality === 'auto' ? (['high', 'medium', 'low'] as const)[autoLevel] : quality;
  const autoMinimal = tier === 'low';
  const minimal = autoMinimal;
  // MEDIUM keeps shadows and set dressing but drops the heavy postprocessing passes.
  const lightFx = isTouch || autoMinimal || tier === 'medium';
  // What actually renders: the tier's defaults with the player's overrides on top.
  const plan = useMemo(() => renderPlan(tier, settings.graphics, isTouch), [tier, settings.graphics, isTouch]);
  const fpsCap = settings.graphics.fpsCap;

  // Lock the PAGE to the game while the scene is mounted (restored on unmount so
  // other pages still scroll). Without this, iOS Safari lets a stray double-tap /
  // pinch mid-fight zoom the whole HUD — the "everything looks huge / half screen,
  // reload to fix" bug. Also kill iOS pinch (gesture*) which ignores user-scalable.
  useEffect(() => {
    const html = document.documentElement, body = document.body;
    const prev = { ho: html.style.overflow, bo: body.style.overflow, bp: body.style.position,
      bw: body.style.width, bh: body.style.height, os: body.style.overscrollBehavior, ta: body.style.touchAction };
    html.style.overflow = 'hidden';
    Object.assign(body.style, { overflow: 'hidden', position: 'fixed', width: '100%', height: '100%', overscrollBehavior: 'none', touchAction: 'none' });
    const noGesture = (e: Event) => e.preventDefault();
    document.addEventListener('gesturestart', noGesture, { passive: false });
    document.addEventListener('gesturechange', noGesture, { passive: false });
    return () => {
      html.style.overflow = prev.ho;
      Object.assign(body.style, { overflow: prev.bo, position: prev.bp, width: prev.bw, height: prev.bh, overscrollBehavior: prev.os, touchAction: prev.ta });
      document.removeEventListener('gesturestart', noGesture);
      document.removeEventListener('gesturechange', noGesture);
    };
  }, []);

  // C3: an on-screen FPS / worst-frame meter for on-device perf checks. Enable with
  // ?perf=1 (mobile-friendly) or toggle with the P key (desktop).
  const [perfOn, setPerfOn] = useState(() =>
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('perf'));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const b = settingsRef.current.controls.binds.perf;
      if (e.code === b[0] || e.code === b[1]) setPerfOn((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // CONTRACT ZERO is a landscape game. On a phone held upright, block play with a rotate
  // prompt (and try a best-effort orientation lock once we're in landscape).
  const [portrait, setPortrait] = useState(false);
  useEffect(() => {
    if (!isTouch) return;
    // Prefer visualViewport — on iOS Safari window.inner* is stale mid-rotation and
    // is what left the canvas at half size (needing a manual reload).
    const dims = () => {
      const vv = window.visualViewport;
      return { w: vv?.width ?? window.innerWidth, h: vv?.height ?? window.innerHeight };
    };
    const check = () => { const { w, h } = dims(); setPortrait(h > w); };
    // iOS reports the NEW viewport only a few hundred ms after the rotate event, so
    // re-measure on a couple of delays AND nudge R3F's resize observer each time so
    // the canvas re-fits the full screen without a reload.
    const settle = () => {
      check();
      [120, 350, 700].forEach((d) => setTimeout(() => { check(); window.dispatchEvent(new Event('resize')); }, d));
    };
    check();
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', settle);
    window.visualViewport?.addEventListener('resize', check);
    return () => {
      window.removeEventListener('resize', check);
      window.removeEventListener('orientationchange', settle);
      window.visualViewport?.removeEventListener('resize', check);
    };
  }, [isTouch]);
  // Single source of truth for the pause flag: any full-screen overlay freezes play.
  useEffect(() => { menuOpenRef.current = portrait || selectOpen || debrief !== null || paused; }, [portrait, selectOpen, debrief, paused]);

  // C4 · deliberate pause menu. Non-destructive: opening it just freezes the game,
  // so an accidental open is a one-tap RESUME away (unlike the old exit-to-OPS button).
  const openPause = () => { setPaused(true); try { document.exitPointerLock?.(); } catch { /* ignore */ } };
  const resume = () => setPaused(false);
  const restartFromPause = () => { setPaused(false); setDebrief(null); setRunNonce((n) => n + 1); };
  const exitToOps = () => { setPaused(false); setSelect(true); };

  const JOY_R = 46;
  const joyId = useRef<number | null>(null);
  const joyCenter = useRef({ x: 0, y: 0 });
  const joyKnob = useRef<HTMLDivElement>(null);
  // Directional arrows around the stick, lit toward the push (analog underneath).
  const joyU = useRef<HTMLDivElement>(null);
  const joyD = useRef<HTMLDivElement>(null);
  const joyL = useRef<HTMLDivElement>(null);
  const joyR = useRef<HTMLDivElement>(null);
  const paintJoyArrow = (el: HTMLDivElement | null, amt: number) => {
    if (!el) return;
    const a = Math.max(0, Math.min(1, amt));
    el.style.opacity = String(0.3 + a * 0.7);
    el.style.filter = a > 0.05 ? `drop-shadow(0 0 ${3 + a * 7}px #eab308)` : 'none';
  };
  const lookId = useRef<number | null>(null);
  const lookLast = useRef({ x: 0, y: 0 });
  // Tap-vs-drag on the aim surface: a short, still touch is a "tap an enemy to lock it";
  // anything that moves is a look-drag.
  const lookStartPos = useRef({ x: 0, y: 0, t: 0 });
  const lookMoved = useRef(false);

  const updateJoy = (x: number, y: number) => {
    let dx = x - joyCenter.current.x, dy = y - joyCenter.current.y;
    const len = Math.hypot(dx, dy) || 1;
    if (len > JOY_R) { dx = (dx / len) * JOY_R; dy = (dy / len) * JOY_R; }
    const nx = dx / JOY_R, ny = -dy / JOY_R; // screen-down = backward
    controls.current.moveX = nx;
    controls.current.moveY = ny;
    if (joyKnob.current) joyKnob.current.style.transform = `translate(${dx}px, ${dy}px)`;
    paintJoyArrow(joyU.current, ny);
    paintJoyArrow(joyD.current, -ny);
    paintJoyArrow(joyR.current, nx);
    paintJoyArrow(joyL.current, -nx);
  };
  const joyStart = (e: React.TouchEvent) => {
    audio.unlock();
    const t = e.changedTouches[0];
    joyId.current = t.identifier;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    joyCenter.current = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    updateJoy(t.clientX, t.clientY);
  };
  const joyMove = (e: React.TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) if (t.identifier === joyId.current) updateJoy(t.clientX, t.clientY);
  };
  const joyEnd = (e: React.TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) if (t.identifier === joyId.current) {
      joyId.current = null;
      controls.current.moveX = 0; controls.current.moveY = 0;
      if (joyKnob.current) joyKnob.current.style.transform = 'translate(0,0)';
      paintJoyArrow(joyU.current, 0); paintJoyArrow(joyD.current, 0);
      paintJoyArrow(joyL.current, 0); paintJoyArrow(joyR.current, 0);
    }
  };
  const lookStart = (e: React.TouchEvent) => {
    audio.unlock();
    const t = e.changedTouches[0];
    lookId.current = t.identifier;
    lookLast.current = { x: t.clientX, y: t.clientY };
    lookStartPos.current = { x: t.clientX, y: t.clientY, t: performance.now() };
    lookMoved.current = false;
  };
  const lookMove = (e: React.TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) if (t.identifier === lookId.current) {
      controls.current.lookX += t.clientX - lookLast.current.x;
      controls.current.lookY += t.clientY - lookLast.current.y;
      lookLast.current = { x: t.clientX, y: t.clientY };
      if (Math.hypot(t.clientX - lookStartPos.current.x, t.clientY - lookStartPos.current.y) > 10) {
        lookMoved.current = true;
      }
    }
  };
  const lookEnd = (e: React.TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) if (t.identifier === lookId.current) {
      lookId.current = null;
      // A clean tap (barely moved, brief) = "lock the enemy I tapped".
      if (!lookMoved.current && performance.now() - lookStartPos.current.t < 300) {
        controls.current.tapAimX = t.clientX;
        controls.current.tapAimY = t.clientY;
      }
    }
  };

  // The fire button doubles as an aim pad: press to shoot, and SLIDE your thumb to
  // steer the crosshair (with aim-assist doing the fine lock). Target and shoot in
  // one thumb — no need to aim on one side and fire on the other.
  const fireId = useRef<number | null>(null);
  const fireLast = useRef({ x: 0, y: 0 });
  const fireStart = (e: React.TouchEvent) => {
    audio.unlock();
    const t = e.changedTouches[0];
    fireId.current = t.identifier;
    fireLast.current = { x: t.clientX, y: t.clientY };
    controls.current.fire = true;
    pressFx(e.currentTarget as HTMLElement, true, '#ff6a4d'); // bounce on shoot
  };
  const fireMove = (e: React.TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) if (t.identifier === fireId.current) {
      controls.current.lookX += t.clientX - fireLast.current.x;
      controls.current.lookY += t.clientY - fireLast.current.y;
      fireLast.current = { x: t.clientX, y: t.clientY };
    }
  };
  const fireEnd = (e: React.TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) if (t.identifier === fireId.current) {
      fireId.current = null;
      controls.current.fire = false;
      pressFx(e.currentTarget as HTMLElement, false, '#ff6a4d');
    }
  };
  // Quick press reaction for the momentary action buttons.
  // Pointer events, not touch — one code path fires for finger, mouse and pen, so
  // every HUD button responds to a tap AND a desktop click.
  const tap = (color: string, run: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => { e.preventDefault(); pressFx(e.currentTarget as HTMLElement, true, color); run(); },
    onPointerUp: (e: React.PointerEvent) => pressFx(e.currentTarget as HTMLElement, false, color),
    onPointerLeave: (e: React.PointerEvent) => pressFx(e.currentTarget as HTMLElement, false, color),
    onPointerCancel: (e: React.PointerEvent) => pressFx(e.currentTarget as HTMLElement, false, color),
  });

  /** Latched state for the mobile ADS toggle. `pressFx` restores the resting look
   *  on release, so the lit state has to be repainted after it, not instead. */
  const paintAdsBtn = (on: boolean) => {
    const el = hud.current.adsBtn;
    if (!el) return;
    el.style.background = on
      ? 'radial-gradient(circle at 50% 40%, rgba(207,224,234,.4), rgba(120,160,180,.22))'
      : '';
    el.style.borderColor = on ? 'rgba(207,224,234,.95)' : '';
    el.style.color = on ? '#04141a' : '';
    el.style.fontWeight = on ? '800' : '';
  };
  const toggleAds = () => {
    const on = !controls.current.ads;
    controls.current.ads = on;
    paintAdsBtn(on);
  };

  /** Same lit/unlit treatment as ADS — both are STATES you hold, and a toggle you
   *  can't see the state of is a toggle you lose track of mid-firefight. */
  const paintCrouchBtn = (on: boolean) => {
    const el = hud.current.crouchBtn;
    if (!el) return;
    el.style.background = on
      ? 'radial-gradient(circle at 50% 40%, rgba(143,184,208,.42), rgba(90,130,160,.24))'
      : '';
    el.style.borderColor = on ? 'rgba(143,184,208,.95)' : '';
    el.style.color = on ? '#04141a' : '';
    el.style.fontWeight = on ? '800' : '';
  };
  const toggleCrouch = () => {
    const on = !controls.current.crouch;
    controls.current.crouch = on;
    paintCrouchBtn(on);
  };

  const tick = 'position:absolute;left:50%;top:50%;background:#e9edf2;box-shadow:0 0 2px #000;';
  // Settings → Interface → HUD scale, applied to each corner cluster from its corner.
  const hudK = settings.interface.hudScale;
  const hz = (origin: string): React.CSSProperties => (hudK === 1 ? {} : { transform: `scale(${hudK})`, transformOrigin: origin });
  const pal = PALETTES[settings.access.palette];
  return (
    <div ref={(r) => { hud.current.root = r; }} style={{ position: 'fixed', inset: 0, background: '#000', cursor: 'none', touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none', overflow: 'hidden' }}>
      {/* The RENDERER owns the filmic curve (R3F's ACES default). The composer
          must NOT tone-map again, or the image washes out. */}
      <Canvas
        shadows
        gl={{ antialias: false, powerPreference: 'high-performance' }}
        // C3: cap the render resolution. A retina phone is DPR 3 (9× the pixels of
        // DPR 1) — the single biggest mobile cost. Retina desktops render at DPR 2
        // (4× DPR 1) — the single biggest desktop cost. AdaptiveDpr trims toward the
        // low end of whatever range it is given when PerformanceMonitor sees fps sag.
        //
        // `minimal` now locks DPR 1 on EVERY device, not just desktop. A phone on the
        // minimal tier is by definition one that could not hold framerate at 1.5 with
        // AdaptiveDpr already trimming, so leaving it capped at 1.5 was leaving the
        // largest single lever untouched on exactly the devices that needed it.
        // Healthy phones keep 1.5 and capable desktops keep 2, unchanged.
        dpr={[plan.dprMin, plan.dprMax]}
        frameloop={fpsCap > 0 ? 'never' : 'always'}
        camera={{ position: [mission.start[0], 1.6, mission.start[1]], fov: 55, near: 0.01, far: 320 }}
      >
        {/* Auto quality: measured frame rate steps the tier down one level at a time. */}
        {quality === 'auto' && autoLevel < 2 && <AutoQualityProbe level={autoLevel} onStep={stepDown} />}
        <AdaptiveDpr />
        {(perfOn || settings.interface.perfOverlay) && <PerfHud hud={hud} />}
        {fpsCap > 0 && <FrameCap fps={fpsCap} />}
        <PerfRecorder tier={tier} plan={plan} cap={fpsCap} />
        <Suspense fallback={null}>
          <FpsWorld key={`${mode}-${missionIndex}-${runNonce}`} hud={hud} controls={controls} audio={audio} lowSpec={isTouch} lightFx={lightFx} minimal={minimal} mission={mission} onComplete={handleComplete} onDeath={handleDeath} endOnDeath={mode === 'contract'} pausedRef={menuOpenRef} gateRef={gateRef} accountRank={accountRank} accountXp={accountXp} equippedGun={equippedGun} equippedAmmo={equippedAmmo} equippedMods={equippedMods} fieldKit={fieldKit} endlessOpts={mode === 'endless' ? endless : undefined} coop={mode === 'endless' ? coop : undefined} onProtocol={mode === 'contract' ? (evs) => contractRef.current?.onProtocol?.(evs) : undefined} onInspect={openInspect} inspectingRef={inspectingRef} settingsRef={settingsRef} plan={plan} />
        </Suspense>
      </Canvas>
      {inspecting && <div style={{ cursor: 'auto' }}><ItemInspector item={inspecting} onClose={closeInspect} inFight /></div>}

      {/* C3 perf meter (?perf=1 or P) — top-left, out of the way of the HUD */}
      <div ref={(r) => { hud.current.perf = r; }} style={{ position: 'absolute', left: 12, top: 8, zIndex: 60, display: perfOn || settings.interface.perfOverlay ? 'block' : 'none', fontFamily: 'monospace', fontSize: 12, letterSpacing: 0.5, color: '#5fe0a8', background: 'rgba(0,0,0,.5)', padding: '3px 8px', borderRadius: 5, pointerEvents: 'none' }}>— FPS</div>

      {/* Lock-on reticle — a gold bracket the frame loop parks over the locked enemy */}
      <div ref={(r) => { hud.current.lockReticle = r; }}
        style={{ position: 'absolute', left: 0, top: 0, width: 54, height: 54, zIndex: 55, opacity: 0, pointerEvents: 'none', transition: 'opacity .12s', willChange: 'transform' }}>
        <svg width="54" height="54" viewBox="0 0 54 54" fill="none" stroke="#eab308" strokeWidth="2.5" style={{ filter: 'drop-shadow(0 0 4px rgba(234,179,8,.7))' }}>
          <path d="M4 16V4h12M50 16V4H38M4 38v12h12M50 38v12H38" strokeLinecap="round" />
          <circle cx="27" cy="27" r="2" fill="#eab308" stroke="none" />
        </svg>
      </div>

      {/* ── HUD overlay ── */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', fontFamily: UI_FONT, color: '#e9edf2', userSelect: 'none' }}>
        {/* crosshair */}
        <div ref={(r) => { hud.current.ch.t = r; }} style={{ ...s(tick), width: 2, height: 8, transform: 'translate(-50%,-16px)' }} />
        <div ref={(r) => { hud.current.ch.b = r; }} style={{ ...s(tick), width: 2, height: 8, transform: 'translate(-50%,8px)' }} />
        <div ref={(r) => { hud.current.ch.l = r; }} style={{ ...s(tick), width: 8, height: 2, transform: 'translate(-16px,-50%)' }} />
        <div ref={(r) => { hud.current.ch.r = r; }} style={{ ...s(tick), width: 8, height: 2, transform: 'translate(8px,-50%)' }} />
        <div ref={(r) => { hud.current.chDot = r; }} style={{ ...s(tick), width: 2, height: 2, transform: 'translate(-50%,-50%)' }} />
        <div ref={(r) => { hud.current.chRing = r; }} style={{ position: 'absolute', left: '50%', top: '50%', width: 26, height: 26, transform: 'translate(-50%,-50%)', border: '2px solid #e9edf2', borderRadius: '50%', boxShadow: '0 0 2px #000', display: 'none' }} />

        {/* hitmarker */}
        <div ref={(r) => { hud.current.hit = r; }} style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', fontSize: 26, fontWeight: 700, opacity: 0, transition: 'opacity .08s', textShadow: '0 0 3px #000' }}>✕</div>

        {/* ammo + weapon + reload — on touch it sits top-right and, crucially, is
            offset LEFT of the right action-button column (≤64px from the edge) so the
            two can never overlap regardless of screen height. */}
        <div style={{ position: 'absolute', right: isTouch ? 84 : 26, textAlign: 'right', ...(isTouch ? { top: 10 } : { bottom: 22 * hudK }), ...hz(isTouch ? 'top right' : 'bottom right') }}>
          <div ref={(r) => { hud.current.weapon = r; }} style={{ fontSize: 13, letterSpacing: 2, fontWeight: 700, color: '#e9edf2', marginBottom: 1 }}>ASSAULT RIFLE</div>
          <div ref={(r) => { hud.current.loadout = r; }} style={{ fontSize: 10, letterSpacing: 2, color: '#6f7d8c', marginBottom: 3 }}>1 · 2</div>
          <div ref={(r) => { hud.current.fireMode = r; }} style={{ fontSize: 12, letterSpacing: 3, fontWeight: 700, color: '#8fb8d0', marginBottom: 2 }}>AUTO</div>
          <div ref={(r) => { hud.current.ammo = r; }} style={{ fontSize: 30, fontWeight: 700, letterSpacing: 1 }}>24 / 24</div>
          <div ref={(r) => { hud.current.reload = r; }} style={{ opacity: 0, marginTop: 4, fontSize: 12, color: '#ffb454' }}>
            RELOADING
            <div style={{ width: 120, height: 3, background: '#333', marginTop: 3, marginLeft: 'auto' }}>
              <div ref={(r) => { hud.current.reloadBar = r; }} style={{ width: '0%', height: '100%', background: '#ffb454' }} />
            </div>
          </div>
          <div ref={(r) => { hud.current.reloadHint = r; }} style={{ marginTop: 4, fontSize: 11, letterSpacing: 1, color: '#6f7d8c' }}>{isTouch ? 'TAP TO RELOAD' : `PRESS [${bindLabel(settings.controls.binds, 'reload')}] TO RELOAD`}</div>
        </div>

        {/* attachment strip (toggleable kit) */}
        <div ref={(r) => { hud.current.attachments = r; }} style={{ position: 'absolute', right: 26, bottom: 150 * hudK, display: isTouch ? 'none' : 'flex', gap: 6, justifyContent: 'flex-end', ...hz('bottom right') }} />

        {/* kills — hidden on touch (the bottom-left is the movement thumb there) */}
        <div ref={(r) => { hud.current.kills = r; }} style={{ position: 'absolute', left: 26, bottom: 22 * hudK, fontSize: 13, color: '#9fb4c8', display: isTouch ? 'none' : 'block', ...hz('bottom left') }}>KILLS 0   ·   HS 0</div>

        {/* rank + XP toward the next 1000 (the earn loop). On touch it lives TOP-left,
            clear of the movement thumb (it used to sit under the joystick). */}
        <div style={{ position: 'absolute', left: isTouch ? 14 : 26, width: isTouch ? 150 : 210, ...(isTouch ? { top: 70 * hudK } : { bottom: 74 * hudK }), ...hz(isTouch ? 'top left' : 'bottom left') }}>
          <div ref={(r) => { hud.current.rankText = r; }} style={{ fontSize: 12, letterSpacing: 1.5, fontWeight: 700, color: '#cd7f32' }}>BRONZE · 0 / 1000 XP</div>
          <div style={{ width: '100%', height: 4, background: '#2b3138', marginTop: 4, borderRadius: 2 }}>
            <div ref={(r) => { hud.current.xpBar = r; }} style={{ width: '0%', height: '100%', background: '#cd7f32', borderRadius: 2 }} />
          </div>
        </div>

        {/* floating +XP on each kill */}
        {Array.from({ length: XP_POPS }).map((_, i) => (
          <div key={i} ref={(r) => { hud.current.xpPops[i] = r; }}
            style={{ position: 'absolute', left: `calc(50% + ${(i - 1.5) * 30}px)`, top: '57%', transform: 'translate(-50%,0)', opacity: 0, fontSize: 15, fontWeight: 700, color: '#5fe0a8', textShadow: '0 0 6px #000', pointerEvents: 'none' }}>+0 XP</div>
        ))}

        {/* radio subtitle — the story arrives over the fight, never in a menu */}
        <div ref={(r) => { hud.current.subWrap = r; }} style={{ position: 'absolute', left: '50%', bottom: 104, transform: 'translateX(-50%)', maxWidth: '64%', textAlign: 'center', opacity: 0, transition: 'opacity .25s', pointerEvents: 'none' }}>
          <div ref={(r) => { hud.current.subName = r; }} style={{ fontSize: 11, letterSpacing: 3, fontWeight: 700, color: '#ffb38a', marginBottom: 5 }}>EMBER</div>
          <div ref={(r) => { hud.current.subText = r; }} style={{ fontSize: 15, lineHeight: 1.55, color: '#e9edf2', textShadow: '0 0 8px #000' }} />
        </div>

        {/* RANK UP beat */}
        <div ref={(r) => { hud.current.rankUp = r; }} style={{ position: 'absolute', left: '50%', top: '28%', transform: 'translate(-50%,-50%)', opacity: 0, transition: 'opacity .4s', pointerEvents: 'none', textAlign: 'center' }}>
          <div style={{ fontSize: 13, letterSpacing: 6, color: '#9fb4c8' }}>RANK UP</div>
          <div ref={(r) => { hud.current.rankUpRank = r; }} style={{ fontSize: 38, fontWeight: 800, letterSpacing: 4, margin: '4px 0' }}>SILVER</div>
          <div ref={(r) => { hud.current.rankUpG = r; }} style={{ fontSize: 16, fontWeight: 700, color: '#5fe0a8' }}></div>
        </div>

        {/* health bar — the vital stat. On touch it takes the prime top-left slot
            (it used to sit over the movement thumb); desktop keeps it bottom-left. */}
        <div style={{ position: 'absolute', left: isTouch ? 14 : 26, width: isTouch ? 150 : 220, height: 9, background: 'rgba(0,0,0,.55)', border: '1px solid rgba(255,255,255,.15)', ...(isTouch ? { top: 40 * hudK } : { bottom: 58 * hudK }), ...hz(isTouch ? 'top left' : 'bottom left') }}>
          <div ref={(r) => { hud.current.healthFill = r; }} style={{ width: '100%', height: '100%', background: '#5fd08a', transition: 'width .12s, background .2s' }} />
        </div>
        {/* second winds left in this attempt — a lit pip each. Sits just under the
            health bar, because it IS a health stat: it is how many more times this
            bar can come back. */}
        <div ref={(r) => { hud.current.refills = r; }}
          style={{ position: 'absolute', left: isTouch ? 14 : 26, fontSize: 11, letterSpacing: 3, lineHeight: 1, ...(isTouch ? { top: 54 * hudK } : { bottom: 42 * hudK }), ...hz(isTouch ? 'top left' : 'bottom left') }} />

        {/* damage vignette (red edges on hit / when low) */}
        <div ref={(r) => { hud.current.vignette = r; }} style={{ position: 'absolute', inset: 0, opacity: 0, pointerEvents: 'none', boxShadow: 'inset 0 0 150px 44px rgba(200,20,10,.85)', transition: 'opacity .09s' }} />

        {/* NVG green wash (opacity tracks the night-vision blend) */}
        <div ref={(r) => { hud.current.nvgTint = r; }} style={{ position: 'absolute', inset: 0, opacity: 0, pointerEvents: 'none', background: 'radial-gradient(ellipse at center, rgba(70,255,150,.16) 0%, rgba(10,40,20,.34) 78%, rgba(2,12,6,.62) 100%)', mixBlendMode: 'screen' }} />

        {/* optic scope mask (only while aiming with an optic fitted) */}
        <div ref={(r) => { hud.current.scope = r; }} style={{ position: 'absolute', inset: 0, opacity: 0, pointerEvents: 'none', boxShadow: 'inset 0 0 0 2000px rgba(0,0,0,0)', background: 'radial-gradient(circle at center, transparent 30%, rgba(0,0,0,.55) 33%, #000 40%)' }} />

        {/* directional damage indicator */}
        <div ref={(r) => { hud.current.hitDir = r; }} style={{ position: 'absolute', left: '50%', top: '50%', width: 64, height: 300, marginLeft: -32, marginTop: -150, opacity: 0, pointerEvents: 'none', transformOrigin: '50% 50%', background: `linear-gradient(to top, transparent 62%, ${pal.hostile} 100%)`, transition: 'opacity .1s' }} />

        {/* off-screen threat arrows */}
        {[0, 1, 2, 3].map((i) => (
          <div key={i} ref={(r) => { hud.current.arrows[i] = r; }} style={{ position: 'absolute', opacity: 0, color: pal.hostile, fontSize: 24, pointerEvents: 'none', textShadow: '0 0 5px #000', transition: 'opacity .12s' }}>▲</div>
        ))}

        {/* DOWN */}
        <div ref={(r) => { hud.current.down = r; }} style={{ position: 'absolute', inset: 0, opacity: 0, pointerEvents: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(24,0,0,.5)', color: '#ff5a47', fontSize: 46, fontWeight: 800, letterSpacing: 8 }}>DOWN</div>

        {/* objective banner (top-centre) */}
        <div ref={(r) => { hud.current.objText = r; }} style={{ position: 'absolute', left: '50%', top: 66, transform: `translateX(-50%) scale(${hudK})`, transformOrigin: 'top center', fontSize: 14, letterSpacing: 2, color: pal.objective, textShadow: '0 0 6px #000', opacity: 0, whiteSpace: 'nowrap' }}>OBJECTIVE</div>
        {/* field: the E prompt with its hold bar, what you picked up, what you carry */}
        <div ref={(r) => { hud.current.fieldPrompt = r; }} data-testid="field-prompt" style={{ position: 'absolute', left: '50%', top: '58%', transform: `translateX(-50%) scale(${hudK})`, transformOrigin: 'top center', textAlign: 'center', pointerEvents: 'none', textShadow: '0 0 6px #000' }} />
        <div ref={(r) => { hud.current.field = r; }} data-testid="field-inventory" style={{ position: 'absolute', left: 18, bottom: 128 * hudK, ...hz('bottom left'), fontSize: 12, letterSpacing: 1.5, color: '#cfd8df', textShadow: '0 0 6px #000', pointerEvents: 'none', lineHeight: 1.7 }} />
        <div ref={(r) => { hud.current.fieldExfil = r; }} data-testid="field-exfil" style={{ position: 'absolute', left: '50%', top: 96, transform: `translateX(-50%) scale(${hudK})`, transformOrigin: 'top center', fontSize: 34, fontWeight: 800, letterSpacing: 4, color: '#5fe0a8', textShadow: '0 0 10px #000', opacity: 0, pointerEvents: 'none' }} />

        {/* boss health bar */}
        <div ref={(r) => { hud.current.bossWrap = r; }} style={{ position: 'absolute', left: '50%', top: 96, transform: `translateX(-50%) scale(${hudK})`, transformOrigin: 'top center', width: 360, opacity: 0, transition: 'opacity .3s', textAlign: 'center' }}>
          <div ref={(r) => { hud.current.bossName = r; }} style={{ fontSize: 13, letterSpacing: 4, fontWeight: 700, color: '#e0455a', textShadow: '0 0 6px #000', marginBottom: 4 }}>TARGET</div>
          <div style={{ width: 360, height: 6, background: '#2a1114', border: '1px solid rgba(224,69,90,.4)' }}>
            <div ref={(r) => { hud.current.bossFill = r; }} style={{ width: '100%', height: '100%', background: 'linear-gradient(90deg,#ff4d3d,#e0455a)' }} />
          </div>
        </div>

        {/* first-time tip (lib/tutorial): small, below the objective and countdown, fades */}
        <div ref={(r) => { hud.current.tip = r; }} data-testid="tip" role="status" aria-live="polite" style={{ position: 'absolute', left: '50%', top: isTouch ? 132 : 150, transform: 'translateX(-50%)', maxWidth: isTouch ? 'min(70vw, 560px)' : 'min(92vw, 640px)', textAlign: 'center', fontSize: isTouch ? 12 : 13, letterSpacing: 1, color: '#e9edf2', background: 'rgba(6,10,14,.6)', padding: '6px 12px', borderRadius: 6, opacity: 0, transition: 'opacity .4s', pointerEvents: 'none' }} />

        {/* objective off-screen arrow (cyan) */}
        <div ref={(r) => { hud.current.objArrow = r; }} style={{ position: 'absolute', opacity: 0, color: pal.objective, fontSize: 24, pointerEvents: 'none', textShadow: '0 0 6px #000', transition: 'opacity .12s' }}>▲</div>

        {/* briefing */}
        <div ref={(r) => { hud.current.briefing = r; }} style={{ position: 'absolute', inset: 0, opacity: 0, pointerEvents: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'rgba(6,10,14,.72)', color: '#e9edf2', textAlign: 'center' }}>
          <div style={{ fontSize: 13, letterSpacing: 6, color: '#37d0e0' }}>{mission.op}</div>
          <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: 3, margin: '10px 0' }}>{mission.name}</div>
          <div style={{ fontSize: 13, color: '#9fb4c8', letterSpacing: 1 }}>{mission.brief}</div>
        </div>

        {/* ENDLESS · standing wave readout. There is no mission list out here, so this
            is the ONLY thing telling the player where they are in the run: which wave,
            and how much of it is left. Always on, top-centre, under the crosshair line. */}
        <div ref={(r) => { hud.current.waveHud = r; }} style={{ position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)', display: endless ? 'flex' : 'none', flexDirection: 'column', alignItems: 'center', gap: 2, pointerEvents: 'none', userSelect: 'none' }}>
          <div ref={(r) => { hud.current.waveLabel = r; }} style={{ fontSize: 15, fontWeight: 800, letterSpacing: 4, color: '#eab308' }}>WAVE 1</div>
          <div ref={(r) => { hud.current.waveRooms = r; }} style={{ fontSize: 11, letterSpacing: 2, color: '#9fb4c8' }}>ROOM 1 / 2</div>
        </div>

        {/* ENDLESS · the wave-cleared beat. Fires the moment the last defender of a
            wave's final room drops, holds for a breath, then fades as the player pushes
            on. Deliberately NOT a blocking screen — the run never stops, so neither
            does the player; they read it on the move. */}
        <div ref={(r) => { hud.current.waveDone = r; }} style={{ position: 'absolute', inset: 0, opacity: 0, pointerEvents: 'none', transition: 'opacity .45s', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, textAlign: 'center' }}>
          <div ref={(r) => { hud.current.waveDoneText = r; }} style={{ fontSize: 44, fontWeight: 800, letterSpacing: 8, color: '#eab308', textShadow: '0 0 28px rgba(234,179,8,.55)' }}>WAVE 1 CLEAR</div>
          <div ref={(r) => { hud.current.waveDoneSub = r; }} style={{ fontSize: 13, letterSpacing: 5, color: '#9fb4c8' }}>PUSH FORWARD</div>
        </div>

        {/* mission complete */}
        <div ref={(r) => { hud.current.complete = r; }} style={{ position: 'absolute', inset: 0, opacity: 0, pointerEvents: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(4,12,10,.6)', color: '#5fe0a8', fontSize: 40, fontWeight: 800, letterSpacing: 6 }}>MISSION COMPLETE</div>

        {/* survival: run-over summary */}
        <div ref={(r) => { hud.current.survEnd = r; }} style={{ position: 'absolute', inset: 0, zIndex: 40, opacity: 0, pointerEvents: 'none', transition: 'opacity .4s', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'rgba(16,2,2,.92)', color: '#ff8a7a', textAlign: 'center' }}>
          <div style={{ fontSize: 13, letterSpacing: 8, color: '#c98' }}>THE KILL-HOUSE</div>
          <div style={{ fontSize: 44, fontWeight: 800, letterSpacing: 4, margin: '8px 0', color: '#ff5a47' }}>OVERRUN</div>
          <div ref={(r) => { hud.current.survEndText = r; }} style={{ fontSize: 14, color: '#e6c2bc', letterSpacing: 1 }}>you held 0 waves</div>
          <div style={{ display: 'flex', gap: 12, marginTop: 26 }}>
            <button onClick={() => { if (hud.current.survEnd) { hud.current.survEnd.style.opacity = '0'; hud.current.survEnd.style.pointerEvents = 'none'; } setRunNonce((n) => n + 1); }} style={{ pointerEvents: 'auto', cursor: 'pointer', background: 'transparent', border: '1px solid #ff8a7a', color: '#ff8a7a', fontFamily: 'inherit', fontSize: 13, letterSpacing: 3, padding: '10px 20px', borderRadius: 5 }}>{iconRow('refresh', 'AGAIN', 14)}</button>
            <button onClick={() => { if (hud.current.survEnd) { hud.current.survEnd.style.opacity = '0'; hud.current.survEnd.style.pointerEvents = 'none'; } setSelect(true); }} style={{ pointerEvents: 'auto', cursor: 'pointer', background: 'transparent', border: '1px solid #9fb4c8', color: '#9fb4c8', fontFamily: 'inherit', fontSize: 13, letterSpacing: 3, padding: '10px 20px', borderRadius: 5 }}>{iconRow('menu', 'OPERATIONS', 14)}</button>
          </div>
        </div>
        {/* C4 · pause menu — deliberate, non-destructive, works in every mode */}
        {paused && !selectOpen && !debrief && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 46, background: 'rgba(3,6,10,.9)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'safe center', overflowY: 'auto', padding: '16px 0', fontFamily: UI_FONT, color: '#e9edf2', pointerEvents: 'auto', cursor: 'auto' }}>
            <div style={{ fontSize: 12, letterSpacing: 8, color: '#37d0e0' }}>PAUSED</div>
            <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: 3, margin: '10px 0 4px' }}>
              {mode === 'endless' ? mission.name : mode === 'gauntlet' ? 'THE GAUNTLET' : mode === 'survival' ? 'THE KILL-HOUSE' : mission.name}
            </div>
            <div style={{ fontSize: 12, color: '#6f7d8c', letterSpacing: 1 }}>{mode === 'campaign' ? `OP ${missionIndex + 1} / ${CAMPAIGN.length}` : mode === 'endless' ? (seasonal ? 'SEASONAL' : 'ENDLESS') : mode === 'gauntlet' ? 'RANKED' : 'ENDLESS'}</div>
            <div style={{ display: 'flex', gap: 12, marginTop: 26, flexWrap: 'wrap', justifyContent: 'center' }}>
              <button onClick={resume} style={{ ...btnC4('#37d0e0'), background: 'rgba(55,208,224,.12)', fontWeight: 700 }}>{iconRow('play', 'RESUME', 13)}</button>
              <button onClick={restartFromPause} style={btnC4('#9fb4c8')}>{iconRow('refresh', 'RESTART', 14)}</button>
              <button onClick={exitToOps} style={btnC4('#6f7d8c')}>{iconRow('menu', 'OPERATIONS', 14)}</button>
              {onExit && (
                <button onClick={onExit} style={{ ...btnC4('#e0796f'), background: 'rgba(224,121,111,.10)' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ display: 'inline-flex', transform: 'scaleX(-1)' }}><Icon name="chevron" size={14} /></span>EXIT
                  </span>
                </button>
              )}
            </div>
            {/* Quick settings: live, saved, and never a reason to leave the fight. */}
            <PauseSettings s={settings} onQuality={pickQuality} touch={isTouch} />
            <div style={{ fontSize: 11, color: '#7d8a96', letterSpacing: 1, marginTop: 18 }}>{isTouch ? 'tap RESUME to return to the fight' : 'ESC resumes · this pause is safe, nothing is lost'}</div>
          </div>
        )}
        {debrief && !selectOpen && (
          <MissionDebrief
            mode={debrief}
            cleared={CAMPAIGN[Math.min(missionIndex, CAMPAIGN.length - 1)]}
            next={debrief === 'next' ? CAMPAIGN[missionIndex + 1] : null}
            reward={lastReward}
            onDeploy={deployNext}
            onRetry={retryMission}
            onExit={exitHome}
          />
        )}

        {selectOpen && (
          <MissionSelect current={mode === 'campaign' ? missionIndex : -1} progress={progress} onPick={pickMission} onSurvival={pickSurvival} onGauntlet={pickGauntlet} gauntletUnlocked={gauntletUnlocked} onClose={() => setSelect(false)} />
        )}

        {/* zone / op label (operations are chosen outside the game now). On touch it
            shifts right to clear the top-left EXIT button. */}
        <div style={{ position: 'absolute', left: isTouch ? 90 : 150, top: 20 }}>
          <span style={{ fontSize: 12, letterSpacing: 2, color: '#6f7d8c' }}>{mode === 'endless' ? `CONTRACT ZERO · ${seasonal ? 'SEASONAL CAMPAIGN' : 'ENDLESS'} · ${mission.name}` : mode === 'gauntlet' ? 'CONTRACT ZERO · GAUNTLET · RANKED' : mode === 'survival' ? 'CONTRACT ZERO · SURVIVAL · THE KILL-HOUSE' : mode === 'contract' ? `CONTRACT ZERO · ${mission.name}` : `CONTRACT ZERO · ${mission.zone} · OP ${missionIndex + 1}/${CAMPAIGN.length}`}</span>
        </div>
        {!isTouch && (
          <div style={{ position: 'absolute', right: 26, top: 20, fontSize: 11, lineHeight: 1.7, textAlign: 'right', color: '#6f7d8c' }}>
            {(() => {
              const b = settings.controls.binds, k = (a: Action) => bindLabel(b, a);
              return (<>
                {k('moveForward')}{k('moveLeft')}{k('moveBack')}{k('moveRight')} move · MOUSE / {k('lookUp')}{k('lookDown')}{k('lookLeft')}{k('lookRight')} look<br />
                {k('fire').toUpperCase()} fire · {k('aim').toUpperCase()} ads · {k('target')} target · {k('interact')} use ({settings.access.toggleInteract ? 'press' : 'hold'}) · {k('heal')} dressing · {k('leanLeft')}/{k('leanRight')} lean · {k('crouch')} crouch · {k('reload')} reload · {k('fireMode')} fire-mode<br />
                {k('primary')} / {k('secondary')} or {k('swap')} swap weapon · {k('nvg')} nvg · {k('light')} light · {k('laser')} laser · {k('optic')} optic · {k('opsMenu')} ops · ESC release mouse
              </>);
            })()}
          </div>
        )}

        {/* aim hint — desktop only (mobile has visible controls) */}
        {!isTouch && (
          <div ref={(r) => { hud.current.lock = r; }} style={{ position: 'absolute', left: '50%', top: '44%', transform: 'translate(-50%,0)', fontSize: 13, color: '#9fb4c8', background: 'rgba(0,0,0,.45)', padding: '8px 14px', borderRadius: 6 }}>
            AIM UP/DOWN: move the mouse (captures on your first keypress) · or use the ARROW KEYS · Esc releases the mouse, then EXIT / ⏸ are top-left
          </div>
        )}
      </div>

      {/* ── Desktop EXIT / PAUSE — top-left, mirroring the touch cluster ──
          Desktop used to have NO visible way out: the pause button and the EXIT
          button were both `isTouch`-only, leaving Esc as the sole route. But while
          the pointer is locked the browser consumes Escape to release the lock and
          never delivers the keydown to the page, so Esc appeared to do nothing and
          the only way out of a fight was the browser's back button.

          Rendering them here fixes both halves: Esc still releases the mouse (the
          browser's own behaviour), and the moment it does, these are sitting there
          to be clicked.

          onMouseDown stops propagation because the window-level `mdown` handler
          re-requests pointer lock on ANY click — without this, clicking PAUSE would
          grab the mouse again on the way in. */}
      {!isTouch && !selectOpen && !portrait && !paused && !debrief && (
        <div style={{ position: 'absolute', left: 26, top: 16, zIndex: 20, display: 'flex', alignItems: 'center', gap: 8, pointerEvents: 'auto' }}>
          {onExit && (
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={onExit}
              title="Leave the fight"
              style={{ height: 30, display: 'flex', alignItems: 'center', gap: 5, padding: '0 11px 0 8px', borderRadius: 8, background: 'rgba(6,10,16,.55)', border: '1px solid rgba(224,121,111,.4)', color: '#e6a29b', fontFamily: UI_FONT, fontSize: 11, letterSpacing: 2, backdropFilter: 'blur(6px)', cursor: 'pointer' }}
            >
              <span style={{ display: 'inline-flex', transform: 'scaleX(-1)' }}><Icon name="chevron" size={14} /></span>EXIT
            </button>
          )}
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={openPause}
            title="Pause (Esc)"
            style={{ width: 40, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'rgba(6,10,16,.55)', border: '1px solid rgba(255,255,255,.18)', color: '#cfe0ea', backdropFilter: 'blur(6px)', cursor: 'pointer' }}
          >
            <Icon name="pause" size={18} />
          </button>
        </div>
      )}

      {/* ── Mobile touch controls — glassy, tucked to the corners ── */}
      {isTouch && !selectOpen && !portrait && !paused && (
        <>
          {/* C4 pause button — top-centre, ABOVE the aim strip (top:104) so it never
              eats an aim touch. Safe to mis-tap: pause just freezes + offers RESUME. */}
          <div onTouchStart={(e) => { e.stopPropagation(); openPause(); }} onClick={openPause}
            style={{ position: 'absolute', left: '50%', top: 8, transform: 'translateX(-50%)', zIndex: 20, width: 40, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, background: 'rgba(6,10,16,.88)', border: '1px solid rgba(255,255,255,.18)', color: '#cfe0ea', pointerEvents: 'auto' }}>
            <Icon name="pause" size={18} />
          </div>

          {/* EXIT — top-left. Leaves the fight for the mode-select page (Campaign /
              PvP / Challenge). In a standalone PWA there's no browser back button, so
              this is the visible way out. Tucked in the corner, away from the action
              buttons, so it isn't mis-tapped mid-fight. */}
          {onExit && (
            <div onTouchStart={(e) => { e.stopPropagation(); onExit(); }} onClick={onExit}
              style={{ position: 'absolute', left: 10, top: 8, zIndex: 20, height: 30, display: 'flex', alignItems: 'center', gap: 5, padding: '0 11px 0 8px', borderRadius: 8, background: 'rgba(6,10,16,.88)', border: '1px solid rgba(224,121,111,.4)', color: '#e6a29b', fontFamily: UI_FONT, fontSize: 11, letterSpacing: 2, pointerEvents: 'auto' }}>
              <span style={{ display: 'inline-flex', transform: 'scaleX(-1)' }}><Icon name="chevron" size={14} /></span>EXIT
            </div>
          )}

          {/* drag ANYWHERE below the top strip to aim — over the gun included; the
              joystick + action buttons sit on top and capture their own touches */}
          <div onTouchStart={lookStart} onTouchMove={lookMove} onTouchEnd={lookEnd} onTouchCancel={lookEnd}
            style={{ position: 'absolute', left: 0, right: 0, top: 104, bottom: 0, touchAction: 'none' }} />

          {/* left thumb: movement stick — arrows around an analog hub. Reads as
              "go this way" while drag distance still sets speed + diagonals. */}
          <div onTouchStart={joyStart} onTouchMove={joyMove} onTouchEnd={joyEnd} onTouchCancel={joyEnd}
            style={{ ...touchBtn('#eab308', 116), left: 24, bottom: 24, background: 'radial-gradient(circle at 50% 45%, rgba(234,179,8,.07), rgba(6,10,16,.45))', border: '1px solid rgba(234,179,8,.28)' }}>
            {/* chevrons N/S/E/W */}
            <div ref={joyU} style={{ position: 'absolute', left: '50%', top: 6, marginLeft: -8, opacity: 0.3, color: '#eab308' }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M6 15l6-6 6 6" /></svg></div>
            <div ref={joyD} style={{ position: 'absolute', left: '50%', bottom: 6, marginLeft: -8, opacity: 0.3, color: '#eab308' }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M6 9l6 6 6-6" /></svg></div>
            <div ref={joyL} style={{ position: 'absolute', left: 6, top: '50%', marginTop: -8, opacity: 0.3, color: '#eab308' }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M15 6l-6 6 6 6" /></svg></div>
            <div ref={joyR} style={{ position: 'absolute', right: 6, top: '50%', marginTop: -8, opacity: 0.3, color: '#eab308' }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M9 6l6 6-6 6" /></svg></div>
            <div ref={joyKnob} style={{ position: 'absolute', left: '50%', top: '50%', width: 44, height: 44, marginLeft: -22, marginTop: -22, borderRadius: '50%', background: 'radial-gradient(circle at 40% 35%, rgba(234,179,8,.9), rgba(180,120,8,.7))', border: '1px solid rgba(255,255,255,.35)', boxShadow: '0 0 12px rgba(234,179,8,.45), 0 3px 8px rgba(0,0,0,.5)' }} />
          </div>

          {/* fire (primary) — also an aim pad: press to shoot, slide to steer */}
          <div onTouchStart={fireStart} onTouchMove={fireMove} onTouchEnd={fireEnd} onTouchCancel={fireEnd}
            style={{ ...touchBtn('#ff6a4d', 78, true), right: 20, bottom: 24 }}><Icon name="crosshair" size={32} /></div>
          {/* TARGET — tap to lock the nearest enemy, tap again to cycle. Above fire. */}
          <div {...tap('#eab308', () => { controls.current.lockCycle = true; })}
            style={{ ...touchBtn('#eab308', 60), right: 108, bottom: 92, background: 'radial-gradient(circle at 50% 40%, rgba(234,179,8,.16), rgba(6,10,16,.5))', border: '1.5px solid rgba(234,179,8,.5)' }}>
            <Icon name="lock" size={22} />
          </div>
          {/* ADS (TOGGLE) — left of fire. Held-to-aim asks for three thumbs on a
              phone: one on the move stick, one pinning this, and a third for the
              fire pad. Tapping it latches instead, so aiming and shooting need one
              thumb each. The button stays lit while it's on, because a toggle you
              can't see the state of is a toggle you fight. Desktop keeps hold
              (Shift / right mouse) — a key you can hold costs no thumbs. */}
          <div ref={(r) => { hud.current.adsBtn = r; paintAdsBtn(controls.current.ads); }}
            onPointerDown={(e) => { e.preventDefault(); pressFx(e.currentTarget as HTMLElement, true, '#cfe0ea'); toggleAds(); }}
            onPointerUp={(e) => { pressFx(e.currentTarget as HTMLElement, false, '#cfe0ea'); paintAdsBtn(controls.current.ads); }}
            onPointerLeave={(e) => { pressFx(e.currentTarget as HTMLElement, false, '#cfe0ea'); paintAdsBtn(controls.current.ads); }}
            onPointerCancel={(e) => { pressFx(e.currentTarget as HTMLElement, false, '#cfe0ea'); paintAdsBtn(controls.current.ads); }}
            style={{ ...touchBtn('#cfe0ea', 52), right: 108, bottom: 30, fontSize: 11 }}>ADS</div>
          {/* CROUCH — the one control touch never had. It sits beside ADS rather than
              in the secondary column because it is a combat control, not a housekeeping
              one: it drops your eye line below cover, which is now how you break contact
              and make a room lose you. A toggle, not a hold — both thumbs are already
              committed to the stick and the fire pad. Label is 9px with the letter
              spacing dialled out: "CROUCH" is twice the label "ADS" is, and at the
              shared 11px/1px it ran to both edges of the circle. */}
          <div ref={(r) => { hud.current.crouchBtn = r; paintCrouchBtn(controls.current.crouch); }}
            onPointerDown={(e) => { e.preventDefault(); pressFx(e.currentTarget as HTMLElement, true, '#8fb8d0'); toggleCrouch(); }}
            onPointerUp={(e) => { pressFx(e.currentTarget as HTMLElement, false, '#8fb8d0'); paintCrouchBtn(controls.current.crouch); }}
            onPointerLeave={(e) => { pressFx(e.currentTarget as HTMLElement, false, '#8fb8d0'); paintCrouchBtn(controls.current.crouch); }}
            onPointerCancel={(e) => { pressFx(e.currentTarget as HTMLElement, false, '#8fb8d0'); paintCrouchBtn(controls.current.crouch); }}
            style={{ ...touchBtn('#8fb8d0', 52), right: 170, bottom: 30, fontSize: 9, letterSpacing: 0 }}>CROUCH</div>
          {/* secondary actions — a slim column hugging the right edge, up off the gun */}
          <div {...tap('#ffb454', () => { controls.current.reload = true; })}
            style={{ ...touchBtn('#ffb454', 44), right: 22, bottom: 116 }}><Icon name="refresh" size={19} /></div>
          {/* USE: hold to interact (the E key) · MED: apply a dressing (the H key) */}
          <div onPointerDown={(e) => { e.preventDefault(); controls.current.interact = true; }}
            onPointerUp={() => { controls.current.interact = false; }} onPointerLeave={() => { controls.current.interact = false; }} onPointerCancel={() => { controls.current.interact = false; }}
            style={{ ...touchBtn('#e9edf2', 52), right: 232, bottom: 30, fontSize: 11 }}>USE</div>
          <div {...tap('#5fe0a8', () => { controls.current.heal = true; })}
            style={{ ...touchBtn('#5fe0a8', 42), right: 24, bottom: 274, fontSize: 10 }}>MED</div>
          <div {...tap('#5fe0a8', () => { controls.current.swap = true; })}
            style={{ ...touchBtn('#5fe0a8', 44), right: 22, bottom: 170 }}><Icon name="swap" size={19} /></div>
          <div {...tap('#8fb8d0', () => { controls.current.fireMode = true; })}
            style={{ ...touchBtn('#8fb8d0', 42), right: 24, bottom: 222 }}><Icon name="firemode" size={17} /></div>

          {/* attachment toggles — compact top-left row, tucked under the rank bar */}
          <div style={{ position: 'absolute', left: 14, top: 92, display: 'flex', gap: 7 }}>
            {ATTACH_CHIPS.map((c) => (
              <div key={c.id} ref={(r) => { hud.current.attachChips[c.id] = r; }}
                onPointerDown={(e) => { e.preventDefault(); pressFx(e.currentTarget as HTMLElement, true, c.color); controls.current.toggle = c.id; }}
                onPointerUp={(e) => pressFx(e.currentTarget as HTMLElement, false, c.color)}
                onPointerLeave={(e) => pressFx(e.currentTarget as HTMLElement, false, c.color)}
                onPointerCancel={(e) => pressFx(e.currentTarget as HTMLElement, false, c.color)}
                // The tint gradient is nearly transparent — the blur used to supply the
                // chip's body. With it gone (touch-only row; see `frost`), the gradient
                // is composited over a dark solid so the label stays readable against a
                // bright muzzle flash instead of dissolving into the scene.
                style={{ width: 46, height: 30, borderRadius: 8, border: `1px solid ${c.color}77`, background: `linear-gradient(180deg, ${c.color}1f, ${c.color}0a), rgba(6,10,16,.82)`, boxShadow: `inset 0 1px 0 ${c.color}33`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, letterSpacing: 1, fontWeight: 700, color: c.color, touchAction: 'none', WebkitTapHighlightColor: 'transparent', transition: 'transform .11s cubic-bezier(.34,1.56,.64,1), box-shadow .11s, filter .11s, background .12s, border-color .12s' }}>{c.label}</div>
            ))}
          </div>
        </>
      )}

      {/* ── Landscape gate: a phone held upright can't play CONTRACT ZERO ── */}
      {isTouch && portrait && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 60, background: 'radial-gradient(circle at 50% 40%, #0b1018, #05070b)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#cfe0ea', textAlign: 'center', fontFamily: UI_FONT, pointerEvents: 'auto' }}>
          <div style={{ color: '#37d0e0', animation: 'none' }}><Icon name="rotate" size={64} /></div>
          <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: 5, marginTop: 22 }}>ROTATE YOUR DEVICE</div>
          <div style={{ fontSize: 13, color: '#7f8c99', letterSpacing: 3, marginTop: 10 }}>CONTRACT ZERO IS PLAYED IN LANDSCAPE</div>
          {/* This screen covers everything at z-index 60, including the EXIT button in
              the HUD beneath it. Without its own way out, a player who opened a fight
              and DIDN'T want to rotate had no exit at all — rotate or kill the app.
              A refusal to turn the phone is a legitimate answer, so give it one. */}
          {onExit && (
            <div onTouchStart={(e) => { e.stopPropagation(); onExit(); }} onClick={onExit}
              style={{ marginTop: 34, display: 'flex', alignItems: 'center', gap: 6, padding: '10px 18px 10px 14px', borderRadius: 10, background: 'rgba(6,10,16,.55)', border: '1px solid rgba(224,121,111,.4)', color: '#e6a29b', fontSize: 12, letterSpacing: 3, pointerEvents: 'auto' }}>
              <span style={{ display: 'inline-flex', transform: 'scaleX(-1)' }}><Icon name="chevron" size={14} /></span>EXIT
            </div>
          )}
        </div>
      )}

      {/* ── Server-readiness gate: no session token, no fight ── */}
      {/* Blocks the op until the server confirms a session, so a cold/asleep server can
          never let you play a run that silently won't count (XP / rank / G$). */}
      {gate !== 'ok' && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 70, background: 'radial-gradient(circle at 50% 40%, #0b1018, #05070b)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#cfe0ea', textAlign: 'center', fontFamily: UI_FONT, pointerEvents: 'auto', padding: 24 }}>
          {gate === 'connecting' ? (
            <>
              <div className="animate-spin" style={{ width: 34, height: 34, borderRadius: '50%', border: '3px solid rgba(255,255,255,.15)', borderTopColor: '#37d0e0' }} />
              <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: 3, marginTop: 20 }}>CONNECTING TO SERVER</div>
              <div style={{ fontSize: 12, color: '#7f8c99', letterSpacing: 1.5, marginTop: 8, maxWidth: 320, lineHeight: 1.5 }}>Securing your session so this run counts. The first connect can take up to a minute.</div>
            </>
          ) : (
            <>
              <div style={{ color: '#f59e0b' }}><Icon name="alert" size={44} /></div>
              <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: 3, marginTop: 16 }}>CAN&apos;T REACH THE SERVER</div>
              <div style={{ fontSize: 12, color: '#7f8c99', letterSpacing: 1.5, marginTop: 8, maxWidth: 340, lineHeight: 1.5 }}>Your run won&apos;t count until you&apos;re connected. Tap Retry to wake the server and try again.</div>
              <button onClick={retryConnect}
                style={{ marginTop: 22, padding: '11px 30px', borderRadius: 10, border: '1.5px solid rgba(55,208,224,.6)', background: 'rgba(55,208,224,.12)', color: '#8fe6f2', fontWeight: 800, letterSpacing: 3, fontSize: 14, cursor: 'pointer', pointerEvents: 'auto' }}>
                RETRY
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function s(css: string): React.CSSProperties {
  const o: Record<string, string> = {};
  for (const rule of css.split(';')) {
    const [key, val] = rule.split(':');
    if (!key || !val) continue;
    const camel = key.trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    o[camel] = val.trim();
  }
  return o as React.CSSProperties;
}
