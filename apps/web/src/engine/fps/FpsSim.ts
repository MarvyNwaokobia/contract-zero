/**
 * @module fps/FpsSim
 * @description The headless first-person shooter core for the Valor clone (the plan
 * slice 1). Render-free and deterministic: no Three.js rendering, no DOM. The
 * scene passes the shooter's eye ray + input each step; the sim owns ammo,
 * cadence, reload, spread, the raycast against enemy hitboxes and cover, damage,
 * and respawns, and emits events the scene turns into muzzle flash, tracers,
 * hitmarkers and audio (audio arrives in slice 2).
 *
 * Reuses the existing gun catalogue (engine/combat/GunStats). The stat-duel's
 * hidden `accuracy` roll is reinterpreted here as an aim SPREAD cone: higher
 * accuracy = tighter cone. Skill (where you point) decides the hit now, not a die.
 *
 * The one deliberate split from the old CombatSim: RECOIL (the climb) lives in
 * the scene because it moves the camera, and the shot ray is simply the camera
 * forward the scene passes in. The sim owns only SPREAD (the bloom) on top of
 * that ray. So a shot goes exactly where the muzzle points, plus a little cone.
 */

import { getGun, type GunId, type GunStats } from '../combat/GunStats';
import {
  AMMO_CATALOG,
  resolveGunStats,
  type AmmoId,
  type AttachmentId,
  type AttachmentSlot,
} from '../combat/Loadout';

export type Vec3 = [number, number, number];

/** Enemy behaviour (slice 3). hidden/recover = ducked & safe; aim = telegraphing
 *  a shot (the reaction window); fire = the shot; seek = repositioning. */
export type EnemyAI = 'hidden' | 'seek' | 'aim' | 'fire' | 'recover';

/** A humanoid combatant. Head is a sphere, body an axis-aligned box. */
export interface FpsEnemy {
  id: number;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  /** sim-time (s) of death, for the scene's fall/fade + the respawn timer. */
  deadAt: number;
  // ── AI (slice 3) ──
  ai: EnemyAI;
  aiUntil: number;   // when the current phase ends
  facing: number;    // yaw toward the player, for rendering
  token: boolean;    // holds an aggression token (allowed to shoot this beat)
  ducking: number;   // 0 exposed .. 1 fully in cover (visual + fire-gating)
  goalX: number;     // where it's maneuvering to
  goalZ: number;
  nextGoalAt: number;
  room: number;      // mission room (slice 4)
  active: boolean;   // AI only runs when the room has been entered
  // ── Contact (what this enemy BELIEVES, which is not always the truth) ──
  /** Where it last had eyes on the player. Everything it does without line of
   *  sight is aimed here, which is what makes cover worth anything. */
  seenX: number;
  seenZ: number;
  /** Sim-time of that sighting; 0 = it has never had contact at all. Age decides
   *  whether it is still hunting or has given up and gone back to its post. */
  seenAt: number;
  boss: boolean;
  phase: number;     // 0 for a mook; 1..3 for a boss, rising as its health falls
  // ── Incendiary DoT (B) ──
  burnUntil: number; // sim-time the thermite burn stops (0 = not burning)
  burnDps: number;   // HP/s the active burn ticks for
  // ── Co-op targeting (Endless party mode only) ──
  /** Who this enemy is currently engaging — `LOCAL_TARGET` (the local
   *  player) for every mode but co-op. Sticky: only re-picked when the
   *  current target dies or drops out of sight while someone else is
   *  visible — see `pickTarget`. With zero registered `combatants` (every
   *  mode except co-op) this always resolves back to `LOCAL_TARGET`, which
   *  is what keeps every other mode's behavior byte-identical to before
   *  this field existed. */
  targetId: string;
}

/** Sentinel `targetId`/combatant key meaning "the local player" — every
 *  mode but co-op only ever has this one target. Not a real wallet, just a
 *  stable id `resolveTarget`/`pickTarget` can compare against. */
const LOCAL_TARGET = '__local__';

/** A teammate in a co-op Endless party, tracked as a live target for enemy
 *  AI alongside the local player. HP/alive are HOST-owned (this `FpsSim`
 *  instance only ever runs on the party host — see `ValorScene`'s `coop`
 *  prop) — a teammate's own client never reports its own HP, only its
 *  position/aim, exactly like the local player never reports its own HP
 *  either. */
interface Combatant {
  x: number;
  z: number;
  eyeY: number;
  hp: number;
  alive: boolean;
}

/** A wall or crate: an axis-aligned box that blocks movement and bullets. */
export interface CoverBox {
  x: number;
  z: number;
  w: number; // full extent on X
  d: number; // full extent on Z
  h: number; // height (from y=0)
}

export interface FpsInput {
  firing: boolean;
  wantReload: boolean;
  /** Shooter eye position in world space. */
  origin: Vec3;
  /** Normalised aim forward (already includes look + the scene's recoil climb). */
  dir: Vec3;
  adsFactor: number; // 0 hip .. 1 fully aimed
  moving: boolean;
  crouched: boolean;
}

export type FpsEvent =
  | { kind: 'fire'; ammo: number; spread: number }
  | { kind: 'empty' }
  // `shooterId` is undefined for the local player's own shots (every mode
  // but co-op never sets it) — present and set to a teammate's wallet when
  // `resolveRemoteShot` (co-op only) is what landed the hit.
  | { kind: 'hit'; enemyId: number; part: HitPart; damage: number; point: Vec3; killed: boolean; crit: boolean; shooterId?: string }
  | { kind: 'kill'; enemyId: number; shooterId?: string }
  // The round struck a surface. `normal` points OUT of whatever it hit (the face of
  // a wall or crate, or straight up off the ground) — impact VFX needs it to throw
  // sparks back the right way and to lay a bullet hole flat against the surface.
  | { kind: 'wall'; point: Vec3; normal: Vec3 }
  | { kind: 'miss'; point: Vec3 }
  | { kind: 'fireModeChanged'; mode: FireMode }
  | { kind: 'weaponSwitch'; gunId: GunId; slot: number; name: string }
  | { kind: 'reloadStart'; duration: number }
  | { kind: 'reloadEnd' }
  | { kind: 'spawn'; enemyId: number }
  // ── slice 3: enemies fighting back ──
  | { kind: 'enemyAim'; enemyId: number; from: Vec3 }               // windup tell begins
  // A real round: leaves the MUZZLE, flies along `dir`, and stops at `impact`.
  // `part` is the piece of the player it struck (null = it hit cover or air).
  // `normal` is the face it struck, or null when it struck YOU (or nothing at all).
  | { kind: 'enemyFire'; enemyId: number; from: Vec3; dir: Vec3; impact: Vec3; hit: boolean; part: HitPart | null; normal: Vec3 | null }
  | { kind: 'playerHit'; damage: number; part: HitPart; from: Vec3; fromDir: Vec3; hp: number }
  | { kind: 'playerDown' }
  // A boss crossed a health threshold and escalated (2 = wounded, 3 = enraged).
  | { kind: 'bossPhase'; enemyId: number; phase: number; hpFrac: number }
  | { kind: 'attachment'; id: Attachment; on: boolean };

export type HitPart = 'head' | 'torso' | 'arm' | 'leg';

/**
 * Toggleable operator kit. Two of these change the combat math (owned here so
 * they're testable); the other two are pure sight (owned by the scene, but the
 * on/off state still lives here so the HUD reads one place):
 *   laser — tightens hip-fire · optic — tightens + zooms aimed fire
 *   nvg   — lifts the dark (the Rift) · light — a forward flashlight cone
 */
export type Attachment = 'laser' | 'optic' | 'nvg' | 'light';

export type FireMode = 'semi' | 'burst' | 'auto';
const BURST_COUNT = 3;
/** Raise time when swapping weapons — you can't fire for this long after a swap. */
const SWAP_TIME = 0.35;
/** Which fire modes each weapon offers, first = default. A marksman is not full-auto. */
export const GUN_FIRE_MODES: Record<GunId, FireMode[]> = {
  sidearm: ['semi'],
  smg: ['auto', 'burst'],
  assault_rifle: ['auto', 'burst', 'semi'],
  marksman: ['semi'],
  legendary: ['auto', 'burst'],
  // Seasonal weapons — fire modes chosen to match how each one wants to be used.
  ashfall_carbine: ['auto', 'burst', 'semi'],
  warden_repeater: ['semi', 'burst'],
  rift_lance:      ['semi'],
  seraph_lmg:      ['auto'],
  ember_halo:      ['auto', 'burst', 'semi'],
};

export interface EnemySpec {
  pos: [number, number]; // x, z
  hp?: number;
  room?: number; // which mission room this enemy belongs to (slice 4)
  boss?: boolean; // a named boss — the scene gives it a health bar + menace tint
}

export interface FpsSimOptions {
  gunId?: GunId;
  /** The weapons you carry (1-2). Overrides `gunId`; slot 0 is the primary. */
  loadout?: GunId[];
  /** Attachments fitted at the start of the op (e.g. NVG in the Rift). */
  attachments?: Attachment[];
  /** The player's equipped ammo (B). Modifies every carried gun's stats via
   *  resolveGunStats; incendiary also applies a burn DoT on hit. Default FMJ. */
  ammoId?: AmmoId;
  /** The player's equipped stat attachments (B), one per slot — barrel/optic/
   *  grip/magazine. Applied to every carried gun via resolveGunStats. */
  gunMods?: Partial<Record<AttachmentSlot, AttachmentId>>;
  enemies: EnemySpec[];
  cover?: CoverBox[];
  /** A rescue op's hostage/VIP start point — they wait here until you reach them,
   *  then follow you out. Absent on ordinary ops. */
  hostage?: [number, number];
  /** Injectable RNG for deterministic tests (default Math.random). */
  rng?: () => number;
  /** Sandbox respawns cleared enemies; a mission does not (default true). */
  respawnEnabled?: boolean;
}

/** A rescue op's hostage: a non-combatant who waits, then trails the player out. */
export interface Hostage {
  x: number;
  z: number;
  spawn: [number, number];
  rescued: boolean;
}

// ── Tunables (feel levers — tune these with Marvy against the muted graybox) ──
export const FPS_TUNING = {
  // Hitboxes (standing). A full articulated silhouette — head, torso, both arms
  // and legs are all hittable, so the player can shoot ANY part of the body and
  // it registers, each part with its own damage (see PART_MULT).
  HEAD_RADIUS: 0.15,
  HEAD_Y: 1.62,
  TORSO: { hx: 0.22, y0: 0.92, y1: 1.46, hz: 0.16 },
  LEGS: { hx: 0.2, y0: 0.02, y1: 0.92, hz: 0.15 },
  ARM: { hx: 0.09, y0: 0.96, y1: 1.42, hz: 0.11, dx: 0.3 }, // dx = offset from centre

  // Spread cone (radians). accuracy 1 → BASE only; accuracy 0 → BASE+ACC.
  BASE_SPREAD: 0.02,
  ACC_SPREAD: 0.06,
  ADS_SPREAD_MULT: 0.14, // ADS collapses the cone → precision
  MOVE_SPREAD_MULT: 1.8,
  CROUCH_SPREAD_MULT: 0.7,

  // Lethality. Valor is lethal: a global scale over the catalogue damage, then a
  // per-zone multiplier — a head drops a target fast, limbs chip, torso in
  // between (tuned so ~1 head / ~3 torso / ~4-5 limb shots kill a 100hp target).
  LETHALITY: 2.2,
  PART_MULT: { head: 3.5, torso: 1.0, arm: 0.65, leg: 0.8 },
  FALLOFF_END_MULT: 2.0, // damage fades to FALLOFF_FLOOR by range*this
  FALLOFF_FLOOR: 0.5,

  DEFAULT_ENEMY_HP: 100,
  RESPAWN_DELAY: 2.6,
  MAX_RAY: 120, // metres a bullet travels before it's a clean miss

  PLAYER_HP: 100,

  // Enemies (slice 3). Deliberately FAIR: only MAX_ATTACKERS shoot at once, every
  // shot is telegraphed for AIM_MS first (your reaction window), and a hit grants
  // MERCY_MS of invulnerability so you're never chain-melted.
  ENEMY: {
    EYE_Y: 1.5,
    MAX_ATTACKERS: 3,     // aggression-token budget (the GoW fairness rule) — livelier
    ENGAGE_RANGE: 30,     // won't shoot from further than this
    AIM_MS: 0.6,          // telegraph before the shot — the reaction window
    RECOVER_MS: 0.6,      // ducked cooldown after firing
    HIDE_MS: 0.7,         // min time hidden before peeking again
    // Spread of the FIRST peek after a room is breached. Wider than HIDE_MS on
    // purpose: a room should come alive over a beat or two as defenders react at
    // their own pace, not answer the door as one synchronised volley.
    WAKE_STAGGER: 1.8,
    // Get this close to a defender's post and its whole room turns to face you (see
    // wakeEnteredRoom). The authored campaign leaves a narrow window: it has to be at
    // least 4.3 to cover the middle of the most spread-out room, and under 7.0 or
    // standing in the front room of ash-1 reaches through the divider into the
    // objective room. 5.5 sits in the middle of that with about a metre either side.
    // The campaign-wide sweep in roomWake.test.ts is what holds this honest — it
    // re-derives both bounds from the mission data, so authoring a layout this cannot
    // separate fails there rather than in someone's op.
    ROOM_ENTRY_REACH: 5.5,
    // ── Breaking contact ──
    // How long an enemy keeps hunting the last place it saw you before it gives up
    // and goes back to holding its post. Long enough that ducking behind a crate
    // mid-firefight does not just switch them off — they come and look, and looking
    // is what pushes you to keep moving instead of sitting in one hole.
    SEARCH_SECS: 6,
    // Scatter around that last-known point while searching, so a squad that lost you
    // fans out over the spot rather than stacking on one coordinate.
    SEARCH_SPREAD: 2.6,
    BASE_ACC: 0.45,       // point-blank hit chance
    NEAR: 6, FAR: 26,     // accuracy falls off linearly across this range
    DMG: 10,              // damage per hit
    MERCY_MS: 0.6,        // post-hit invulnerability
    MOVE_SPEED: 2.8,      // m/s when maneuvering
    BODY_R: 0.55,         // shoulders + rifle: keep them clear of walls, not touching
    WORLD_CLAMP: 18,      // outer safety; walls do the real containment (layouts vary in depth)
    PREFERRED_DIST: 12,   // enemies maneuver to about this range and flank
    // The round leaves the rifle they're actually holding, not their sternum.
    MUZZLE_Y: 1.42,
    MUZZLE_FWD: 0.42,
    MUZZLE_RIGHT: 0.13,
    SPREAD_NEAR: 0.03,    // rad; the cone opens with range, so distance = safety
    SPREAD_FAR: 0.09,
  },

  // Attachment effects on the spread cone. Laser helps when firing from the hip;
  // the optic helps when aimed. Both make you tighter, never looser.
  ATTACH: {
    LASER_HIP_MULT: 0.55, // hip-fire cone with a laser (at full ADS: no effect)
    OPTIC_ADS_MULT: 0.68, // aimed cone with an optic (at the hip: no effect)
  },

  // A named boss is not a tougher mook — it escalates. As its health falls
  // through PHASE_AT, it enters phase 2 then 3: telegraph shrinks, rounds land
  // tighter, it closes the distance and moves faster. It also acts OUTSIDE the
  // MAX_ATTACKERS token budget, so it is always a threat while its guards trade
  // turns around it. Index by phase-1 (phase 1 = [0]).
  BOSS: {
    PHASE_AT: [0.66, 0.33] as const, // hp fractions where phase 2 / phase 3 begin
    AIM_MS: [0.5, 0.4, 0.28],        // reaction window you get shrinks each phase
    RECOVER_MS: [0.6, 0.45, 0.3],    // it fires more often
    SPREAD_MULT: [0.9, 0.72, 0.55],  // and lands tighter
    PREFERRED_DIST: [14, 10, 6],     // it stops keeping its distance
    MOVE_MULT: [1.1, 1.25, 1.45],    // and moves faster while doing it
  },

  /** Your body, as the enemies' bullets see it. Heights are relative to eye level. */
  PLAYER_HIT: {
    HEAD_R: 0.15,
    TORSO: { h: 0.22, y0: -0.7, y1: -0.14 },
    LEGS: { h: 0.2, yTop: -0.7 },
    PART_MULT: { head: 2.2, torso: 1.0, arm: 0.6, leg: 0.6 },
  },
} as const;

const UP: Vec3 = [0, 1, 0];

/** How long an incendiary hit keeps an enemy burning (B) — matches the shop copy. */
const INCENDIARY_BURN_SECS = 2;

export class FpsSim {
  // The active weapon. Reassigned on a weapon switch (loadout support).
  gun: GunStats;
  /** The 1-2 weapons you carry; slot 0 = primary. */
  readonly loadout: GunId[];
  activeSlot = 0;
  /** Ammo is tracked PER slot, so swapping never refills the other weapon. */
  private ammoBySlot: number[];
  /** Currently-fitted attachments (the operator's kit, toggled in-mission). */
  readonly attachments = new Set<Attachment>();
  /** The player's equipped ammo (B) — resolves gun stats + drives incendiary burn. */
  readonly ammoId: AmmoId;
  /** The player's equipped stat attachments (B) — resolves gun stats per slot. */
  private readonly gunMods: Partial<Record<AttachmentSlot, AttachmentId>>;
  private enemies: FpsEnemy[] = [];
  private spawns: [number, number][] = [];
  private cover: CoverBox[];
  /** Outer safety box for enemy movement. Walls do the real containment; this only
   *  stops a confused seeker wandering off the map. It defaults to a fixed box around
   *  the ORIGIN, which every authored mission sits inside — but the endless chain runs
   *  hundreds of metres out, and an enemy clamped back to the origin box teleports into
   *  the geometry near the start of the chain and shoots the player from inside a wall.
   *  Endless replaces these bounds with the live chain window as it travels. */
  private bounds: { minX: number; maxX: number; minZ: number; maxZ: number } = {
    minX: -FPS_TUNING.ENEMY.WORLD_CLAMP, maxX: FPS_TUNING.ENEMY.WORLD_CLAMP,
    minZ: -FPS_TUNING.ENEMY.WORLD_CLAMP, maxZ: FPS_TUNING.ENEMY.WORLD_CLAMP,
  };
  private rng: () => number;
  private respawnEnabled: boolean;
  /** The rescue objective's hostage, or null on ordinary ops. */
  hostage: Hostage | null = null;
  /** The player's ground position, cached each step (hostage-follow, defend proximity). */
  private playerX = 0;
  private playerZ = 0;

  time = 0;
  reloading = false;
  private reloadEndsAt = 0;
  private nextShotAt = 0;
  private prevFiring = false;   // trigger edge detection (semi/burst)
  private burstLeft = 0;
  fireMode: FireMode = 'auto';

  // Session stats (probe + later the XP loop reads these).
  shotsFired = 0;
  hits = 0;
  headshots = 0;
  kills = 0;
  enemyShots = 0; // rounds fired AT the player (diagnostics + feel tuning)
  /** Which part of the player the last enemy round struck (diagnostics + HUD). */
  lastHitPart: HitPart | null = null;
  hitParts: Record<HitPart, number> = { head: 0, torso: 0, arm: 0, leg: 0 };

  private events: FpsEvent[] = [];
  private nextId = 1;

  // Player survival (slice 3).
  playerHp: number = FPS_TUNING.PLAYER_HP;
  private playerEyeY = 1.6;
  playerAlive = true;
  private mercyUntil = 0;
  /** Co-op Endless only (see `setCombatant`) — teammates as additional live
   *  AI targets, keyed by wallet. Empty in every other mode, which is what
   *  makes `allTargets`/`pickTarget` resolve back to `LOCAL_TARGET` unconditionally
   *  when co-op isn't active. */
  private combatants: Map<string, Combatant> = new Map();
  /** Per-combatant mercy window, mirroring `mercyUntil` but keyed — a burst
   *  landing on one teammate must not grant another a free window. */
  private combatantMercyUntil: Map<string, number> = new Map();
  /** Where the player actually is, refreshed every step. Only the sim's own
   *  bookkeeping may read this — an ENEMY must go through its own `seen` position,
   *  or it is omniscient again. */
  private playerPos: Vec3 = [0, 1.6, 0];

  /** Rounds in the ACTIVE weapon's magazine (transparently the current slot). */
  get ammo(): number { return this.ammoBySlot[this.activeSlot]; }
  set ammo(v: number) { this.ammoBySlot[this.activeSlot] = v; }

  constructor(opts: FpsSimOptions) {
    // A loadout of 1-2 guns; a bare `gunId` is treated as a single-weapon loadout.
    const loadout = (opts.loadout && opts.loadout.length ? opts.loadout : [opts.gunId ?? 'sidearm']).slice(0, 2);
    this.loadout = loadout;
    // The equipped ammo + attachments (B) must be set BEFORE any resolveGun call,
    // since resolveGun folds them into every carried gun's stats.
    this.ammoId = opts.ammoId ?? 'standard';
    this.gunMods = opts.gunMods ?? {};
    this.ammoBySlot = loadout.map((id) => this.resolveGun(id).magazine);
    this.gun = this.resolveGun(loadout[0]);
    this.fireMode = (GUN_FIRE_MODES[this.gun.id] ?? ['auto'])[0];
    for (const a of opts.attachments ?? []) this.attachments.add(a);
    this.cover = opts.cover ?? [];
    this.rng = opts.rng ?? Math.random;
    this.respawnEnabled = opts.respawnEnabled ?? true;
    if (opts.hostage) this.hostage = { x: opts.hostage[0], z: opts.hostage[1], spawn: [opts.hostage[0], opts.hostage[1]], rescued: false };
    for (const e of opts.enemies) this.addEnemy(e);
  }

  /** Mark the hostage reached — from now on they trail the player to extract. */
  rescueHostage(): void {
    if (this.hostage) this.hostage.rescued = true;
  }

  /** Defend/hold pressure: revive up to `count` DEAD enemies of `room` at their
   *  spawns and wake them, so a held point keeps getting tested. Returns how many. */
  reinforce(room: number, count: number, hpMult = 1): number {
    let n = 0;
    for (let i = 0; i < this.enemies.length && n < count; i++) {
      const e = this.enemies[i];
      if (e.alive || e.room !== room) continue;
      const [sx, sz] = this.spawns[i];
      e.x = sx; e.z = sz;
      e.maxHp = Math.max(1, Math.round((e.boss ? e.maxHp : FPS_TUNING.DEFAULT_ENEMY_HP) * hpMult));
      e.hp = e.maxHp;
      e.alive = true; e.deadAt = 0; e.active = true; e.token = false;
      e.burnUntil = 0; e.burnDps = 0;
      e.ai = 'hidden'; e.phase = e.boss ? 1 : 0;
      e.goalX = sx; e.goalZ = sz; e.nextGoalAt = 0;
      e.aiUntil = this.time + this.rng() * FPS_TUNING.ENEMY.HIDE_MS;
      e.targetId = LOCAL_TARGET;
      this.events.push({ kind: 'spawn', enemyId: e.id });
      n++;
    }
    return n;
  }

  private addEnemy(spec: EnemySpec): FpsEnemy {
    const hp = spec.hp ?? FPS_TUNING.DEFAULT_ENEMY_HP;
    // A spawn point authored a touch inside a wall would otherwise leave the enemy
    // half-buried and reading as "coming out of the wall". Eject it to a clear spot.
    const [sx, sz] = this.pushOutOfCover(spec.pos[0], spec.pos[1]);
    const e: FpsEnemy = {
      id: this.nextId++,
      x: sx,
      z: sz,
      hp,
      maxHp: hp,
      alive: true,
      deadAt: 0,
      ai: 'hidden',
      aiUntil: 0,
      facing: 0,
      token: false,
      ducking: 1,
      goalX: sx,
      goalZ: sz,
      nextGoalAt: 0,
      room: spec.room ?? 0,
      active: true,
      seenX: sx,
      seenZ: sz,
      seenAt: 0,   // no contact yet: it holds its post and watches its arc
      boss: spec.boss ?? false,
      phase: spec.boss ? 1 : 0,
      burnUntil: 0,
      burnDps: 0,
      targetId: LOCAL_TARGET,
    };
    this.enemies.push(e);
    // Store the CLEARED spawn so reinforce/respawn also come back out of geometry.
    this.spawns.push([sx, sz]);
    return e;
  }

  getEnemies(): readonly FpsEnemy[] {
    return this.enemies;
  }
  getCover(): readonly CoverBox[] {
    return this.cover;
  }
  aliveCount(): number {
    let n = 0;
    for (const e of this.enemies) if (e.alive) n++;
    return n;
  }
  /** Living enemies in a mission room (slice 4). */
  roomAlive(room: number): number {
    let n = 0;
    for (const e of this.enemies) if (e.alive && e.room === room) n++;
    return n;
  }
  /** Wake or sleep a room's enemies (the player breaching triggers this).
   *
   *  Waking STAGGERS each enemy's next peek. Without it every defender in the room
   *  clears the `time >= aiUntil` gate on the same frame — they were all spawned with
   *  aiUntil 0 — so they take aggression tokens together, telegraph together and fire
   *  in one volley, then stay in lockstep because their timers are identical. Spreading
   *  the first peek makes them trade turns instead, which is what the token budget was
   *  always meant to produce. (startWave, reinforce and resetEncounter already do this;
   *  this was the one wake path that didn't.) It can only ever DELAY a first shot, never
   *  bring one forward. */
  setRoomActive(room: number, active: boolean): void {
    for (const e of this.enemies) {
      if (e.room !== room) continue;
      if (active && !e.active) {
        e.aiUntil = this.time + this.rng() * FPS_TUNING.ENEMY.WAKE_STAGGER;
        this.markContact(e);
      }
      e.active = active;
    }
  }

  /**
   * Hand an enemy the player's CURRENT position as its last-known contact.
   *
   * Used when a room wakes or a defender is reinforced in, because something just
   * told them you are here — a door going in, a body hitting the floor, the noise of
   * the room next door. Without it they would come online with no idea where you are
   * and stand at their posts while you shot them, which is the same statue problem
   * from the other direction. Note this is a SNAPSHOT: move after it and they are
   * hunting a stale position, which is exactly the point.
   */
  private markContact(e: FpsEnemy): void {
    e.seenX = this.playerPos[0];
    e.seenZ = this.playerPos[2];
    e.seenAt = this.time;
  }
  setAllActive(active: boolean): void {
    for (const e of this.enemies) e.active = active;
  }

  /**
   * Wake whichever room the player is standing in.
   *
   * Dormancy is paced by the OBJECTIVE flow — breach wakes room 1, pushing to the
   * objective wakes room 2 — and that flow is a cursor that only advances when the
   * objective before it completes. So the wake for room 2 sat behind "clear room 1",
   * and you could walk past a live front room into the middle of five defenders who
   * would all keep facing the wall until you had killed everyone behind you. That is
   * not pacing, it is a room full of statues. Entering wakes a room now, whatever the
   * objective cursor thinks.
   *
   * "Inside a room" is derived from where its defenders were POSTED: get within
   * ROOM_ENTRY_REACH of any one post and that whole room turns to face you. Nothing
   * in the mission data describes room bounds, and inferring them from the walls
   * would mean guessing which of a dozen boxes is the divider — but a room IS its
   * defenders, and their posts trace its shape for free.
   *
   * A union of small discs, not one big circle around the room's centre. Several
   * authored rooms are long and thin (a hall, a cell row), and a circle wide enough
   * to cover one of those from its centroid also swallows the room next door — three
   * ops broke exactly that way. Hugging each post separately follows the shape
   * instead of bounding it.
   *
   * Read off `spawns`, not live positions, for a subtler reason: an awake room
   * maneuvers toward the player, so its enemies would drag their trigger discs along
   * behind you into the next room, and that room would never register as the one you
   * had walked into.
   *
   * Every room in reach wakes, not just the nearest: standing in a doorway is
   * standing in both, and the room you are stepping into is the one that most needs
   * to have noticed.
   *
   * This can only ever wake a room EARLIER than the objective flow would have, and
   * nothing here puts a room back to sleep — so pushing on through leaves the fight
   * behind you switched on, which is the point.
   */
  private wakeEnteredRoom(input: FpsInput): void {
    if (!this.playerAlive) return;
    // Most of a mission is spent with everything already awake. Bail before the scan
    // rather than testing every post every frame for nothing.
    let dormant = false;
    for (const e of this.enemies) if (e.alive && !e.active) { dormant = true; break; }
    if (!dormant) return;

    const px = input.origin[0], pz = input.origin[2];
    const reach2 = FPS_TUNING.ENEMY.ROOM_ENTRY_REACH ** 2;

    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (!e.alive || e.active) continue;
      const dx = px - this.spawns[i][0], dz = pz - this.spawns[i][1];
      if (dx * dx + dz * dz <= reach2) this.setRoomActive(e.room, true);
    }
  }
  /** The attack breaks: the living attackers from a room fall back and clear off the
   *  field. Used when a defend hold is survived so the extract is a walk-out, not a
   *  second gunfight against everything that piled up during the hold. */
  breakAttack(room: number): void {
    for (const e of this.enemies) {
      if (e.room === room && e.alive) {
        e.alive = false; e.hp = 0; e.deadAt = -999; e.active = false;
        e.token = false; e.ai = 'hidden';
      }
    }
  }

  /** Current effective spread half-angle (radians) for the given input. */
  spreadFor(adsFactor: number, moving: boolean, crouched: boolean): number {
    const ads = clamp01(adsFactor);
    let s = FPS_TUNING.BASE_SPREAD + FPS_TUNING.ACC_SPREAD * (1 - this.gun.accuracy);
    s *= lerp(1, FPS_TUNING.ADS_SPREAD_MULT, ads);
    if (moving) s *= FPS_TUNING.MOVE_SPREAD_MULT;
    if (crouched) s *= FPS_TUNING.CROUCH_SPREAD_MULT;
    // Attachments only ever tighten: the laser at the hip, the optic when aimed.
    if (this.attachments.has('laser')) s *= lerp(FPS_TUNING.ATTACH.LASER_HIP_MULT, 1, ads);
    if (this.attachments.has('optic')) s *= lerp(1, FPS_TUNING.ATTACH.OPTIC_ADS_MULT, ads);
    return s;
  }

  /** Flip an attachment on/off. Returns its new state (true = now on). */
  toggleAttachment(a: Attachment): boolean {
    const on = !this.attachments.has(a);
    if (on) this.attachments.add(a); else this.attachments.delete(a);
    this.events.push({ kind: 'attachment', id: a, on });
    return on;
  }
  hasAttachment(a: Attachment): boolean { return this.attachments.has(a); }

  /** A carried gun's stats with the player's equipped ammo + attachments folded in
   *  (B). Every place that used to read raw getGun() goes through here so the whole
   *  sim — cadence, spread, damage, reload, magazine — reflects the loadout. */
  private resolveGun(id: GunId): GunStats {
    return resolveGunStats(getGun(id), this.ammoId, this.gunMods);
  }

  /** Cycle to this weapon's next fire mode. Single-mode guns don't change. */
  cycleFireMode(): FireMode {
    const modes = GUN_FIRE_MODES[this.gun.id] ?? ['auto'];
    const i = modes.indexOf(this.fireMode);
    this.fireMode = modes[(i + 1) % modes.length];
    this.burstLeft = 0;
    return this.fireMode;
  }

  /** Swap to loadout slot `n`. Cancels a reload, imposes a raise time, and each
   *  weapon keeps its own ammo. Returns true if the weapon actually changed. */
  switchGun(n: number): boolean {
    if (n < 0 || n >= this.loadout.length || n === this.activeSlot) return false;
    this.activeSlot = n;                 // the ammo getter now points at this slot
    this.gun = this.resolveGun(this.loadout[n]);
    this.fireMode = (GUN_FIRE_MODES[this.gun.id] ?? ['auto'])[0];
    this.reloading = false;
    this.burstLeft = 0;
    this.nextShotAt = this.time + SWAP_TIME; // raise time: no firing mid-swap
    this.events.push({ kind: 'weaponSwitch', gunId: this.gun.id, slot: n, name: this.gun.name });
    return true;
  }

  /** Cycle to the next weapon in the loadout (the swap key). */
  nextWeapon(): boolean {
    if (this.loadout.length < 2) return false;
    return this.switchGun((this.activeSlot + 1) % this.loadout.length);
  }

  startReload(): void {
    if (this.reloading || this.ammo >= this.gun.magazine) return;
    this.reloading = true;
    this.reloadEndsAt = this.time + this.gun.reloadTime;
    this.events.push({ kind: 'reloadStart', duration: this.gun.reloadTime });
  }

  /** Advance one step. Returns the events produced this step (also drained via drain()). */
  step(dt: number, input: FpsInput): FpsEvent[] {
    const produced: FpsEvent[] = [];
    this.time += dt;

    // Reload completion.
    if (this.reloading && this.time >= this.reloadEndsAt) {
      this.reloading = false;
      this.ammo = this.gun.magazine;
    this.fireMode = (GUN_FIRE_MODES[this.gun.id] ?? ['auto'])[0];
      this.push(produced, { kind: 'reloadEnd' });
    }
    if (input.wantReload) this.startReload();

    // Respawns (sandbox only — a mission leaves cleared enemies down).
    for (const e of this.enemies) {
      if (this.respawnEnabled && !e.alive && this.time - e.deadAt >= FPS_TUNING.RESPAWN_DELAY) {
        e.alive = true;
        e.hp = e.maxHp;
        e.phase = e.boss ? 1 : 0;
        e.token = false;
        e.burnUntil = 0; e.burnDps = 0;
        e.ai = 'hidden';
        e.aiUntil = this.time + this.rng() * FPS_TUNING.ENEMY.HIDE_MS;
        this.push(produced, { kind: 'spawn', enemyId: e.id });
      }
    }

    // Incendiary burn (B): tick the thermite DoT on any burning enemy. It runs
    // independently of the enemy AI so it lands even while they're ducked, and a
    // burn can score the kill after you've moved on.
    for (const e of this.enemies) {
      if (!e.alive || e.burnDps <= 0 || this.time >= e.burnUntil) continue;
      e.hp -= e.burnDps * dt;
      if (e.hp <= 0) {
        e.hp = 0;
        e.alive = false;
        e.deadAt = this.time;
        this.kills++;
        this.push(produced, { kind: 'kill', enemyId: e.id });
      }
    }

    this.playerX = input.origin[0];
    this.playerZ = input.origin[2];

    // Enemies think, take cover, telegraph and shoot back (slice 3).
    this.updateEnemies(dt, input, produced);

    // A rescued hostage trails a step behind the player toward extract.
    if (this.hostage && this.hostage.rescued) {
      const h = this.hostage;
      const dx = this.playerX - h.x, dz = this.playerZ - h.z;
      const d = Math.hypot(dx, dz);
      const FOLLOW_GAP = 2.0, SPEED = 3.2;
      if (d > FOLLOW_GAP) {
        const step = Math.min(d - FOLLOW_GAP, SPEED * dt);
        h.x += (dx / d) * step;
        h.z += (dz / d) * step;
      }
    }

    this.playerEyeY = input.crouched ? 1.02 : 1.6;
    this.playerPos[0] = input.origin[0];
    this.playerPos[1] = input.origin[1];
    this.playerPos[2] = input.origin[2];

    // Firing — fire mode decides what a held trigger means.
    const rising = input.firing && !this.prevFiring;            // this frame's trigger PULL
    if (this.fireMode === 'burst' && rising && this.burstLeft <= 0) this.burstLeft = BURST_COUNT;
    const wantShoot =
      this.fireMode === 'auto' ? input.firing :                 // spray while held
      this.fireMode === 'semi' ? rising :                       // one per pull
      this.burstLeft > 0;                                       // burst: fire out the queue
    this.prevFiring = input.firing;

    if (wantShoot && !this.reloading && this.time >= this.nextShotAt) {
      this.nextShotAt = this.time + 60 / this.gun.fireRate;
      if (this.ammo <= 0) {
        this.burstLeft = 0;
        this.push(produced, { kind: 'empty' });
        this.startReload(); // pulling the trigger dry kicks off a reload
      } else {
        this.ammo--;
        this.shotsFired++;
        if (this.burstLeft > 0) this.burstLeft--;
        const spread = this.spreadFor(input.adsFactor, input.moving, input.crouched);
        this.push(produced, { kind: 'fire', ammo: this.ammo, spread });
        this.resolveShot(input.origin, input.dir, spread, produced);
        if (this.ammo <= 0) { this.burstLeft = 0; this.startReload(); } // auto-reload on dry
      }
    }

    return produced;
  }

  /**
   * Record an event. It must go BOTH into the caller's array (step()'s return)
   * AND into `this.events`, because the scene reads events via drain(), not via
   * step()'s return value. Pushing to `local` alone silently drops the event —
   * that is exactly how enemy fire ended up with no tracer, no sound and no hit
   * reaction for several slices. ALWAYS use this, never a bare `out.push`.
   */
  private push(local: FpsEvent[], ev: FpsEvent): void {
    local.push(ev);
    this.events.push(ev);
  }

  /** Local player's own shot — the only caller in every mode but co-op.
   *  Increments personal session stats (hits/headshots/kills); a
   *  teammate's shot in co-op goes through `resolveRemoteShot` instead,
   *  which shares this same raycast/damage core but never touches these. */
  private resolveShot(origin: Vec3, dir: Vec3, spread: number, out: FpsEvent[]): void {
    const r = this.traceAndApply(origin, dir, spread, out);
    if (r.hit) {
      this.hits++;
      if (r.headshot) this.headshots++;
      if (r.killed) this.kills++;
    }
  }

  /** A teammate's shot, co-op Endless only (see `ValorScene`'s `coop`
   *  prop) — reuses the exact same raycast/damage resolution
   *  `resolveShot` uses for the local player (cover, ground, enemy
   *  hitboxes, crit roll, burn DoT), tagging the resulting `hit`/`kill`
   *  events with `shooterId` so the host's own scene can tell whose gun
   *  did it. Deliberately does NOT touch `hits`/`headshots`/`kills` —
   *  those are the local player's own session stats, and a teammate's
   *  kill isn't yours. No ammo/fire-rate gate here either: the trust
   *  model for an unstaked co-op mode is "the host believes what a
   *  teammate's client says it fired," the same leniency
   *  `arena_server.rs`'s module doc explicitly contrasts against for
   *  Face-Off's STAKED case. Not called from within `step()`, so there's
   *  no per-frame `produced` array to also populate — events land in
   *  `this.events` via `push`, same as every other path; `drain()` is
   *  what the scene actually reads regardless. */
  resolveRemoteShot(shooterId: string, origin: Vec3, dir: Vec3, spread: number): void {
    this.traceAndApply(origin, dir, spread, [], shooterId);
  }

  /** One bullet: jitter the ray within the cone, find the nearest thing it
   *  hits. Shared by `resolveShot` (local) and `resolveRemoteShot` (a
   *  teammate's, co-op only) — never touches personal session stats, see
   *  both callers above for why. */
  private traceAndApply(origin: Vec3, dir: Vec3, spread: number, out: FpsEvent[], shooterId?: string): { hit: boolean; headshot: boolean; killed: boolean } {
    const ray = jitter(normalize(dir), spread, this.rng);

    let bestT: number = FPS_TUNING.MAX_RAY;
    let hitEnemy: FpsEnemy | null = null;
    let hitPart: HitPart = 'torso';
    // What the round struck, so the impact can be given a surface normal.
    let hitBox: [Vec3, Vec3] | null = null;
    let hitGround = false;

    // Cover first — a crate closer than an enemy eats the round.
    for (const c of this.cover) {
      const box = aabbOfCover(c);
      const t = rayAABB(origin, ray, box);
      if (t !== null && t < bestT) {
        bestT = t;
        hitEnemy = null;
        hitBox = box;
        hitGround = false;
      }
    }

    // The ground is a surface too. Without it, a round aimed at someone's feet
    // reported a `miss` and sparked 60m away in mid-air instead of kicking up dirt
    // where it actually landed.
    const tg = rayGround(origin, ray);
    if (tg !== null && tg < bestT) {
      bestT = tg;
      hitEnemy = null;
      hitBox = null;
      hitGround = true;
    }

    for (const e of this.enemies) {
      if (!e.alive) continue;
      const th = raySphere(origin, ray, [e.x, FPS_TUNING.HEAD_Y, e.z], FPS_TUNING.HEAD_RADIUS);
      if (th !== null && th < bestT) {
        bestT = th;
        hitEnemy = e;
        hitPart = 'head';
        hitBox = null;
        hitGround = false;
      }
      for (const zone of bodyZones(e)) {
        const t = rayAABB(origin, ray, [zone.min, zone.max]);
        if (t !== null && t < bestT) {
          bestT = t;
          hitEnemy = e;
          hitPart = zone.part;
          hitBox = null;
          hitGround = false;
        }
      }
    }

    const point: Vec3 = [origin[0] + ray[0] * bestT, origin[1] + ray[1] * bestT, origin[2] + ray[2] * bestT];

    if (hitEnemy) {
      // Crit roll: the gun's critChance (already folded with the equipped ammo's
      // critChanceMod by resolveGun — armor piercing bumps it) for a critMult
      // burst of damage. This is what the marketplace's CRIT stat has always
      // promised; now it lands.
      const crit = this.rng() < this.gun.critChance;
      const dmg = this.damageFor(hitPart, bestT) * (crit ? this.gun.critMult : 1);
      hitEnemy.hp -= dmg;
      const killed = hitEnemy.hp <= 0;
      if (killed) {
        hitEnemy.alive = false;
        hitEnemy.hp = 0;
        hitEnemy.deadAt = this.time;
      } else {
        // Incendiary (B): each hit refreshes a thermite burn that keeps ticking
        // after you stop firing, and can finish a wounded target on its own.
        const burn = AMMO_CATALOG[this.ammoId].burnDps;
        if (burn > 0) {
          hitEnemy.burnUntil = this.time + INCENDIARY_BURN_SECS;
          hitEnemy.burnDps = burn;
        }
      }
      this.push(out, { kind: 'hit', enemyId: hitEnemy.id, part: hitPart, damage: dmg, point, killed, crit, shooterId });
      if (killed) this.push(out, { kind: 'kill', enemyId: hitEnemy.id, shooterId });
      return { hit: true, headshot: hitPart === 'head', killed };
    } else if (bestT < FPS_TUNING.MAX_RAY) {
      const normal: Vec3 = hitGround ? UP : hitBox ? aabbFaceNormal(point, hitBox) : negate(ray);
      this.push(out, { kind: 'wall', point, normal });
      return { hit: false, headshot: false, killed: false };
    } else {
      this.push(out, { kind: 'miss', point });
      return { hit: false, headshot: false, killed: false };
    }
  }

  private damageFor(part: HitPart, dist: number): number {
    let dmg = this.gun.damage * FPS_TUNING.LETHALITY * FPS_TUNING.PART_MULT[part];
    // Range falloff: full within `range`, fading to FLOOR by range*FALLOFF_END_MULT.
    const near = this.gun.range;
    const far = this.gun.range * FPS_TUNING.FALLOFF_END_MULT;
    if (dist > near) {
      const t = clamp01((dist - near) / Math.max(0.001, far - near));
      dmg *= lerp(1, FPS_TUNING.FALLOFF_FLOOR, t);
    }
    return dmg;
  }

  /** Every live target an enemy could possibly engage this frame — the
   *  local player plus every registered co-op combatant. Computed once per
   *  `updateEnemies` call, not per-enemy. In every mode but co-op,
   *  `this.combatants` is empty and this returns a single-element array,
   *  which is what makes `pickTarget` resolve back to `LOCAL_TARGET`
   *  unconditionally when co-op isn't active. */
  private allTargets(input: FpsInput): Array<{ id: string; x: number; z: number; eyeY: number; alive: boolean }> {
    // `input.origin[1]` here, NOT `this.playerEyeY` — `updateEnemies` runs
    // before `this.playerEyeY` is refreshed for this frame (see `step()`),
    // so it would still be reading last frame's crouch state. The caller's
    // own `input.origin` is already correct for THIS frame, which is
    // exactly what the local-only code this replaced used to read.
    const list = [{ id: LOCAL_TARGET, x: input.origin[0], z: input.origin[2], eyeY: input.origin[1], alive: this.playerAlive }];
    for (const [id, c] of this.combatants) list.push({ id, x: c.x, z: c.z, eyeY: c.eyeY, alive: c.alive });
    return list;
  }

  /** Sticky target selection: an enemy keeps engaging whoever it's already
   *  engaging as long as it can still see them. It only re-picks — nearest
   *  ALIVE target it currently has line of sight to — when the current
   *  target dies or drops out of sight. If nobody at all is visible this
   *  frame, the enemy simply keeps its last-known target id (its stale
   *  `seenX`/`seenZ` still drive the existing hunt-then-give-up behavior
   *  unchanged), unless that target is now confirmed dead, in which case it
   *  falls back to whichever target is still alive (or the local player as
   *  a harmless default — nobody will actually be there if they're dead
   *  too, so LOS simply stays false). */
  private pickTarget(e: FpsEnemy, targets: ReturnType<typeof this.allTargets>): void {
    const current = targets.find((t) => t.id === e.targetId);
    if (current?.alive && this.hasLOS(e, [current.x, current.eyeY, current.z])) return;

    let best: (typeof targets)[number] | null = null;
    let bestDist = Infinity;
    for (const t of targets) {
      if (!t.alive || !this.hasLOS(e, [t.x, t.eyeY, t.z])) continue;
      const d = Math.hypot(t.x - e.x, t.z - e.z);
      if (d < bestDist) { bestDist = d; best = t; }
    }
    if (best) { e.targetId = best.id; return; }
    if (!current?.alive) e.targetId = targets.find((t) => t.alive)?.id ?? LOCAL_TARGET;
  }

  // ── Enemy AI (slice 3): hide → peek → telegraph → fire → recover, fairly ──
  private updateEnemies(dt: number, input: FpsInput, out: FpsEvent[]): void {
    const E = FPS_TUNING.ENEMY;
    const B = FPS_TUNING.BOSS;
    const targets = this.allTargets(input);

    // Before anyone thinks: is the player standing in a room that hasn't noticed?
    this.wakeEnteredRoom(input);

    // Bosses fight outside the fairness budget, so only mooks spend tokens.
    let tokens = 0;
    for (const e of this.enemies) if (e.alive && e.token && !e.boss) tokens++;

    // Indexed, because an enemy that has given up falls back to its POST, and the
    // post lives in the index-aligned `spawns` array.
    for (let ei = 0; ei < this.enemies.length; ei++) {
      const e = this.enemies[ei];
      if (!e.alive) { e.token = false; continue; }
      if (!e.active) { // dormant until the player breaches this room
        e.ducking += (1 - e.ducking) * Math.min(1, dt * 6);
        e.ai = 'hidden';
        e.token = false;
        continue;
      }
      // First live frame for an enemy that has never had contact: it knows where you
      // are. Every wake path funnels through here — `setRoomActive`, reinforcements,
      // survival waves spawned already-active, `setAllActive(true)` — so none of them
      // can come online believing you are nowhere. Without it, `hunting` would be
      // false from birth and a whole survival wave would spawn, decide it had lost
      // you, and walk back to its own spawn points. `markContact` always assumes
      // contact with the LOCAL player specifically — room-wake is always triggered
      // by the local client's own position (see `ValorScene`'s coop host path), so
      // that's the correct first guess; `pickTarget` below re-evaluates for real
      // the very same frame regardless.
      if (e.seenAt === 0) this.markContact(e);

      // A boss escalates as it bleeds — announce each new phase once.
      if (e.boss) {
        const frac = e.hp / e.maxHp;
        const want = frac <= B.PHASE_AT[1] ? 3 : frac <= B.PHASE_AT[0] ? 2 : 1;
        if (want > e.phase) {
          e.phase = want;
          this.push(out, { kind: 'bossPhase', enemyId: e.id, phase: want, hpFrac: frac });
        }
      }
      const ph = e.boss ? e.phase - 1 : 0; // phase index into the BOSS tables

      this.pickTarget(e, targets);
      const tgt = targets.find((t) => t.id === e.targetId)!;
      const tx = tgt.x, tz = tgt.z;

      const los = tgt.alive && this.hasLOS(e, [tx, tgt.eyeY, tz]);
      if (los) { e.seenX = tx; e.seenZ = tz; e.seenAt = this.time; }

      // What this enemy BELIEVES. With eyes on its target that is the truth; without,
      // it is the last place it saw them, and it goes stale. Everything below reads
      // these and not tx/tz — an enemy that reads the real position while it cannot
      // see its target is an enemy you cannot hide from, which is what this used to
      // be: it faced you through walls and walked straight to you with its eyes shut.
      const hunting = e.seenAt > 0 && this.time - e.seenAt < E.SEARCH_SECS;

      // Watch where you believe he is. Having given up, that means watching the last
      // place you saw him from your post, which reads as a guard back on his arc.
      e.facing = Math.atan2(e.seenX - e.x, e.seenZ - e.z);
      const dist = Math.hypot(tx - e.x, tz - e.z);

      // stand to shoot, duck otherwise
      const duckTarget = e.ai === 'aim' || e.ai === 'fire' ? 0 : 1;
      e.ducking += (duckTarget - e.ducking) * Math.min(1, dt * 6);

      if (e.token) {
        if (!los) {
          e.token = false; if (!e.boss) tokens--; e.ai = 'hidden'; e.aiUntil = this.time + E.HIDE_MS;
        } else if (e.ai === 'aim' && this.time >= e.aiUntil) {
          e.ai = 'fire';
          this.enemyFire(e, input, out, e.boss ? B.SPREAD_MULT[ph] : 1);
          e.aiUntil = this.time + (e.boss ? B.RECOVER_MS[ph] : E.RECOVER_MS);
        } else if (e.ai === 'fire') {
          e.ai = 'recover';
        } else if (e.ai === 'recover' && this.time >= e.aiUntil) {
          e.token = false; if (!e.boss) tokens--; e.ai = 'hidden'; e.aiUntil = this.time + E.HIDE_MS;
        }
        continue;
      }

      // No token: MANEUVER. Three different jobs depending on what it knows.
      if (this.time >= e.nextGoalAt) {
        // Resample until the goal is somewhere a body can actually stand.
        if (los) {
          // EYES ON — the fight. Hold a preferred combat distance with a strafe
          // offset, so they close in and flank instead of standing still and bobbing.
          const preferred = e.boss ? B.PREFERRED_DIST[ph] : E.PREFERRED_DIST;
          for (let tries = 0; tries < 6; tries++) {
            const bearing = Math.atan2(e.x - tx, e.z - tz) + (this.rng() - 0.5) * 1.4; // current side ± strafe
            const d = preferred + (this.rng() - 0.5) * 5;
            e.goalX = tx + Math.sin(bearing) * d;
            e.goalZ = tz + Math.cos(bearing) * d;
            if (!this.inCover(e.goalX, e.goalZ)) break;
          }
          e.nextGoalAt = this.time + 1.4 + this.rng() * 2;
        } else if (hunting) {
          // LOST HIM — go and look. Straight at the last known position rather than
          // holding off at combat range: standing back from a spot you cannot see
          // into is not searching it. The scatter keeps a squad from stacking on one
          // coordinate, and re-picking often makes them sweep rather than park.
          for (let tries = 0; tries < 6; tries++) {
            const a = this.rng() * Math.PI * 2;
            const r = this.rng() * E.SEARCH_SPREAD;
            e.goalX = e.seenX + Math.sin(a) * r;
            e.goalZ = e.seenZ + Math.cos(a) * r;
            if (!this.inCover(e.goalX, e.goalZ)) break;
          }
          e.nextGoalAt = this.time + 0.8 + this.rng() * 1.2;
        } else {
          // GAVE UP — back to the post, and stay there. Without this they would
          // simply stop wherever the search ran out, and a room you disengaged from
          // would slowly turn into a loose crowd standing in the open.
          const post = this.spawns[ei];
          e.goalX = post[0];
          e.goalZ = post[1];
          e.nextGoalAt = this.time + 1.4 + this.rng() * 2;
        }
      }
      if (Math.hypot(e.goalX - e.x, e.goalZ - e.z) > 0.6) {
        this.moveToward(e, e.goalX, e.goalZ, dt, e.boss ? B.MOVE_MULT[ph] : 1);
        e.ai = 'seek';
      } else {
        e.ai = 'hidden';
      }

      // Earn a token to peek + shoot: mooks share the MAX_ATTACKERS budget, a
      // boss always may (it fights outside the fairness cap). `los` already
      // requires the current target to be alive (see `pickTarget`), so no
      // separate aliveness check is needed here — and must not hardcode
      // `this.playerAlive`, which would wrongly block a valid engagement
      // against a still-living teammate after the local player has died.
      if ((e.boss || tokens < E.MAX_ATTACKERS) && los && dist < E.ENGAGE_RANGE && this.time >= e.aiUntil) {
        e.token = true; if (!e.boss) tokens++;
        e.ai = 'aim';
        const aimMs = e.boss ? B.AIM_MS[ph] : E.AIM_MS;
        e.aiUntil = this.time + aimMs * (0.85 + this.rng() * 0.4); // stagger the volley
        this.push(out, { kind: 'enemyAim', enemyId: e.id, from: [e.x, E.EYE_Y, e.z] });
      }
    }
  }

  /** Resolves a `targetId` to a firing-position (co-op only ever passes a
   *  non-`LOCAL_TARGET` id — see `pickTarget`). Mirrors the `LOCAL_TARGET`
   *  entry `allTargets` builds; kept separate since this is a single-target
   *  lookup at the point of firing, not a full target-selection pass. */
  private resolveFireTarget(id: string, input: FpsInput): { x: number; z: number; eyeY: number; alive: boolean } {
    if (id !== LOCAL_TARGET) {
      const c = this.combatants.get(id);
      if (c) return { x: c.x, z: c.z, eyeY: c.eyeY, alive: c.alive };
    }
    return { x: input.origin[0], z: input.origin[2], eyeY: this.playerEyeY, alive: this.playerAlive };
  }

  private getMercyUntil(id: string): number {
    return id === LOCAL_TARGET ? this.mercyUntil : (this.combatantMercyUntil.get(id) ?? 0);
  }
  private setMercyUntil(id: string, at: number): void {
    if (id === LOCAL_TARGET) this.mercyUntil = at;
    else this.combatantMercyUntil.set(id, at);
  }

  private enemyFire(e: FpsEnemy, input: FpsInput, out: FpsEvent[], spreadMult = 1): void {
    const E = FPS_TUNING.ENEMY;
    const tgt = this.resolveFireTarget(e.targetId, input);
    const px = tgt.x, pz = tgt.z;
    const eyeY = tgt.eyeY;

    // The muzzle of the rifle in their hands, not a point inside their chest.
    const fx = Math.sin(e.facing), fz = Math.cos(e.facing);
    const rx = Math.cos(e.facing), rz = -Math.sin(e.facing);
    const from: Vec3 = [
      e.x + fx * E.MUZZLE_FWD + rx * E.MUZZLE_RIGHT,
      E.MUZZLE_Y,
      e.z + fz * E.MUZZLE_FWD + rz * E.MUZZLE_RIGHT,
    ];

    // Aim centre mass, then open a cone that widens with range: no dice roll,
    // the round either intersects you or it doesn't.
    const aim: Vec3 = [px, eyeY - 0.28, pz];
    const dist = Math.hypot(px - from[0], pz - from[2]);
    const t = clamp01((dist - E.NEAR) / Math.max(1, E.FAR - E.NEAR));
    const spread = (E.SPREAD_NEAR + (E.SPREAD_FAR - E.SPREAD_NEAR) * t) * spreadMult;
    const dir = jitter(normalize([aim[0] - from[0], aim[1] - from[1], aim[2] - from[2]]), spread, this.rng);

    // Trace it: cover eats rounds, otherwise find which part of you it strikes.
    let bestT: number = FPS_TUNING.MAX_RAY;
    let part: HitPart | null = null;
    let hitBox: [Vec3, Vec3] | null = null;
    let hitGround = false;
    for (const c of this.cover) {
      const box = aabbOfCover(c);
      const tc = rayAABB(from, dir, box);
      if (tc !== null && tc < bestT) { bestT = tc; part = null; hitBox = box; hitGround = false; }
    }
    const tg = rayGround(from, dir);
    if (tg !== null && tg < bestT) { bestT = tg; part = null; hitBox = null; hitGround = true; }
    for (const z of playerHitZones(px, pz, eyeY)) {
      const tz = z.sphere
        ? raySphere(from, dir, z.sphere.c, z.sphere.r)
        : rayAABB(from, dir, [z.min!, z.max!]);
      if (tz !== null && tz < bestT) { bestT = tz; part = z.part; hitBox = null; hitGround = false; }
    }
    const impact: Vec3 = [from[0] + dir[0] * bestT, from[1] + dir[1] * bestT, from[2] + dir[2] * bestT];
    // A round that struck YOU has no surface to spark off; one that missed into the
    // scenery does, and that near-miss splash is most of what sells incoming fire.
    const normal: Vec3 | null = part !== null ? null
      : hitGround ? UP
      : hitBox ? aabbFaceNormal(impact, hitBox)
      : null;

    this.enemyShots++;
    // Visual/audio "an enemy shot at you" event only makes sense for the
    // LOCAL player — every existing consumer (tracers, impact sparks,
    // camera shake) assumes it's about the client running this sim. A shot
    // at a teammate still deals real damage below; the teammate's own
    // client learns about it by diffing their own hp across successive
    // broadcast snapshots (see `ValorScene`'s coop wiring), not from an
    // event here.
    if (e.targetId === LOCAL_TARGET) {
      this.push(out, { kind: 'enemyFire', enemyId: e.id, from, dir, impact, hit: part !== null, part, normal });
    }

    if (!part || !tgt.alive || this.time < this.getMercyUntil(e.targetId)) return;
    this.setMercyUntil(e.targetId, this.time + E.MERCY_MS);
    const dmg = Math.round(E.DMG * FPS_TUNING.PLAYER_HIT.PART_MULT[part]);
    const fromDir = normalize([e.x - px, 0, e.z - pz]);

    if (e.targetId === LOCAL_TARGET) {
      this.lastHitPart = part;
      this.hitParts[part]++;
      this.playerHp = Math.max(0, this.playerHp - dmg);
      this.push(out, { kind: 'playerHit', damage: dmg, part, from, fromDir, hp: this.playerHp });
      if (this.playerHp <= 0) {
        this.playerAlive = false;
        this.push(out, { kind: 'playerDown' });
      }
    } else {
      const c = this.combatants.get(e.targetId);
      if (c) {
        c.hp = Math.max(0, c.hp - dmg);
        if (c.hp <= 0) c.alive = false;
      }
    }
  }

  /** Is the player visible from this enemy (no cover box in the way)? */
  private hasLOS(e: FpsEnemy, playerEye: Vec3): boolean {
    const from: Vec3 = [e.x, FPS_TUNING.ENEMY.EYE_Y, e.z];
    const d: Vec3 = [playerEye[0] - from[0], playerEye[1] - from[1], playerEye[2] - from[2]];
    const dist = Math.hypot(d[0], d[1], d[2]) || 1;
    const nd: Vec3 = [d[0] / dist, d[1] / dist, d[2] / dist];
    for (const c of this.cover) {
      const t = rayAABB(from, nd, aabbOfCover(c));
      if (t !== null && t < dist - 0.4) return false;
    }
    return true;
  }

  /** Push a point out of every wall/crate. Two passes: sliding off one box can
   *  bury you in the next, and a single pass leaves the body half inside. */
  private pushOutOfCover(x: number, z: number): [number, number] {
    const R = FPS_TUNING.ENEMY.BODY_R;
    let nx = x, nz = z;
    for (let pass = 0; pass < 2; pass++) {
      for (const c of this.cover) {
        const hx = c.w / 2 + R, hz = c.d / 2 + R;
        const dx = nx - c.x, dz = nz - c.z;
        if (Math.abs(dx) < hx && Math.abs(dz) < hz) {
          if (hx - Math.abs(dx) < hz - Math.abs(dz)) nx = c.x + Math.sign(dx || 1) * hx;
          else nz = c.z + Math.sign(dz || 1) * hz;
        }
      }
    }
    return [nx, nz];
  }

  /** True if a body of radius BODY_R at (x,z) would be inside geometry. */
  private inCover(x: number, z: number): boolean {
    const R = FPS_TUNING.ENEMY.BODY_R;
    for (const c of this.cover) {
      if (Math.abs(x - c.x) < c.w / 2 + R && Math.abs(z - c.z) < c.d / 2 + R) return true;
    }
    return false;
  }

  private moveToward(e: FpsEnemy, px: number, pz: number, dt: number, speedMult = 1): void {
    const R = FPS_TUNING.ENEMY.BODY_R;
    const dx = px - e.x, dz = pz - e.z;
    const len = Math.hypot(dx, dz) || 1;
    const step = FPS_TUNING.ENEMY.MOVE_SPEED * speedMult * dt;
    // Slide toward the target instead of "step then eject": walls become solid, and an
    // enemy pressing into one now hugs it rather than popping through to the far side.
    const [nx, nz] = slideMove(e.x, e.z, e.x + (dx / len) * step, e.z + (dz / len) * step, R, this.cover);
    const b = this.bounds;
    e.x = Math.max(b.minX, Math.min(b.maxX, nx));
    e.z = Math.max(b.minZ, Math.min(b.maxZ, nz));
  }

  /**
   * SECOND WIND: back on your feet where you fell, at full health, with the fight
   * exactly as you left it.
   *
   * Distinct from both of its neighbours. `resetEncounter` throws the whole
   * encounter back to the start; `revive` (the survival re-arm you pay G$ for)
   * clears the swarm that killed you. This one changes nothing but you — the room
   * you were losing is still the room you have to win.
   *
   * The mercy window is the point of it: you went down inside someone's burst, and
   * standing up into the rest of that same burst would spend the second wind for
   * nothing.
   */
  secondWind(mercySecs = 1.6): void {
    if (this.playerAlive) return;
    this.playerAlive = true;
    this.playerHp = FPS_TUNING.PLAYER_HP;
    this.mercyUntil = this.time + mercySecs;
  }

  /** Reset the encounter (player + enemies) — the scene calls this after a DOWN beat. */
  resetEncounter(): void {
    this.playerHp = FPS_TUNING.PLAYER_HP;
    this.playerAlive = true;
    this.mercyUntil = 0;
    // Back to the primary, both weapons topped up.
    this.activeSlot = 0;
    this.ammoBySlot = this.loadout.map((id) => this.resolveGun(id).magazine);
    this.gun = this.resolveGun(this.loadout[0]);
    this.fireMode = (GUN_FIRE_MODES[this.gun.id] ?? ['auto'])[0];
    this.reloading = false;
    if (this.hostage) { this.hostage.x = this.hostage.spawn[0]; this.hostage.z = this.hostage.spawn[1]; this.hostage.rescued = false; }
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      const [sx, sz] = this.spawns[i];
      e.x = sx; e.z = sz;
      e.alive = true; e.hp = e.maxHp;
      e.token = false; e.ai = 'hidden'; e.ducking = 1;
      e.phase = e.boss ? 1 : 0;
      e.burnUntil = 0; e.burnDps = 0;
      e.goalX = sx; e.goalZ = sz; e.nextGoalAt = 0;
      e.aiUntil = this.time + this.rng() * FPS_TUNING.ENEMY.HIDE_MS;
    }
  }

  // ── Survival mode: a fixed pool of enemy slots, spawned in escalating waves ──

  /** Clear the field WITHOUT counting kills. deadAt < 0 marks a slot as hidden
   *  (never-spawned / cleared between waves), so the scene can hide it. */
  despawnAll(): void {
    for (const e of this.enemies) {
      e.alive = false; e.hp = 0; e.deadAt = -999; e.active = false;
      e.token = false; e.ai = 'hidden';
    }
  }

  /** Bring `count` slots back at their spawn points with health scaled by
   *  `hpMult`, and wake them. Returns how many actually spawned. */
  startWave(count: number, hpMult: number): number {
    let n = 0;
    for (let i = 0; i < this.enemies.length && n < count; i++) {
      const e = this.enemies[i];
      const [sx, sz] = this.spawns[i];
      e.x = sx; e.z = sz;
      e.maxHp = Math.max(1, Math.round(FPS_TUNING.DEFAULT_ENEMY_HP * hpMult));
      e.hp = e.maxHp;
      e.alive = true; e.deadAt = 0; e.active = true; e.token = false;
      e.burnUntil = 0; e.burnDps = 0;
      e.ai = 'hidden'; e.phase = e.boss ? 1 : 0;
      e.goalX = sx; e.goalZ = sz; e.nextGoalAt = 0;
      e.aiUntil = this.time + this.rng() * FPS_TUNING.ENEMY.HIDE_MS;
      e.targetId = LOCAL_TARGET;
      this.events.push({ kind: 'spawn', enemyId: e.id });
      n++;
    }
    return n;
  }

  // ── Endless mode: a chain of rooms streamed in and out at runtime ─────────────
  //
  // Campaign missions are fixed: all geometry and every enemy exist from the first
  // frame. Endless can't work that way — the compound has no end, so it is appended
  // ahead of the player and dropped behind them. These three methods are the whole
  // streaming contract, and they keep `enemies` and `spawns` index-aligned (which
  // reinforce/resetEncounter/startWave all depend on).

  /** Add geometry to the live collision set. The array returned by `getCover()` is
   *  mutated in place, so anything already holding that reference (the scene's
   *  raycasts and movement) picks the new walls up on the very next frame. */
  appendCover(boxes: readonly CoverBox[]): void {
    for (const b of boxes) this.cover.push(b);
  }

  /** Spawn a room's defenders mid-run. They come in DORMANT (`active: false`) so a
   *  room stays quiet until the player actually breaches it — the same contract as
   *  authored mission rooms, which `setRoomActive` then wakes. */
  appendEnemies(specs: readonly EnemySpec[], active = false): number[] {
    const ids: number[] = [];
    for (const spec of specs) {
      const e = this.addEnemy(spec);
      e.active = active;
      ids.push(e.id);
    }
    return ids;
  }

  /** Move the enemy safety box to follow a travelling world. Endless calls this with
   *  the live chain window; authored missions never call it and keep the origin box. */
  setBounds(minX: number, maxX: number, minZ: number, maxZ: number): void {
    this.bounds = { minX, maxX, minZ, maxZ };
  }

  /** Drop everything from rooms strictly BEFORE `room`, and any cover box lying
   *  entirely behind `zBehind` (i.e. at greater Z, since the chain runs toward -Z).
   *  Without this an endless run grows both arrays without bound and the per-frame
   *  cover loops get slower the deeper you go. */
  pruneBehind(room: number, zBehind: number): void {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      if (this.enemies[i].room < room) {
        this.enemies.splice(i, 1);
        this.spawns.splice(i, 1); // parallel array — must stay index-aligned
      }
    }
    for (let i = this.cover.length - 1; i >= 0; i--) {
      const c = this.cover[i];
      if (c.z - c.d / 2 > zBehind) this.cover.splice(i, 1);
    }
  }

  // ── Co-op Endless (party mode) — see `ValorScene`'s `coop` prop ────────────

  /** Registers or updates a teammate as a live AI target — called once per
   *  frame per teammate by the HOST's own client, fed from the party
   *  relay's reported peer positions. Only position/aim ever come from the
   *  teammate's own client; hp/alive are host-owned from here on (set on
   *  first call, then only ever mutated by `enemyFire`'s damage
   *  resolution) — the same "the sim owns survival, the client only
   *  reports where it wants to be" split the local player already has. */
  setCombatant(id: string, x: number, z: number, eyeY: number): void {
    const existing = this.combatants.get(id);
    if (existing) { existing.x = x; existing.z = z; existing.eyeY = eyeY; return; }
    this.combatants.set(id, { x, z, eyeY, hp: FPS_TUNING.PLAYER_HP, alive: true });
  }

  /** A teammate left the party mid-run — stop targeting them and forget
   *  their state entirely. Any enemy currently engaging them re-picks a
   *  target on its very next `updateEnemies` pass (`pickTarget` always
   *  re-checks LOS to whatever `targetId` currently resolves to). */
  removeCombatant(id: string): void {
    this.combatants.delete(id);
    this.combatantMercyUntil.delete(id);
  }

  /** Read-only lookup for the HOST's own client — it doesn't otherwise
   *  learn a teammate's hp/alive state at all (that lives only in this
   *  private map), unlike a non-host, who reads it straight off the
   *  broadcast `combatants` snapshot alongside everything else. */
  getCombatant(id: string): { hp: number; alive: boolean } | null {
    const c = this.combatants.get(id);
    return c ? { hp: c.hp, alive: c.alive } : null;
  }

  /** Survival re-arm · REVIVE: bring the player back from death at full health
   *  with a longer mercy window, and clear the swarm that downed them so the
   *  restart is fair. The scene resumes the wave loop from here. No-op if alive.
   *  This one is PAID for in G$ — the free version is `secondWind`, which leaves
   *  the enemies exactly where they are. */
  revive(): void {
    if (this.playerAlive) return;
    this.playerAlive = true;
    this.playerHp = FPS_TUNING.PLAYER_HP;
    this.mercyUntil = this.time + 1.5;
    this.despawnAll();
  }

  /** Survival re-arm · RESUPPLY: patch to full health and top off both weapons
   *  instantly (cancels any reload). For buying survivability between waves while
   *  still alive. No-op if dead (use revive first). */
  resupply(): void {
    if (!this.playerAlive) return;
    this.playerHp = FPS_TUNING.PLAYER_HP;
    this.reloading = false;
    this.ammoBySlot = this.loadout.map((id) => this.resolveGun(id).magazine);
  }

  /** Debug: drop every enemy in ONE room (probe hook for headless verification of
   *  the endless chain, where killing the whole sim would also wipe the dormant
   *  rooms ahead and hide whether breaching actually wakes them). */
  debugKillRoom(room: number): void {
    for (const e of this.enemies) {
      if (e.alive && e.room === room) {
        e.alive = false;
        e.hp = 0;
        e.deadAt = this.time;
        this.kills++;
        this.events.push({ kind: 'kill', enemyId: e.id });
      }
    }
  }

  /**
   * Debug: kill the PLAYER outright (probe hook for headless verification of the
   * death path — waiting to be shot down takes minutes under software rendering).
   *
   * Emits `playerDown` like a real killing shot does. It used to just zero the
   * health and flip the flag, which meant the hook silently skipped everything the
   * scene hangs off that event — the down card, the dropped weapon, the loss
   * report, the second wind — so a probe using it "verified" a death path that no
   * real death takes.
   */
  debugKillPlayer(): void {
    if (!this.playerAlive) return;
    this.playerHp = 0;
    this.playerAlive = false;
    this.events.push({ kind: 'playerDown' });
  }

  /** Debug: drop every enemy now (probe hook for headless verification). */
  debugKillAll(): void {
    for (const e of this.enemies) {
      if (e.alive) {
        e.alive = false;
        e.hp = 0;
        e.deadAt = this.time;
        this.kills++;
        this.events.push({ kind: 'kill', enemyId: e.id });
      }
    }
  }

  /** Drain accumulated events (the scene calls this once per frame). */
  drain(): FpsEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  snapshot() {
    return {
      time: this.time,
      ammo: this.ammo,
      magazine: this.gun.magazine,
      reloading: this.reloading,
      fireMode: this.fireMode,
      reloadRemaining: this.reloading ? Math.max(0, this.reloadEndsAt - this.time) : 0,
      gunId: this.gun.id,
      gunName: this.gun.name,
      gunTier: this.gun.tier,
      slot: this.activeSlot,
      loadout: this.loadout.slice(),
      attachments: [...this.attachments],
      playerHp: this.playerHp,
      maxPlayerHp: FPS_TUNING.PLAYER_HP,
      playerAlive: this.playerAlive,
      enemies: this.enemies.map((e) => ({
        id: e.id, x: e.x, z: e.z, alive: e.alive, hp: e.hp, maxHp: e.maxHp, deadAt: e.deadAt,
        ai: e.ai, ducking: e.ducking, facing: e.facing, token: e.token, room: e.room, active: e.active, boss: e.boss, phase: e.phase,
        // What it believes, alongside what it is. Exposed for the same reason `ai`
        // and `token` are: this is the state you need to see to tell a bug from a
        // design choice when an enemy walks the wrong way.
        seenX: e.seenX, seenZ: e.seenZ, seenAt: e.seenAt,
      })),
      aliveCount: this.aliveCount(),
      hostage: this.hostage ? { x: this.hostage.x, z: this.hostage.z, rescued: this.hostage.rescued } : null,
      stats: { shotsFired: this.shotsFired, hits: this.hits, headshots: this.headshots, kills: this.kills, enemyShots: this.enemyShots },
      lastHitPart: this.lastHitPart,
      hitParts: { ...this.hitParts },
      // Co-op Endless only — empty in every other mode. This is what the
      // HOST's client broadcasts over `useCoopSocket`'s `sendHostState` so
      // every teammate's own client can render everyone else and detect
      // its own hp dropping (see `ValorScene`'s coop wiring).
      combatants: Object.fromEntries(
        [...this.combatants].map(([id, c]) => [id, { x: c.x, z: c.z, hp: c.hp, alive: c.alive }]),
      ),
    };
  }
}

// ── Pure geometry (exported for unit tests) ──────────────────────────────────

/**
 * Swept collision of a POINT (a body of radius `r`, folded into the box via Minkowski
 * expansion) moving by (dx,dz) against one box. Returns the fraction of the move at
 * which it first touches, plus the face normal, or null for no hit.
 *
 * This is what makes a wall genuinely solid. A detect-then-eject resolver can always be
 * defeated by a big enough step (a slow phone frame): once the centre is past a thin
 * wall's midline it gets ejected out the FAR side. A swept test instead finds the exact
 * entry point along the path, so the body is stopped BEFORE the surface no matter how
 * large the step or how thin the wall — passing through is geometrically impossible.
 */
function sweepBox(
  ox: number, oz: number, dx: number, dz: number, c: CoverBox, r: number,
): { t: number; nx: number; nz: number } | null {
  const loX = c.x - c.w / 2 - r, hiX = c.x + c.w / 2 + r;
  const loZ = c.z - c.d / 2 - r, hiZ = c.z + c.d / 2 + r;
  // Already inside ⇒ not an ENTRY event; the eject pass in slideMove handles that.
  if (ox > loX && ox < hiX && oz > loZ && oz < hiZ) return null;

  // Parametric entry/exit distance along the move for each axis (slab method).
  let xEntry: number, xExit: number;
  if (dx > 0) { xEntry = (loX - ox) / dx; xExit = (hiX - ox) / dx; }
  else if (dx < 0) { xEntry = (hiX - ox) / dx; xExit = (loX - ox) / dx; }
  else { if (ox <= loX || ox >= hiX) return null; xEntry = -Infinity; xExit = Infinity; }

  let zEntry: number, zExit: number;
  if (dz > 0) { zEntry = (loZ - oz) / dz; zExit = (hiZ - oz) / dz; }
  else if (dz < 0) { zEntry = (hiZ - oz) / dz; zExit = (loZ - oz) / dz; }
  else { if (oz <= loZ || oz >= hiZ) return null; zEntry = -Infinity; zExit = Infinity; }

  const entry = Math.max(xEntry, zEntry);
  const exit = Math.min(xExit, zExit);
  if (entry > exit || entry < 0 || entry > 1) return null;

  // The gating axis (later entry) owns the contact normal.
  if (xEntry > zEntry) return { t: entry, nx: dx < 0 ? 1 : -1, nz: 0 };
  return { t: entry, nx: 0, nz: dz < 0 ? 1 : -1 };
}

/**
 * Free a body that is ALREADY embedded (spawned inside a wall, shoved in off a
 * corpse, or clamped into one by the arena bounds).
 *
 * Pushes out along the shallowest axis, but takes the SIDE from `fromX/fromZ` —
 * the last position the body is known to have been legal at. That is what stops
 * this from being an exit through the far face: a body a few centimetres into a
 * wall is, by least-penetration alone, just as close to the outside of the far
 * side once the box is inflated by a big radius, and picking wrong teleports it
 * through.
 *
 * Iterates rather than running a fixed two passes, because leaving one box can
 * enter another and an inside corner needs several rounds to converge. This is
 * exactly where it used to fail: pass one pushed the body out of wall A and into
 * wall B, pass two pushed it out of B — through it — and nothing rechecked A.
 */
function ejectEmbedded(
  x: number, z: number, r: number, boxes: readonly CoverBox[],
  fromX: number, fromZ: number,
): [number, number] {
  let nx = x, nz = z;
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (const c of boxes) {
      const hx = c.w / 2 + r, hz = c.d / 2 + r;
      const dx = nx - c.x, dz = nz - c.z;
      if (Math.abs(dx) >= hx || Math.abs(dz) >= hz) continue;
      if (hx - Math.abs(dx) < hz - Math.abs(dz)) {
        nx = c.x + Math.sign((fromX - c.x) || dx || 1) * hx;
      } else {
        nz = c.z + Math.sign((fromZ - c.z) || dz || 1) * hz;
      }
      moved = true;
    }
    if (!moved) break; // free of everything
  }
  return [nx, nz];
}

/** Push a body out of any geometry it is standing inside. Used at spawn, where a
 *  hand-authored position can sit inside a crate nobody measured against. */
export function ejectFromCover(
  x: number, z: number, r: number, boxes: readonly CoverBox[],
): [number, number] {
  return ejectEmbedded(x, z, r, boxes, x, z);
}

/**
 * Move a body of radius `r` from (ox,oz) toward (tx,tz), sliding along any wall or crate
 * it would hit rather than passing through it. Collide-and-slide: sweep to the first
 * contact, cancel the velocity component into that surface, then sweep the remainder so
 * the body glides along the wall. Two iterations handle an inside corner. A final
 * least-penetration eject frees anything that started embedded. Pure; exported for tests.
 */
export function slideMove(
  ox: number, oz: number, tx: number, tz: number, r: number, boxes: readonly CoverBox[],
): [number, number] {
  const SKIN = 1e-3; // stop a hair short of the face so the next frame isn't "inside"
  // Free the START before sweeping. A sweep that begins inside a box reports no
  // hit at all (see sweepBox — an entry test cannot fire from within), so a body
  // that is embedded for any reason would move through that box unopposed for the
  // whole frame, and only get ejected after the fact — by then possibly out the
  // far side. Nothing downstream can recover from that, so it is fixed up front.
  let [px, pz] = ejectEmbedded(ox, oz, r, boxes, ox, oz);
  let dx = tx - px, dz = tz - pz;
  for (let iter = 0; iter < 2 && (dx !== 0 || dz !== 0); iter++) {
    let best: { t: number; nx: number; nz: number } | null = null;
    for (const c of boxes) {
      const h = sweepBox(px, pz, dx, dz, c, r);
      if (h && (best === null || h.t < best.t)) best = h;
    }
    if (best === null) { px += dx; pz += dz; break; }
    const t = Math.max(0, best.t - SKIN);
    px += dx * t; pz += dz * t;
    // Slide: drop the remaining motion along the contact normal, keep the tangent.
    const rem = 1 - t;
    dx = best.nx !== 0 ? 0 : dx * rem;
    dz = best.nz !== 0 ? 0 : dz * rem;
  }
  // The origin is the reference side: whatever happened during the sweep, the body
  // comes to rest on the side of each wall it started this frame on.
  return ejectEmbedded(px, pz, r, boxes, ox, oz);
}

export function aabbOfCover(c: CoverBox): [Vec3, Vec3] {
  return [
    [c.x - c.w / 2, 0, c.z - c.d / 2],
    [c.x + c.w / 2, c.h, c.z + c.d / 2],
  ];
}

export interface HitZone {
  part: HitPart;
  min: Vec3;
  max: Vec3;
}

/** A zone of the PLAYER's body: either a sphere (head) or a box. */
export interface PlayerZone {
  part: HitPart;
  sphere?: { c: Vec3; r: number };
  min?: Vec3;
  max?: Vec3;
}

/**
 * Where the player's head, torso and legs are, given their feet at (x,z) and
 * their eye at `eyeY`. Crouching lowers the whole silhouette, which is why
 * ducking actually protects your head instead of only looking like it does.
 */
export function playerHitZones(x: number, z: number, eyeY: number): PlayerZone[] {
  const P = FPS_TUNING.PLAYER_HIT;
  return [
    { part: 'head', sphere: { c: [x, eyeY, z], r: P.HEAD_R } },
    { part: 'torso', min: [x - P.TORSO.h, eyeY + P.TORSO.y0, z - P.TORSO.h], max: [x + P.TORSO.h, eyeY + P.TORSO.y1, z + P.TORSO.h] },
    { part: 'leg', min: [x - P.LEGS.h, 0.02, z - P.LEGS.h], max: [x + P.LEGS.h, eyeY + P.LEGS.yTop, z + P.LEGS.h] },
  ];
}

/**
 * The body AABB zones (everything except the head sphere) for an enemy at (x,z):
 * torso, both arms, and the legs. Together with the head they cover the whole
 * standing silhouette, so a shot anywhere on the body registers.
 */
export function bodyZones(e: { x: number; z: number }): HitZone[] {
  const T = FPS_TUNING.TORSO, L = FPS_TUNING.LEGS, A = FPS_TUNING.ARM;
  return [
    { part: 'torso', min: [e.x - T.hx, T.y0, e.z - T.hz], max: [e.x + T.hx, T.y1, e.z + T.hz] },
    { part: 'leg', min: [e.x - L.hx, L.y0, e.z - L.hz], max: [e.x + L.hx, L.y1, e.z + L.hz] },
    { part: 'arm', min: [e.x - A.dx - A.hx, A.y0, e.z - A.hz], max: [e.x - A.dx + A.hx, A.y1, e.z + A.hz] },
    { part: 'arm', min: [e.x + A.dx - A.hx, A.y0, e.z - A.hz], max: [e.x + A.dx + A.hx, A.y1, e.z + A.hz] },
  ];
}

/** Nearest positive ray-sphere hit distance, or null. */
export function raySphere(o: Vec3, d: Vec3, center: Vec3, r: number): number | null {
  const ox = o[0] - center[0], oy = o[1] - center[1], oz = o[2] - center[2];
  const b = ox * d[0] + oy * d[1] + oz * d[2];
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t0 = -b - sq;
  if (t0 >= 0) return t0;
  const t1 = -b + sq;
  return t1 >= 0 ? t1 : null;
}

/** Distance at which the ray meets the ground plane (y = 0), or null if it is level
 *  or climbing (it never comes down) or the ground is beyond the weapon's reach. */
export function rayGround(o: Vec3, d: Vec3): number | null {
  if (d[1] >= -1e-6 || o[1] <= 0) return null;
  const t = -o[1] / d[1];
  return t > 0 && t < FPS_TUNING.MAX_RAY ? t : null;
}

/**
 * The outward normal of the box face that `p` lies on. `p` comes off a ray-AABB
 * hit, so it is ON the surface by construction and the nearest face is the one it
 * struck; ties (a corner shot) resolve to whichever axis is checked first, which is
 * as good an answer as any.
 */
export function aabbFaceNormal(p: Vec3, box: [Vec3, Vec3]): Vec3 {
  const [min, max] = box;
  let best = Infinity;
  let normal: Vec3 = UP;
  for (let i = 0; i < 3; i++) {
    const dLo = Math.abs(p[i] - min[i]);
    if (dLo < best) {
      best = dLo;
      normal = i === 0 ? [-1, 0, 0] : i === 1 ? [0, -1, 0] : [0, 0, -1];
    }
    const dHi = Math.abs(p[i] - max[i]);
    if (dHi < best) {
      best = dHi;
      normal = i === 0 ? [1, 0, 0] : i === 1 ? UP : [0, 0, 1];
    }
  }
  return normal;
}

/** Nearest positive ray-AABB (slab method) hit distance, or null. */
export function rayAABB(o: Vec3, d: Vec3, box: [Vec3, Vec3]): number | null {
  const [min, max] = box;
  let tmin = 0;
  let tmax: number = FPS_TUNING.MAX_RAY;
  for (let i = 0; i < 3; i++) {
    const oi = o[i], di = d[i];
    if (Math.abs(di) < 1e-8) {
      if (oi < min[i] || oi > max[i]) return null;
    } else {
      const inv = 1 / di;
      let t1 = (min[i] - oi) * inv;
      let t2 = (max[i] - oi) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  return tmin > 0 ? tmin : (tmax > 0 ? tmax : null);
}

/** Perturb a unit direction within a cone of half-angle `spread` (radians). */
export function jitter(d: Vec3, spread: number, rng: () => number): Vec3 {
  if (spread <= 1e-6) return d;
  // Uniform sample inside the cone: sqrt for area weighting.
  const theta = spread * Math.sqrt(rng());
  const phi = 2 * Math.PI * rng();
  // Build a basis perpendicular to d.
  const helper: Vec3 = Math.abs(d[1]) < 0.99 ? UP : [1, 0, 0];
  const right = normalize(cross(helper, d));
  const up = cross(d, right);
  const st = Math.sin(theta), ct = Math.cos(theta);
  const cx = Math.cos(phi) * st, cy = Math.sin(phi) * st;
  return normalize([
    d[0] * ct + right[0] * cx + up[0] * cy,
    d[1] * ct + right[1] * cx + up[1] * cy,
    d[2] * ct + right[2] * cx + up[2] * cy,
  ]);
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function negate(v: Vec3): Vec3 {
  return [-v[0], -v[1], -v[2]];
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
