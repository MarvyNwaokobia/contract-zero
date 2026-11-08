'use client';

import { Suspense, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { FighterModel } from './FighterModel';
import { type StageId } from './ArenaStage';
import { StylizedArena } from './arenas/StylizedArena';
import { AshfallArena } from './arenas/AshfallArena';
import { CoverProps } from './arenas/CoverProps';
import { BattleCamera } from '../camera';
import { AnimationStateMachine, AnimState, CLASS_ANIMATIONS } from '../animation';
import { getInputSystem } from '../input';
import { TouchControls } from '../input/TouchControls';
import type { DamageEvent } from '../combat/DamageSystem';
import { type ComboState, STARTER_GUN_ID, type GunId, GUN_FEEL } from '../combat';
import { AIDifficulty } from '../combat';
import { CombatSim, type FighterId, type SimEvent } from '../sim/CombatSim';
import { CharacterController } from '../character';
import { regenerateCover, resolveCover, setStaticCover } from '../sim/Cover';
import { villageColliders, ROAM_RADIUS } from './arenas/ashfallLayout';
import type { MissionConfig, MissionEncounter } from '../campaign/missions';
import { ParticleSystem } from '../vfx/ParticleSystem';
import { TracerFX } from '../vfx/TracerFX';
import { DamageNumbers } from '../vfx/DamageNumbers';
import { CombatAudio } from '../audio/CombatAudio';
import { ScreenEffects } from '../vfx/ScreenEffects';
import { ScreenFlashOverlay } from '../vfx/ScreenFlashOverlay';
import { Crowd } from '../world/Crowd';
import { CrowdDirector } from '../world/CrowdDirector';

type ClassId = 'berserker' | 'sentinel' | 'phantom';

export type ArenaVariant = 'stylized' | 'ashfall';

// Which environment each campaign stage renders. Zone 1 (levels 1-5 ship
// stageId 'lava_arena') fights in the Ashfall burned village; everything else
// stays in the stylized colosseum until its own environment lands.
const STAGE_VARIANTS: Record<StageId, ArenaVariant> = {
  lava_arena: 'ashfall',
  scifi_stage: 'stylized',
  battle_arena: 'stylized',
  rpg_environment: 'stylized',
  industrial_hangar: 'stylized',
};

interface GameSceneProps {
  playerClass: ClassId;
  enemyClass: ClassId;
  stageId?: StageId;
  enemyName?: string;
  difficulty?: AIDifficulty;
  // Equipped guns (the Campaign level sets the enemy's; defaults to the starter).
  playerGun?: GunId;
  enemyGun?: GunId;
  enemyHpMult?: number; // Campaign level scales the bot's HP (1 = base 100).
  // Walk-to-find mission staging (campaign levels with a real environment):
  // spawn at the level edge, find the enemy, fight where you found them.
  mission?: MissionConfig;
  /** Retries/replays spawn closer so repeat attempts skip the hike. */
  missionRetry?: boolean;
  onDamageEvent?: (event: DamageEvent) => void;
  onComboUpdate?: (combo: ComboState | null) => void;
  onPlayerStateUpdate?: (health: number, maxHealth: number, stamina: number, staminaMax: number) => void;
  onEnemyStateUpdate?: (health: number, maxHealth: number) => void;
  onAmmoUpdate?: (ammo: number, magazine: number, reloading: boolean, reloadProgress: number) => void;
  onEnemyReloadUpdate?: (reloading: boolean, reloadProgress: number) => void;
  // The LOCAL player landed a shot — the page-level hitmarker flashes on this.
  onHitmarker?: (crit: boolean) => void;
  onBattleEnd?: (winner: 'player' | 'enemy', durationSecs: number) => void;
  // Rewards earned this fight, shown on the victory screen (server-authoritative).
  rewardPending?: boolean;
  reward?: { won: boolean; xpAwarded: number; rankedUp: boolean; newRank: string | null; gAwarded: number } | null;
  // Post-fight action buttons — rendered by the parent page (retry/next/home).
  postFightActions?: React.ReactNode;
}

const CLASS_ACCENTS: Record<string, string> = {
  berserker: '#ff4422',
  sentinel: '#4488ff',
  phantom: '#aa44ff',
};

// Tracer colours so the player can tell their fire from the opponent's at a glance.
const PLAYER_TRACER = 0x66ccff; // cyan
const ENEMY_TRACER = 0xff7744;  // orange

const FOOTSTEP_INTERVAL = 0.3;
const FOOTSTEP_SPEED_THRESHOLD = 1.0;

// ── The kill moment ─────────────────────────────────────────────────────────
// KO beat timeline (seconds from the killing shot): hold the impact frame,
// then let the death/victory clips play in slow motion under the killcam
// orbit, then return to speed and land the result screen with the sting.
const KO_FREEZE_SEC = 0.24;   // both bodies held on the killing frame
const KO_SLOWMO_SCALE = 0.35; // mixer timeScale during the slow-mo beat
const KO_SLOWMO_UNTIL = 1.7;  // slow-mo ends (timeline seconds)
const KO_RESULT_AT = 2.6;     // fanfare/defeat sting + result overlay

const ARENA_FOG: Record<ArenaVariant, { bg: string; fog: string; near: number; far: number }> = {
  stylized:   { bg: '#b8cce8', fog: '#b8cce8', near: 80, far: 220 },
  // Ash haze: pale and warm, melting the burned treeline into the horizon.
  ashfall:    { bg: '#b3a08a', fog: '#b3a08a', near: 20, far: 110 },
};

// Floating beacon over the current objective — visible through walls (it reads
// as UI, not as a thing in the world) with a pulsing ground ring at its feet.
function ObjectiveMarker({ x, z }: { x: number; z: number }) {
  const diamond = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (diamond.current) {
      diamond.current.position.y = 2.7 + Math.sin(t * 2.2) * 0.22;
      diamond.current.rotation.y = t * 1.6;
    }
    if (ring.current) {
      ring.current.scale.setScalar(1 + (Math.sin(t * 2.6) * 0.5 + 0.5) * 0.3);
    }
  });
  return (
    <group position={[x, 0, z]}>
      <group ref={diamond} position={[0, 2.7, 0]}>
        <mesh renderOrder={999}>
          <octahedronGeometry args={[0.32, 0]} />
          <meshStandardMaterial color="#ffc14d" emissive="#ffb020" emissiveIntensity={2} toneMapped={false} transparent opacity={0.95} depthTest={false} />
        </mesh>
      </group>
      <mesh ref={ring} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]} renderOrder={998}>
        <ringGeometry args={[0.85, 1.05, 40]} />
        <meshStandardMaterial color="#ffb020" emissive="#ffb020" emissiveIntensity={1.2} transparent opacity={0.65} depthTest={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

// Ember ring marking the live combat zone — the fight happens where you found
// them, so the boundary cue follows the encounter instead of the arena centre.
function ZoneRing({ cx, cz, radius }: { cx: number; cz: number; radius: number }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (ref.current) {
      const m = ref.current.material as THREE.MeshStandardMaterial;
      m.emissiveIntensity = 0.4 + Math.sin(state.clock.elapsedTime * 1.3) * 0.15;
    }
  });
  return (
    <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0.012, cz]}>
      <ringGeometry args={[radius - 0.22, radius, 64]} />
      <meshStandardMaterial color="#ff6a2a" emissive="#ff6a2a" emissiveIntensity={0.4} transparent opacity={0.4} />
    </mesh>
  );
}

function BattleWorld({
  playerClass,
  enemyClass,
  difficulty = AIDifficulty.Medium,
  playerGun = STARTER_GUN_ID,
  enemyGun = STARTER_GUN_ID,
  enemyHpMult = 1,
  mission,
  missionRetry = false,
  arenaVariant,
  onDamageEvent,
  onPlayerStateUpdate,
  onEnemyStateUpdate,
  onAmmoUpdate,
  onEnemyReloadUpdate,
  onHitmarker,
  onBattleEnd,
  onReady,
  onObjective,
  onEncounterStart,
  onEncounterCleared,
  combatActive = false,
  screenFx,
}: GameSceneProps & {
  difficulty: AIDifficulty;
  arenaVariant: ArenaVariant;
  onReady?: () => void;
  onObjective?: (text: string, dist: number) => void;
  onEncounterStart?: (enc: MissionEncounter, index: number) => void;
  onEncounterCleared?: (index: number) => void;
  combatActive?: boolean;
  screenFx: ScreenEffects;
}) {
  const { camera } = useThree();
  const perspCamera = camera as THREE.PerspectiveCamera;
  const hasCrowd = arenaVariant === 'stylized';
  const battleEndedRef = useRef(false);
  const combatActiveRef = useRef(false);
  combatActiveRef.current = combatActive;
  const readyFired = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!readyFired.current) {
        readyFired.current = true;
        onReady?.();
      }
    }, 1500);
    return () => clearTimeout(timer);
  }, [onReady]);

  const input = useMemo(() => getInputSystem(), []);
  const battleCamera = useMemo(() => new BattleCamera(perspCamera), [perspCamera]);

  const missionMode = !!mission;

  // Mission flow: roam (find the enemy) ↔ combat (the encounter fight, where
  // you found them). A ref drives the frame loop; mirrored state drives JSX.
  const phaseRef = useRef<'roam' | 'combat'>(missionMode ? 'roam' : 'combat');
  const [phase, setPhase] = useState<'roam' | 'combat'>(phaseRef.current);
  const encIdxRef = useRef(0);
  const [encIdx, setEncIdx] = useState(0);
  const healthCarryRef = useRef<number | null>(null);
  const zoneRef = useRef<{ cx: number; cz: number; radius: number } | null>(null);
  const [, setSimVersion] = useState(0);
  const bumpSim = useCallback(() => setSimVersion((v) => v + 1), []);

  // The one authoritative combat sim (the same render-free core a server runs).
  // In PvE the enemy (p2) is AI-driven inside the sim; the local player drives p1.
  // Quick fights build it up front; missions build one per encounter at the
  // moment the enemy is FOUND (see startEncounter).
  const initialSim = useMemo(() => {
    if (missionMode) return null;
    const s = new CombatSim(playerClass, enemyClass, { p1Gun: playerGun, p2Gun: enemyGun, p2HpMult: enemyHpMult });
    s.attachAI('p2', difficulty);
    return s;
  }, [missionMode, playerClass, enemyClass, difficulty, playerGun, enemyGun, enemyHpMult]);
  const simRef = useRef<CombatSim | null>(initialSim);
  if (!missionMode) simRef.current = initialSim;

  // Roam-phase body: same controller class the sim uses, bounded by the village
  // instead of a combat zone, colliding with the environment via resolveCover.
  const roamCtrl = useMemo(() => {
    if (!mission) return null;
    const spawn = missionRetry ? mission.retrySpawn : mission.playerSpawn;
    const c = new CharacterController(new THREE.Vector3(spawn[0], 0, spawn[1]), {
      arenaRadius: ROAM_RADIUS,
      arenaCenter: [0, 0],
    });
    c.state.rotation = Math.atan2(-spawn[0], -spawn[1]); // face the village
    return c;
  }, [mission, missionRetry]);

  // Debris for the FIRST encounter zone is laid out up front so the player
  // walks past real cover on the way in (the sim keeps it via keepCover).
  useMemo(() => {
    if (!mission) return;
    const spawn = missionRetry ? mission.retrySpawn : mission.playerSpawn;
    const enc = mission.encounters[0];
    regenerateCover(undefined, {
      cx: enc.pos[0], cz: enc.pos[1], radius: enc.zoneRadius + 1,
      clear: [spawn, enc.pos],
    });
  }, [mission, missionRetry]);

  // One display unit per encounter enemy: a dummy controller (idle placement,
  // then corpse) plus its own animation machine, so dropped targets stay where
  // they fell while the next one waits down the road.
  const enemyUnits = useMemo(() => {
    const count = mission ? mission.encounters.length : 1;
    const facing = mission ? (missionRetry ? mission.retrySpawn : mission.playerSpawn) : [-5, 0];
    return Array.from({ length: count }, (_, i) => {
      const pos: [number, number] = mission ? mission.encounters[i].pos : [5, 0];
      const ctrl = new CharacterController(new THREE.Vector3(pos[0], 0, pos[1]));
      ctrl.state.rotation = Math.atan2(facing[0] - pos[0], facing[1] - pos[1]);
      return { ctrl, machine: new AnimationStateMachine(CLASS_ANIMATIONS[enemyClass]) };
    });
  }, [mission, missionRetry, enemyClass]);

  const playerAnimMachine = useMemo(() => new AnimationStateMachine(CLASS_ANIMATIONS[playerClass]), [playerClass]);

  const combatAudio = useMemo(() => new CombatAudio(), []);
  const particles = useMemo(() => new ParticleSystem(), []);
  const crowd = useMemo(() => new CrowdDirector(), []);

  // Hit-stop (reserved for the kill freeze only — bullets don't freeze the game)
  const hitStopTimerRef = useRef(0);

  // Gunfire tracers + muzzle flashes, coloured per shooter for readability.
  const tracerFX = useMemo(() => new TracerFX(), []);

  // Floating combat text — damage numbers, crits, DODGE tags.
  const damageNumbers = useMemo(() => new DamageNumbers(), []);

  // Footstep timer
  const playerStepTimerRef = useRef(0);
  const enemyStepTimerRef = useRef(0);

  // Reload tracking — the sim event marks the start; the snapshot flag dropping
  // back to false marks the mag-in "chunk" moment.
  const wasReloadingRef = useRef({ p1: false, p2: false });

  // KO beat timeline state (null until someone dies). `final` = this KO ends
  // the whole fight/mission; a mid-chain kill loops back into roam instead.
  const koBeatRef = useRef<{
    t: number;
    winner: 'player' | 'enemy';
    durationSecs: number;
    resumed: boolean;
    slowmoEnded: boolean;
    resultFired: boolean;
    final: boolean;
  } | null>(null);

  // Silence everything (crowd loop included) when the scene unmounts — the
  // crowd now outlives the KO (it roars through the killcam), so the page
  // exit has to be the thing that finally stops it.
  useEffect(() => () => combatAudio.stopAll(), [combatAudio]);

  // Background music
  const bgmStartedRef = useRef(false);
  // Wall-clock start of live combat, for the fight-duration reward guard.
  const combatStartRef = useRef(0);

  // Camera choreography: missions open over the shoulder looking down-range at
  // the objective (the roam camera); quick fights open on the wide duel framing
  // for the countdown. Combat start swings in behind the player's shoulder, and
  // the KO beat pulls back out into the killcam orbit.
  useEffect(() => {
    battleCamera.setMode(missionMode ? 'ots' : 'duel');
  }, [battleCamera, missionMode]);

  const animFor = useCallback(
    (id: FighterId) => (id === 'p1' ? playerAnimMachine : enemyUnits[encIdxRef.current].machine),
    [playerAnimMachine, enemyUnits],
  );

  // A shot left the muzzle — fire clip + the GUN'S OWN voice/flash/tracer from its
  // feel profile, a brass casing, a recoil kick on the rig, and a camera kick on
  // the LOCAL player's fire only (the opponent's spray must not rattle the view).
  // The sim authored the shot; this just shows + sounds it.
  const fireFX = useCallback((e: Extract<SimEvent, { kind: 'fire' }>) => {
    const who = e.fighter;
    const feel = GUN_FEEL[e.gunId];
    animFor(who).transition(AnimState.Fire, true);
    combatAudio.playGunshot(feel.audio, who === 'p1' ? 1 : 0.75);

    const origin = new THREE.Vector3(e.origin[0], e.origin[1], e.origin[2]);
    const target = new THREE.Vector3(e.target[0], e.target[1], e.target[2]);
    tracerFX.fire(origin, target, who === 'p1' ? PLAYER_TRACER : ENEMY_TRACER, feel);

    // Brass out of the breech, to the shooter's right of the shot line.
    const side = new THREE.Vector3(e.dir[2], 0, -e.dir[0]).normalize();
    particles.emitCasing(origin, side);

    // Body recoil (decayed by FighterModel), scaled by the gun's kick.
    const s = simRef.current;
    if (s) s.controller(who).state.recoilPulse = Math.min(1, feel.kick);

    if (who === 'p1') {
      battleCamera.shake(feel.camShake, 45);
      battleCamera.punch(feel.camPunch);
    }
  }, [animFor, combatAudio, tracerFX, particles, battleCamera]);

  // A landed shot — the sim already applied damage/stagger; play the reaction clip
  // and feed the HUD. No per-bullet hit-stop — a firefight has to keep flowing.
  const onHit = useCallback((e: Extract<SimEvent, { kind: 'hit' }>) => {
    const ev = e.event;
    onDamageEvent?.(ev);
    const defenderId = ev.defenderId as FighterId;
    const defenderAnim = animFor(defenderId);
    const s = simRef.current;
    if (s) s.controller(defenderId).state.impactPulse = ev.hitType === 'light' ? 0.5 : 0.85;

    // Show the dice: every landed shot prints its number. Crits pop big and
    // gold; damage on YOU reads red so incoming pain is legible at a glance.
    damageNumbers.spawn(
      ev.hitPosition,
      String(ev.finalDamage),
      ev.critical
        ? { color: '#ffd24a', scale: 1.6 }
        : defenderId === 'p1'
          ? { color: '#ff7a7a', scale: 0.95 }
          : { color: '#ffffff', scale: 1.05 },
    );

    // Hitmarker (visual + tick) only for the local player's own landed shots.
    if (ev.attackerId === 'p1') {
      onHitmarker?.(ev.critical);
      combatAudio.playHitmarker(ev.critical);
    }

    combatAudio.onDamageEvent(ev);
    if (ev.killed) return; // the KO handler plays the death + ends the match

    defenderAnim.transitionHit(ev.hitType === 'light' ? AnimState.HitLight : AnimState.HitHeavy, e.direction);

    // Only crits/heavies nudge the camera + crowd; light hits stay quiet so a stream
    // of bullets doesn't thrash the screen.
    if (ev.critical || ev.hitType !== 'light') {
      battleCamera.punch(0.02);
      crowd.cheer(ev.hitType === 'special' ? 0.7 : 0.4);
      if (ev.critical) screenFx.onCriticalHit();
    }
  }, [animFor, combatAudio, crowd, screenFx, battleCamera, onDamageEvent, damageNumbers, onHitmarker]);

  // A projectile arrived — spark on a hit, dust on a whiff, and a celebration
  // when the miss was EARNED by dodge i-frames (that's the game's one skill).
  const impactFX = useCallback((e: Extract<SimEvent, { kind: 'projectileHit' }>) => {
    const s = simRef.current;
    if (!s) return;
    const pos = new THREE.Vector3(e.position[0], e.position[1], e.position[2]);
    const dir = new THREE.Vector3().subVectors(pos, s.controller(e.shooterId).state.position).setY(0).normalize();
    if (e.hit) {
      particles.emitImpact(pos, dir, e.crit ? 'special' : 'light');
      particles.emitSparks(pos, dir, e.crit ? 0.8 : 0.4);
    } else if (e.dodged) {
      if (e.targetId === 'p1') {
        // YOU read the shot and slipped it: whoosh, a quick FOV pull that
        // snaps back, and a teal shimmer where the round passed through.
        combatAudio.playSwing();
        battleCamera.setSlowMoFov(-7);
        setTimeout(() => battleCamera.setSlowMoFov(0), 220);
        particles.emitEnergy(pos, '#6ef7d8', 0.6);
      } else {
        // The enemy i-framed your shot — label it so a dodge never reads as
        // your gun randomly missing.
        damageNumbers.spawn(pos, 'DODGE', { color: '#8fd3ff', scale: 0.75 });
        particles.emitDust(pos, 0.3);
      }
    } else {
      particles.emitDust(pos, 0.3);
    }
  }, [particles, combatAudio, battleCamera, damageNumbers]);

  // ── Mission flow ────────────────────────────────────────────────────────────

  const roamTargetVec = useRef(new THREE.Vector3());

  // The player FOUND the enemy: build this encounter's sim where both bodies
  // actually stand, swing to the standoff framing, and hand the bark/countdown
  // to the page overlay. Combat itself starts when the countdown flips
  // combatActive (the existing wait-for-combat branch holds the standoff).
  const startEncounter = useCallback(() => {
    if (!mission || !roamCtrl) return;
    const i = encIdxRef.current;
    const enc = mission.encounters[i];
    const p = roamCtrl.state.position;
    const s = new CombatSim(playerClass, enemyClass, {
      p1Gun: playerGun, p2Gun: enemyGun, p2HpMult: enemyHpMult,
      p1Pos: [p.x, p.z], p2Pos: enc.pos,
      p1Health: healthCarryRef.current ?? undefined,
      zone: { cx: enc.pos[0], cz: enc.pos[1], radius: enc.zoneRadius },
      keepCover: true, // the zone's debris was laid out when the objective appeared
    });
    s.attachAI('p2', difficulty);
    s.controller('p1').state.rotation = roamCtrl.state.rotation;
    s.controller('p2').state.rotation = enemyUnits[i].ctrl.state.rotation;
    simRef.current = s;
    zoneRef.current = { cx: enc.pos[0], cz: enc.pos[1], radius: enc.zoneRadius };
    phaseRef.current = 'combat';
    setPhase('combat');
    battleCamera.setMode('duel');
    // Fresh enemy vitals for the standoff HUD; without this the bar shows the
    // PREVIOUS encounter's corpse (0 HP, mid-reload) until the first sim tick.
    const p2 = s.controller('p2').state;
    onEnemyStateUpdate?.(p2.health, p2.maxHealth);
    onEnemyReloadUpdate?.(false, 0);
    onEncounterStart?.(enc, i);
    bumpSim();
  }, [mission, roamCtrl, playerClass, enemyClass, playerGun, enemyGun, enemyHpMult, difficulty, enemyUnits, battleCamera, onEncounterStart, onEnemyStateUpdate, onEnemyReloadUpdate, bumpSim]);

  // Mid-chain target down: leave the corpse where it fell, patch the player up
  // a little, lay out the next zone's debris, and drop back into roam with the
  // next objective armed. Only the FINAL encounter reaches the result screen.
  const advanceEncounter = useCallback(() => {
    const s = simRef.current;
    if (!s || !mission || !roamCtrl) return;
    const i = encIdxRef.current;

    const dead = s.controller('p2').state;
    const unit = enemyUnits[i];
    unit.ctrl.state.position.copy(dead.position);
    unit.ctrl.state.rotation = dead.rotation;
    unit.ctrl.state.isDead = true;

    const pc = s.controller('p1').state;
    roamCtrl.state.position.copy(pc.position);
    roamCtrl.state.rotation = pc.rotation;
    roamCtrl.state.velocity.set(0, 0, 0);
    healthCarryRef.current = Math.min(pc.maxHealth, pc.health + Math.round(pc.maxHealth * 0.35));
    onPlayerStateUpdate?.(healthCarryRef.current, pc.maxHealth, 100, 100);

    const next = mission.encounters[i + 1];
    regenerateCover(undefined, {
      cx: next.pos[0], cz: next.pos[1], radius: next.zoneRadius + 1,
      clear: [[pc.position.x, pc.position.z], next.pos],
    });

    encIdxRef.current = i + 1;
    setEncIdx(i + 1);
    simRef.current = null;
    battleEndedRef.current = false;
    koBeatRef.current = null;
    wasReloadingRef.current = { p1: false, p2: false };
    playerAnimMachine.setTimeScale(1);
    unit.machine.setTimeScale(1);
    playerAnimMachine.transition(AnimState.Idle, true);
    bgmStartedRef.current = false; // music re-arms at the next FIGHT
    battleCamera.setMode('ots');   // shoulder cam aimed down-range at the next objective
    phaseRef.current = 'roam';
    setPhase('roam');
    onEncounterCleared?.(i);
    bumpSim();
  }, [mission, roamCtrl, enemyUnits, playerAnimMachine, battleCamera, onEncounterCleared, onPlayerStateUpdate, bumpSim]);

  const frameCountRef = useRef(0);

  useFrame((_, dt) => {
    const clampedDt = Math.min(dt, 0.05);
    frameCountRef.current++;

    // VFX live on through hit-stop. screenFx MUST tick every frame: its flashes/tints
    // decay here, and the shooter doesn't use per-hit hit-stop — so if this only ran
    // inside the hit-stop branch (as it once did), the first crit's gold flash would
    // never decay and leave the whole screen washed yellow.
    tracerFX.update(clampedDt);
    particles.update(clampedDt);
    damageNumbers.update(clampedDt);
    crowd.update(clampedDt);
    combatAudio.setCrowdEnergy(crowd.energy);
    screenFx.update(clampedDt);

    const sim = simRef.current;
    const enemyMachine = animFor('p2');

    if (battleEndedRef.current && sim) {
      // The kill moment: freeze → slow-mo under the killcam orbit → result.
      const beat = koBeatRef.current;
      if (beat) {
        beat.t += clampedDt;
        if (!beat.resumed && beat.t >= KO_FREEZE_SEC) {
          beat.resumed = true;
          // resume() replays the queued Death/Victory transitions; slow the
          // mixers AFTER resume (resume resets timeScale to 1). FOV tightens.
          playerAnimMachine.resume();
          enemyMachine.resume();
          playerAnimMachine.setTimeScale(KO_SLOWMO_SCALE);
          enemyMachine.setTimeScale(KO_SLOWMO_SCALE);
          battleCamera.setSlowMoFov(-8);
        }
        if (!beat.slowmoEnded && beat.t >= KO_SLOWMO_UNTIL) {
          beat.slowmoEnded = true;
          playerAnimMachine.setTimeScale(1);
          enemyMachine.setTimeScale(1);
          battleCamera.setSlowMoFov(0);
        }
        if (!beat.resultFired && beat.t >= KO_RESULT_AT) {
          beat.resultFired = true;
          if (beat.final) {
            if (beat.winner === 'player') combatAudio.playVictoryFanfare();
            else combatAudio.playDefeatMelody();
            onBattleEnd?.(beat.winner, beat.durationSecs);
          } else {
            // Target down mid-chain — back to the hunt.
            advanceEncounter();
            return;
          }
        }
      }
      // The killcam keeps orbiting the winner through (and behind) the result.
      battleCamera.update(clampedDt, sim.controller('p1').state.position, sim.controller('p2').state.position);
      return;
    }

    // Hit-stop: freeze game logic but keep VFX + camera alive
    if (hitStopTimerRef.current > 0 && sim) {
      hitStopTimerRef.current -= clampedDt;
      battleCamera.update(clampedDt, sim.controller('p1').state.position, sim.controller('p2').state.position);
      if (hitStopTimerRef.current <= 0) {
        playerAnimMachine.resume();
        enemyMachine.resume();
      }
      return;
    }

    // --- Roam: walk the level, find the enemy ---
    if (phaseRef.current === 'roam' && mission && roamCtrl) {
      const enc = mission.encounters[encIdxRef.current];
      const rs = roamCtrl.state;
      roamCtrl.update(clampedDt, input, battleCamera.cameraYaw);
      // Collide with the world: village walls, debris, props.
      const [nx, nz] = resolveCover(rs.position.x, rs.position.z, 0.55);
      rs.position.x = nx;
      rs.position.z = nz;

      // Shoulder cam aimed down-range at the objective — W walks you there.
      roamTargetVec.current.set(enc.pos[0], 0, enc.pos[1]);
      battleCamera.update(clampedDt, rs.position, roamTargetVec.current);

      // Locomotion straight off the live body (no sim yet).
      const roamSpeed = Math.hypot(rs.velocity.x, rs.velocity.z);
      playerAnimMachine.transition(
        rs.isDodging ? AnimState.Dodge
          : roamSpeed > 0.2 ? (rs.isRunning ? AnimState.Run : AnimState.Walk)
          : AnimState.Idle,
      );

      if (roamSpeed > FOOTSTEP_SPEED_THRESHOLD) {
        playerStepTimerRef.current -= clampedDt;
        if (playerStepTimerRef.current <= 0) {
          playerStepTimerRef.current = FOOTSTEP_INTERVAL;
          combatAudio.playFootstep();
        }
      } else {
        playerStepTimerRef.current = 0;
      }

      // The battlefield breathes from the first step, not the first shot.
      if (!hasCrowd) combatAudio.startWindAmbience();

      const d = Math.hypot(rs.position.x - enc.pos[0], rs.position.z - enc.pos[1]);
      onObjective?.(enc.objective, Math.round(d));

      // Found them.
      if (d < Math.min(enc.zoneRadius * 0.8, 8)) startEncounter();

      input.update();
      return;
    }

    if (!sim) {
      input.update();
      return;
    }
    const playerController = sim.controller('p1');
    const enemyController = sim.controller('p2');

    // --- Wait for combat to start (countdown / standoff bark) ---
    const ps = playerController.state;
    if (!combatActiveRef.current) {
      battleCamera.update(clampedDt, ps.position, enemyController.state.position);
      input.update();
      return;
    }

    // --- Start background music + crowd ambience on first combat frame ---
    if (!bgmStartedRef.current) {
      bgmStartedRef.current = true;
      combatStartRef.current = performance.now();
      combatAudio.startBGM();
      // Colosseum breathes with its crowd; the battlefield breathes with wind
      // and the crackle of what's still burning.
      if (hasCrowd) combatAudio.startCrowdAmbience();
      else combatAudio.startWindAmbience();
      // FIGHT: swing from the wide duel framing in behind the player's shoulder.
      battleCamera.setMode('ots');
    }

    // --- Advance Simulation Headless ---
    const events = sim.step(clampedDt, { p1: input }, { p1: battleCamera.cameraYaw });

    // --- Process Simulation Events ---
    events.forEach((e) => {
      if (e.kind === 'fire') {
        fireFX(e);
      } else if (e.kind === 'projectileHit') {
        impactFX(e);
      } else if (e.kind === 'hit') {
        onHit(e);
      } else if (e.kind === 'reload') {
        // Enemy reloads are quieter but audible — hearing their mag drop is
        // tactical information (your window to push).
        combatAudio.playReloadStart(e.fighter === 'p1' ? 1 : 0.5);
      } else if (e.kind === 'ko') {
        if (!battleEndedRef.current) {
          battleEndedRef.current = true;
          combatActiveRef.current = false;
          // BGM cuts dead; in the colosseum the crowd stays live and ERUPTS
          // over the killcam. On a battlefield the wind just keeps blowing.
          combatAudio.stopMusic();
          if (hasCrowd) combatAudio.crowdCheer(1);
          crowd.cheer(1);

          const winner = e.winner === 'p1' ? 'player' : 'enemy';
          const loser = e.loser === 'p1' ? 'player' : 'enemy';

          // Chain bookkeeping: only a player win with encounters still queued
          // continues the mission; anything else lands on the result screen.
          const isFinal = !missionMode
            || winner !== 'player'
            || encIdxRef.current >= (mission?.encounters.length ?? 1) - 1;

          // Freeze the killing frame — both bodies hold while the burst pops.
          // The Death/Victory transitions queue behind the pause and start
          // playing (in slow-mo) when the beat timeline resumes the machines.
          playerAnimMachine.pause();
          enemyMachine.pause();
          const loserAnim = loser === 'player' ? playerAnimMachine : enemyMachine;
          const winnerAnim = winner === 'player' ? playerAnimMachine : enemyMachine;
          loserAnim.transition(AnimState.Death, true);
          winnerAnim.transition(AnimState.Victory, true);

          const loserPos = sim.controller(e.loser).state.position;
          particles.emitKillBurst(
            new THREE.Vector3(loserPos.x, 1.0, loserPos.z),
            CLASS_ACCENTS[loser === 'player' ? playerClass : enemyClass],
          );
          battleCamera.shake(0.09, 30);
          battleCamera.punch(0.05);
          screenFx.onCriticalHit();

          // Killcam: melt from the shoulder cam into a slow orbit of the winner.
          battleCamera.startKillcam(winner === 'player' ? 'player' : 'target');

          koBeatRef.current = {
            t: 0,
            winner,
            durationSecs: combatStartRef.current
              ? (performance.now() - combatStartRef.current) / 1000
              : 0,
            resumed: false,
            slowmoEnded: false,
            resultFired: false,
            final: isFinal,
          };
        }
      }
    });

    // --- Camera follows the duel ---
    // The lock-on camera frames both fighters and tracks them as they move, so a
    // fighter can't stroll out of shot. Without this the camera sat frozen at the
    // arena centre the whole fight (it was only ticked pre-combat and in hit-stop).
    battleCamera.update(clampedDt, ps.position, enemyController.state.position);

    // --- Synchronise Animation States Frame-by-Frame ---
    // Skip the idle/locomotion sync while a one-shot Fire clip is mid-play so the
    // muzzle animation isn't stomped every frame; reactions/dodge/death still
    // interrupt it (they aren't in the skip set).
    const snapshot = sim.snapshot();
    const syncAnim = (machine: AnimationStateMachine, animState: AnimState) => {
      if (machine.state === AnimState.Fire &&
          (animState === AnimState.Idle || animState === AnimState.Walk || animState === AnimState.Run)) {
        return;
      }
      machine.transition(animState);
    };
    syncAnim(playerAnimMachine, snapshot.fighters.p1.animState);
    syncAnim(enemyMachine, snapshot.fighters.p2.animState);

    // --- Footsteps + ground dust ---
    const playerSpeed = Math.sqrt(ps.velocity.x ** 2 + ps.velocity.z ** 2);
    if (playerSpeed > FOOTSTEP_SPEED_THRESHOLD && !ps.isAttacking && !ps.isStaggered && !ps.isDead) {
      playerStepTimerRef.current -= clampedDt;
      if (playerStepTimerRef.current <= 0) {
        playerStepTimerRef.current = FOOTSTEP_INTERVAL;
        combatAudio.playFootstep();
      }
    } else {
      playerStepTimerRef.current = 0;
    }

    const es = enemyController.state;
    const enemySpeed = Math.sqrt(es.velocity.x ** 2 + es.velocity.z ** 2);
    if (enemySpeed > FOOTSTEP_SPEED_THRESHOLD && !es.isAttacking && !es.isStaggered && !es.isDead) {
      enemyStepTimerRef.current -= clampedDt;
      if (enemyStepTimerRef.current <= 0) {
        enemyStepTimerRef.current = FOOTSTEP_INTERVAL;
        combatAudio.playFootstep(0.15);
      }
    } else {
      enemyStepTimerRef.current = 0;
    }

    // --- Reload finish: the mag-in "chunk" when reloading flips back off ---
    for (const id of ['p1', 'p2'] as const) {
      const now = snapshot.fighters[id].reloading;
      if (wasReloadingRef.current[id] && !now) {
        combatAudio.playReloadEnd(id === 'p1' ? 1 : 0.5);
      }
      wasReloadingRef.current[id] = now;
    }

    // --- Update HUD Stats ---
    const playerStats = sim.damage.getStats('p1');
    onPlayerStateUpdate?.(ps.health, ps.maxHealth, playerStats?.stamina ?? 100, playerStats?.staminaMax ?? 100);
    onEnemyStateUpdate?.(enemyController.state.health, enemyController.state.maxHealth);
    const p1Snap = snapshot.fighters.p1;
    onAmmoUpdate?.(p1Snap.ammo, p1Snap.magazine, p1Snap.reloading, p1Snap.reloadProgress);
    const p2Snap = snapshot.fighters.p2;
    onEnemyReloadUpdate?.(p2Snap.reloading, p2Snap.reloadProgress);
  });

  // Per-arena fog + background — set at scene level (not inside a <group>,
  // where attach="fog" would bind to the group instead of the scene).
  const arenaFog = ARENA_FOG[arenaVariant];

  return (
    <>
      <color attach="background" args={[arenaFog.bg]} />
      <fog attach="fog" args={[arenaFog.fog, arenaFog.near, arenaFog.far]} />

      {arenaVariant === 'ashfall' ? <AshfallArena /> : <StylizedArena />}
      {/* Battlefield stages have no stadium; the crowd only exists in the colosseum. */}
      {hasCrowd && <Crowd director={crowd} />}
      <CoverProps variant={arenaVariant} />

      {/* Mission staging: the objective beacon while hunting, the zone ring while fighting. */}
      {missionMode && phase === 'roam' && mission && (
        <ObjectiveMarker
          x={mission.encounters[Math.min(encIdx, mission.encounters.length - 1)].pos[0]}
          z={mission.encounters[Math.min(encIdx, mission.encounters.length - 1)].pos[1]}
        />
      )}
      {missionMode && phase === 'combat' && zoneRef.current && (
        <ZoneRing cx={zoneRef.current.cx} cz={zoneRef.current.cz} radius={zoneRef.current.radius} />
      )}

      <FighterModel
        classId={playerClass}
        state={phase === 'roam' && roamCtrl ? roamCtrl.state : simRef.current ? simRef.current.controller('p1').state : roamCtrl!.state}
        animMachine={playerAnimMachine}
        accent={CLASS_ACCENTS[playerClass]}
        gunId={playerGun}
      />
      {/* One model per encounter enemy: the current target (idle until found,
          sim-driven in combat) plus every corpse the chain already dropped. */}
      {enemyUnits.map((u, i) =>
        i > encIdx ? null : (
          <FighterModel
            key={i}
            classId={enemyClass}
            state={i === encIdx && simRef.current ? simRef.current.controller('p2').state : u.ctrl.state}
            animMachine={u.machine}
            accent={CLASS_ACCENTS[enemyClass]}
            gunId={enemyGun}
          />
        ),
      )}
      <primitive object={tracerFX.group} />
      <primitive object={particles.mesh} />
      <primitive object={damageNumbers.group} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} receiveShadow>
        <planeGeometry args={[50, 50]} />
        <shadowMaterial opacity={0.3} />
      </mesh>
    </>
  );
}

function LoadingScreen() {
  return (
    <mesh>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#333" wireframe />
    </mesh>
  );
}

export function GameScene(props: GameSceneProps) {
  const [playerHP, setPlayerHP] = useState(100);
  const [playerMaxHP, setPlayerMaxHP] = useState(100);
  const [playerStamina, setPlayerStamina] = useState(100);
  const [playerStaminaMax, setPlayerStaminaMax] = useState(100);
  const [enemyHP, setEnemyHP] = useState(100);
  const [enemyMaxHP, setEnemyMaxHP] = useState(100);
  const [combo, setCombo] = useState<ComboState | null>(null);
  const [ammoHud, setAmmoHud] = useState({ ammo: 0, magazine: 0, reloading: false, progress: 0 });
  const [enemyReload, setEnemyReload] = useState({ reloading: false, progress: 0 });
  // Keyed by id so each landed hit re-mounts the marker and restarts its animation.
  const [hitmarker, setHitmarker] = useState<{ id: number; crit: boolean } | null>(null);
  const hitmarkerId = useRef(0);
  const [battleResult, setBattleResult] = useState<'player' | 'enemy' | null>(null);
  const [countdown, setCountdown] = useState<number | 'FIGHT' | null>(null);
  const [sceneReady, setSceneReady] = useState(false);
  const combatStartedRef = useRef(false);

  // Mission overlays: the roam objective line, the enemy's standoff bark, and
  // the mid-chain "target down" beat.
  const [objective, setObjective] = useState<{ text: string; dist: number } | null>(null);
  const [bark, setBark] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const arenaVariant: ArenaVariant = STAGE_VARIANTS[props.stageId ?? 'battle_arena'];

  const difficulty = props.difficulty ?? AIDifficulty.Medium;
  const inputAttached = useRef(false);
  const screenFx = useMemo(() => new ScreenEffects(), []);

  useEffect(() => {
    if (inputAttached.current) return;
    inputAttached.current = true;
    const input = getInputSystem();
    input.attach(window);
  }, []);

  // The Ashfall stage IS collidable geometry — register the village with the
  // sim's static cover layer so walls block movement, bullets and the camera.
  // Registered during render (not an effect): BattleWorld generates the first
  // encounter's debris inside the R3F tree, and its wall-overlap checks need
  // the static layer to already exist by then.
  useMemo(() => {
    setStaticCover(arenaVariant === 'ashfall' ? villageColliders() : []);
  }, [arenaVariant]);
  useEffect(() => () => setStaticCover([]), []);

  const startCountdown = useCallback(() => {
    if (combatStartedRef.current) return;
    setSceneReady(true);
    setCountdown(3);
    setTimeout(() => setCountdown(2), 1000);
    setTimeout(() => setCountdown(1), 2000);
    setTimeout(() => {
      setCountdown('FIGHT');
      combatStartedRef.current = true;
    }, 3000);
    setTimeout(() => setCountdown(null), 3800);
  }, []);

  // Roam HUD line — identical values bail out so the 60fps stream doesn't
  // re-render the overlay tree.
  const handleObjective = useCallback((text: string, dist: number) => {
    setObjective((prev) => (prev && prev.text === text && prev.dist === dist ? prev : { text, dist }));
  }, []);

  // Standoff: objective HUD off, the enemy gets their line, then the countdown.
  const handleEncounterStart = useCallback((enc: MissionEncounter) => {
    setObjective(null);
    setBark(enc.bark);
    setTimeout(() => {
      setBark(null);
      startCountdown();
    }, 2000);
  }, [startCountdown]);

  // Mid-chain kill: re-arm the countdown gate and let the beat breathe.
  const handleEncounterCleared = useCallback(() => {
    combatStartedRef.current = false;
    setToast('TARGET DOWN');
    setTimeout(() => setToast(null), 2400);
  }, []);

  return (
    <div className="w-full h-full relative" tabIndex={0}>
      <Canvas
        shadows
        camera={{ fov: 50, near: 0.1, far: 200, position: [0, 3, 8] }}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.6 }}
        className="w-full h-full"
      >
        {/* Per-arena fog + background are set in BattleWorld at the scene level. */}
        <Suspense fallback={<LoadingScreen />}>
          <BattleWorld
            {...props}
            difficulty={difficulty}
            arenaVariant={arenaVariant}
            combatActive={combatStartedRef.current}
            screenFx={screenFx}
            onDamageEvent={props.onDamageEvent}
            onComboUpdate={setCombo}
            onPlayerStateUpdate={(h, mh, s, sm) => { setPlayerHP(h); setPlayerMaxHP(mh); setPlayerStamina(s); setPlayerStaminaMax(sm); }}
            onEnemyStateUpdate={(h, mh) => { setEnemyHP(h); setEnemyMaxHP(mh); }}
            onAmmoUpdate={(ammo, magazine, reloading, progress) =>
              // Bail out (return the same object) unless something changed — this
              // fires every frame and must not re-render the HUD at 60fps.
              setAmmoHud((prev) =>
                prev.ammo === ammo && prev.magazine === magazine &&
                prev.reloading === reloading && prev.progress === progress
                  ? prev
                  : { ammo, magazine, reloading, progress })}
            onEnemyReloadUpdate={(reloading, progress) =>
              setEnemyReload((prev) =>
                prev.reloading === reloading && prev.progress === progress
                  ? prev
                  : { reloading, progress })}
            onHitmarker={(crit) => setHitmarker({ id: ++hitmarkerId.current, crit })}
            onBattleEnd={(w, d) => { setBattleResult(w); props.onBattleEnd?.(w, d); }}
            // Missions open in roam (no countdown until the enemy is found);
            // quick fights count straight down into the duel.
            onReady={props.mission ? () => setSceneReady(true) : startCountdown}
            onObjective={handleObjective}
            onEncounterStart={handleEncounterStart}
            onEncounterCleared={handleEncounterCleared}
          />
        </Suspense>
      </Canvas>

      <ScreenFlashOverlay screenEffects={screenFx} />

      {/* HUD */}
      <div className="fixed inset-0 pointer-events-none z-30">
        <div className="absolute top-4 left-4 md:top-6 md:left-6">
          <div className="text-xs font-bold uppercase tracking-wider text-white/80 mb-1">{props.playerClass}</div>
          <div className="relative w-48 md:w-64 h-4 rounded-sm overflow-hidden bg-black/60 border border-white/10">
            <div className="absolute inset-y-0 left-0 rounded-sm transition-all duration-300" style={{
              width: `${Math.max(0, (playerHP / playerMaxHP) * 100)}%`,
              backgroundColor: playerHP < 25 ? '#ef4444' : CLASS_ACCENTS[props.playerClass],
            }} />
          </div>
          <div className="text-xs text-white/50 font-mono mt-0.5">{playerHP}/{playerMaxHP}</div>
          <div className="w-32 md:w-48 h-2 rounded-full overflow-hidden bg-black/40 border border-white/5 mt-1">
            <div className="h-full rounded-full transition-all duration-150" style={{
              width: `${(playerStamina / playerStaminaMax) * 100}%`,
              backgroundColor: playerStamina < 20 ? '#f59e0b' : '#22c55e',
            }} />
          </div>
        </div>
        {/* Enemy vitals only exist once there's an enemy in front of you —
            during the roam hunt the objective line takes this slot's job. */}
        {!objective && (
          <div className="absolute top-4 right-4 md:top-6 md:right-6 text-right">
            <div className="text-xs font-bold uppercase tracking-wider text-white/80 mb-1">{props.enemyName ?? props.enemyClass}</div>
            <div className="relative w-48 md:w-64 h-4 rounded-sm overflow-hidden bg-black/60 border border-white/10">
              <div className="absolute inset-y-0 right-0 rounded-sm transition-all duration-300" style={{
                width: `${Math.max(0, (enemyHP / enemyMaxHP) * 100)}%`,
                backgroundColor: enemyHP < 25 ? '#ef4444' : CLASS_ACCENTS[props.enemyClass],
              }} />
            </div>
            <div className="text-xs text-white/50 font-mono mt-0.5">{enemyHP}/{enemyMaxHP}</div>
            {/* Their mag is out — this is your window to push. */}
            {enemyReload.reloading && !battleResult && (
              <div className="mt-1 flex items-center justify-end gap-2">
                <span className="text-[10px] font-black uppercase tracking-[0.18em] text-amber-400 animate-pulse">
                  Reloading
                </span>
                <div className="w-16 h-1 rounded-full bg-black/50 overflow-hidden">
                  <div className="h-full bg-amber-400 rounded-full" style={{ width: `${Math.round(enemyReload.progress * 100)}%` }} />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Roam objective — what you're hunting and how far away it is. */}
        {objective && !battleResult && (
          <div className="absolute top-14 left-1/2 -translate-x-1/2 text-center">
            <div className="text-[10px] font-black uppercase tracking-[0.3em] text-amber-300/90">Objective</div>
            <div className="text-sm md:text-base font-bold text-white/95 drop-shadow-[0_2px_6px_rgba(0,0,0,0.8)] max-w-xs md:max-w-md">
              {objective.text}
            </div>
            <div className="text-xs font-mono text-amber-200/80 mt-0.5">{objective.dist}m</div>
          </div>
        )}

        {/* Hitmarker — X ticks at screen centre (the OTS camera keeps the enemy
            there); re-mounts per hit via the key to restart the animation. */}
        {hitmarker && !battleResult && (
          <div
            key={hitmarker.id}
            className="absolute left-1/2 top-1/2"
            style={{ animation: 'hitmarker 220ms ease-out forwards' }}
          >
            <div className="relative w-7 h-7">
              {([
                { top: 0, left: 0, rot: -45 },
                { top: 0, right: 0, rot: 45 },
                { bottom: 0, left: 0, rot: 45 },
                { bottom: 0, right: 0, rot: -45 },
              ] as const).map((p, i) => (
                <span
                  key={i}
                  style={{
                    position: 'absolute',
                    width: 3,
                    height: 11,
                    borderRadius: 1,
                    background: hitmarker.crit ? '#ffd24a' : 'rgba(255,255,255,0.95)',
                    boxShadow: '0 0 5px rgba(0,0,0,0.7)',
                    transform: `rotate(${p.rot}deg)`,
                    ...('top' in p ? { top: p.top } : {}),
                    ...('bottom' in p ? { bottom: p.bottom } : {}),
                    ...('left' in p ? { left: p.left } : {}),
                    ...('right' in p ? { right: p.right } : {}),
                  }}
                />
              ))}
            </div>
          </div>
        )}
        {combo && combo.count >= 2 && (
          <div className="absolute top-1/3 right-8 text-center">
            <div className="text-4xl font-black text-yellow-400">{combo.count}</div>
            <div className="text-sm font-bold uppercase text-yellow-300/80">HIT COMBO</div>
          </div>
        )}

        {/* Ammo / reload — the gun's own status line. Sits clear of the mobile
            touch stick (left) and fire button (right). */}
        {ammoHud.magazine > 0 && !battleResult && !objective && (
          <div className="absolute bottom-6 md:bottom-24 left-1/2 -translate-x-1/2 text-center">
            {ammoHud.reloading ? (
              <div className="w-44">
                <div className="text-xs font-black uppercase tracking-[0.2em] text-amber-400 animate-pulse mb-1">
                  Reloading
                </div>
                <div className="h-1.5 rounded-full overflow-hidden bg-black/60 border border-white/10">
                  <div
                    className="h-full rounded-full bg-amber-400"
                    style={{ width: `${Math.round(ammoHud.progress * 100)}%` }}
                  />
                </div>
              </div>
            ) : (
              <div
                className="font-mono font-black text-3xl leading-none drop-shadow-[0_2px_6px_rgba(0,0,0,0.8)]"
                style={{
                  color: ammoHud.ammo === 0
                    ? '#f87171'
                    : ammoHud.ammo <= Math.max(1, Math.floor(ammoHud.magazine * 0.25))
                      ? '#fbbf24'
                      : 'rgba(255,255,255,0.92)',
                }}
              >
                {ammoHud.ammo}
                <span className="text-base font-bold text-white/40"> / {ammoHud.magazine}</span>
              </div>
            )}
          </div>
        )}
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 hidden md:flex gap-3">
          {[
            { key: 'WASD', label: 'Move' },
            { key: 'LMB / J', label: 'Fire', color: '#ff6644' },
            { key: '␣', label: 'Dodge', color: '#22cc66' },
          ].map(({ key, label, color }) => (
            <div key={key} className="flex flex-col items-center gap-1">
              <div className="min-w-10 px-2 h-10 rounded-lg border flex items-center justify-center text-xs font-mono font-bold bg-black/60"
                style={{ borderColor: color ?? '#555', color: color ?? '#aaa' }}>{key}</div>
              <span className="text-[9px] uppercase tracking-wider text-white/40">{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Standoff bark — the enemy's line when you find them. */}
      {bark && (
        <div className="fixed inset-x-0 bottom-24 z-50 flex justify-center pointer-events-none">
          <div className="max-w-xl mx-4 px-5 py-3 bg-black/75 border border-white/10 rounded-lg text-center">
            <div className="text-[10px] font-black uppercase tracking-[0.25em] text-red-400 mb-1">
              {props.enemyName ?? props.enemyClass}
            </div>
            <div className="text-white/95 text-base md:text-lg font-semibold">“{bark}”</div>
          </div>
        </div>
      )}

      {/* Mid-chain kill beat — target down, mission continues. */}
      {toast && !battleResult && (
        <div className="fixed inset-0 z-40 flex items-center justify-center pointer-events-none">
          <div className="text-center">
            <div className="text-4xl md:text-5xl font-black text-emerald-400 drop-shadow-[0_0_25px_rgba(52,211,153,0.5)]">
              {toast}
            </div>
            <div className="text-sm font-bold uppercase tracking-[0.25em] text-white/70 mt-2">Push forward</div>
          </div>
        </div>
      )}

      {/* Countdown overlay */}
      {countdown !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          <div className="text-center">
            {typeof countdown === 'number' ? (
              <div className="text-8xl md:text-9xl font-black text-white drop-shadow-[0_0_30px_rgba(255,255,255,0.5)] animate-pulse">
                {countdown}
              </div>
            ) : (
              <div className="text-7xl md:text-8xl font-black text-yellow-400 drop-shadow-[0_0_40px_rgba(250,204,21,0.6)]">
                FIGHT!
              </div>
            )}
          </div>
        </div>
      )}

      {/* VS intro before countdown */}
      {!sceneReady && !battleResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 pointer-events-none">
          <div className="text-center">
            <div className="text-2xl md:text-3xl font-black text-white/80 mb-2">Loading Arena...</div>
            <div className="w-32 h-1 bg-white/10 rounded-full mx-auto overflow-hidden">
              <div className="h-full bg-white/50 rounded-full animate-pulse w-2/3" />
            </div>
          </div>
        </div>
      )}

      {battleResult && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 pointer-events-auto">
          <h1 className="text-5xl md:text-7xl font-black" style={{ color: battleResult === 'player' ? CLASS_ACCENTS[props.playerClass] : '#ef4444' }}>
            {battleResult === 'player' ? 'VICTORY' : 'DEFEATED'}
          </h1>
          <p className="text-white/50 mt-3 text-lg">
            {battleResult === 'player' ? 'Enemy has been slain' : `Slain by ${props.enemyName ?? props.enemyClass}`}
          </p>

          {props.rewardPending && (
            <div className="mt-5 text-sm text-white/50 animate-pulse">Recording result…</div>
          )}
          {props.reward && (
            <div className="mt-5 flex flex-col items-center gap-1.5">
              <div className="text-2xl font-black text-green-400">+{props.reward.xpAwarded} XP</div>
              {props.reward.rankedUp && props.reward.newRank && (
                <div className="text-lg font-black uppercase tracking-wide text-yellow-400 drop-shadow-[0_0_12px_rgba(250,204,21,0.5)]">
                  Rank Up → {props.reward.newRank}
                </div>
              )}
              {props.reward.gAwarded > 0 && (
                <div className="text-lg font-bold text-emerald-300">+{props.reward.gAwarded} G$</div>
              )}
            </div>
          )}

          {/* Post-fight actions rendered by the parent page via postFightActions */}
          {props.postFightActions}
        </div>
      )}

      <TouchControls />
    </div>
  );
}
