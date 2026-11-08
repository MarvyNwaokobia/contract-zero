import * as THREE from 'three';
import { CharacterController } from '../character';
import { AnimState, type HitDirection } from '../animation';
import { Action, InputSystem } from '../input/InputSystem';
import {
  DamageSystem, type DamageEvent,
  type ComboState,
  getGun, STARTER_GUN_ID, type GunId, type GunStats,
  RangedAI, AIDifficulty,
} from '../combat';
import { KnockbackPhysics } from '../vfx/KnockbackPhysics';
import { resolveCover, losHit, regenerateCover } from './Cover';

/**
 * Headless, render-free authoritative combat core — RANGED STAT-DUEL.
 *
 * This is the single source of truth for a shooter duel. It runs with no Three
 * rendering, no AnimationMixer, no DOM/WebGL — only vector math — so the exact
 * same code can tick on a Node server (authoritative for ranked PvP, see
 * docs/PVP_NETCODE.md) and on the client for prediction.
 *
 * Combat is gun-driven (see engine/combat/GunStats.ts): a fighter holds Fire and
 * the weapon shoots on its cadence (60/fireRate), spawning a TRAVELLING projectile
 * (not hitscan). On arrival the shot resolves: if the target is dodging it whiffs
 * (i-frames), otherwise an accuracy roll lands damage (± crit). The only player
 * skill is dodge timing; gun stats supply the power. The sim emits DamageEvents +
 * per-fighter `animState`; the client maps those to clips, VFX (muzzle/tracer/
 * impact), screen-shake, audio and camera — none of which live here.
 *
 * Migration note: the legacy `attackStart` SimEvent + `attackProgress`/`comboState`
 * accessors are retained as inert stubs so the unmigrated GameScene still compiles;
 * slice 5 swaps GameScene onto the `fire`/`projectileHit` events and removes them.
 */

export type FighterId = 'p1' | 'p2';
export type ClassId = 'berserker' | 'sentinel' | 'phantom';

/** Per-fighter loadout/handicap the caller (Campaign level, PvP, tests) supplies. */
export interface SimOptions {
  p1Gun?: GunId;
  p2Gun?: GunId;
  p1HpMult?: number;
  p2HpMult?: number;
  // Mission encounters: the fight starts where the enemy was FOUND, not at the
  // arena origin — spawn positions, the combat zone, and HP carried in from a
  // previous encounter in the chain.
  p1Pos?: [number, number];
  p2Pos?: [number, number];
  /** Absolute starting HP for p1 (clamped to maxHealth); missions carry health across a chain. */
  p1Health?: number;
  zone?: { cx: number; cz: number; radius: number };
  /** Skip debris regeneration — the caller already laid the zone's cover out
   *  (missions generate it when the objective appears, not at the standoff). */
  keepCover?: boolean;
}

const FIGHTER_SEPARATION = 1.5;
const FIXED_DT = 1 / 60;

// Fighter footprint used when shoving bodies out of cover.
const COVER_FIGHTER_RADIUS = 0.5;

// Muzzle height (m) the tracer leaves from, and torso height the shot aims at.
const MUZZLE_HEIGHT = 1.4;
const TORSO_HEIGHT = 1.05;

// Reaction by hit weight — drives stagger length, knockback and which clip plays.
const STAGGER_DURATION: Record<'light' | 'heavy' | 'special', number> = {
  light: 0.16,
  heavy: 0.3,
  special: 0.5,
};
const KNOCKBACK_FORCE: Record<'light' | 'heavy' | 'special', number> = {
  light: 1.6,
  heavy: 3.2,
  special: 5,
};
// A crit ('special') still hits harder (longer stagger + more knockback above) but
// reads as a heavy flinch, not a full knockdown — a stand-and-trade gun duel keeps
// flowing rather than dropping a fighter to the floor every crit.
const REACTION_ANIM: Record<'light' | 'heavy' | 'special', AnimState> = {
  light: AnimState.HitLight,
  heavy: AnimState.HitHeavy,
  special: AnimState.HitHeavy,
};

/** Serializable per-fighter snapshot — exactly what a StateUpdate carries. */
export interface SimFighterState {
  id: FighterId;
  classId: ClassId;
  position: [number, number, number];
  rotation: number;
  velocity: [number, number, number];
  health: number;
  maxHealth: number;
  stamina: number;
  staminaMax: number;
  animState: AnimState;
  isAttacking: boolean;
  isBlocking: boolean;
  isDodging: boolean;
  isStaggered: boolean;
  isGrounded: boolean;
  isDead: boolean;
  // Gun/HUD state.
  gunId: GunId;
  ammo: number;
  magazine: number;
  reloading: boolean;
  reloadProgress: number; // 0 when not reloading, else 0..1 fraction complete
}

export interface SimSnapshot {
  tick: number;
  fighters: Record<FighterId, SimFighterState>;
  winner: FighterId | null;
}

/** Authoritative event the client renders (muzzle/tracer, impact, KO, …). */
export type SimEvent =
  // Legacy melee event — never emitted by the ranged resolver; retained until
  // GameScene migrates to `fire` in slice 5 (keeps the old consumer compiling).
  | { kind: 'attackStart'; fighter: FighterId; anim: AnimState; chain: boolean }
  // A shot left the muzzle: renderer plays the fire clip + muzzle flash + gunshot
  // + screen-shake and draws a tracer travelling origin→target over dist/speed.
  | { kind: 'fire'; fighter: FighterId; gunId: GunId; origin: [number, number, number]; dir: [number, number, number]; speed: number; target: [number, number, number] }
  // A landed shot — same shape as before so GameRoom/GameScene hit handling is unchanged.
  | { kind: 'hit'; event: DamageEvent; comboCount: number; direction: HitDirection }
  // A projectile reached the target (hit or whiff) — renderer shows impact / dust.
  // `dodged` = the miss was earned by i-frames (celebrate it), not a wide shot.
  | { kind: 'projectileHit'; shooterId: FighterId; targetId: FighterId; hit: boolean; crit: boolean; dodged: boolean; position: [number, number, number] }
  // The magazine ran dry and a reload started — renderer plays the mag-change
  // sound and the HUD shows the reload bar (progress rides the snapshot).
  | { kind: 'reload'; fighter: FighterId; duration: number }
  | { kind: 'ko'; winner: FighterId; loser: FighterId };

interface Weapon {
  gun: GunStats;
  cooldown: number;    // seconds until the next shot is allowed
  ammo: number;        // rounds left in the magazine
  reloading: boolean;
  reloadTimer: number; // seconds left on the current reload
}

interface Projectile {
  shooterId: FighterId;
  targetId: FighterId;
  damage: number;      // pre-rolled (incl. crit + range falloff), pre-defense
  crit: boolean;
  willHit: boolean;    // accuracy PRE-ROLLED at fire time so a miss can visibly fly wide
  arriveIn: number;    // seconds of travel left before it resolves
  impact: THREE.Vector3;
  blocked: boolean;    // sightline was obstructed by cover — absorbs into the wall
}

interface Fighter {
  id: FighterId;
  classId: ClassId;
  ctrl: CharacterController;
  weapon: Weapon;
  reactionAnim: AnimState; // hit-reaction clip to show while staggered
  hitStreak: number;       // consecutive landed shots (HUD/`comboCount`)
}

function makeWeapon(gun: GunStats): Weapon {
  return { gun, cooldown: 0, ammo: gun.magazine, reloading: false, reloadTimer: 0 };
}

// Where did the blow land relative to the defender's facing?
function hitDirection(defender: CharacterController, knockbackDir: THREE.Vector3): HitDirection {
  const toAttacker = new THREE.Vector3(-knockbackDir.x, 0, -knockbackDir.z);
  if (toAttacker.lengthSq() < 1e-6) return 'front';
  toAttacker.normalize();
  const fwd = new THREE.Vector3(Math.sin(defender.state.rotation), 0, Math.cos(defender.state.rotation));
  const dot = fwd.dot(toAttacker);
  if (dot > 0.4) return 'front';
  if (dot < -0.4) return 'back';
  return 'side';
}

export class CombatSim {
  readonly damage = new DamageSystem();
  readonly knockback = new KnockbackPhysics();

  private fighters: Record<FighterId, Fighter>;
  private ais: Partial<Record<FighterId, RangedAI>> = {};
  private projectiles: Projectile[] = [];
  private tick = 0;
  private winner: FighterId | null = null;
  private events: SimEvent[] = [];

  constructor(p1Class: ClassId, p2Class: ClassId, opts: SimOptions = {}) {
    const zone = opts.zone ?? { cx: 0, cz: 0, radius: 10 };
    const mk = (id: FighterId, classId: ClassId, pos: [number, number], gunId: GunId, hpMult: number): Fighter => {
      const ctrl = new CharacterController(new THREE.Vector3(pos[0], 0, pos[1]), {
        arenaRadius: zone.radius,
        arenaCenter: [zone.cx, zone.cz],
      });
      ctrl.state.maxHealth = Math.round(100 * hpMult);
      ctrl.state.health = ctrl.state.maxHealth;
      return {
        id, classId, ctrl,
        weapon: makeWeapon(getGun(gunId)),
        reactionAnim: AnimState.HitLight,
        hitStreak: 0,
      };
    };

    const p1Pos = opts.p1Pos ?? [zone.cx - 5, zone.cz];
    const p2Pos = opts.p2Pos ?? [zone.cx + 5, zone.cz];
    this.fighters = {
      p1: mk('p1', p1Class, p1Pos, opts.p1Gun ?? STARTER_GUN_ID, opts.p1HpMult ?? 1),
      p2: mk('p2', p2Class, p2Pos, opts.p2Gun ?? STARTER_GUN_ID, opts.p2HpMult ?? 1),
    };
    if (opts.p1Health !== undefined) {
      const p1 = this.fighters.p1.ctrl.state;
      p1.health = Math.max(1, Math.min(p1.maxHealth, Math.round(opts.p1Health)));
    }

    for (const id of ['p1', 'p2'] as FighterId[]) {
      this.damage.registerFighter(id, this.fighters[id].classId);
      this.knockback.register(id);
    }
    this.fighters.p1.ctrl.setLockOnTarget(this.fighters.p2.ctrl);
    this.fighters.p2.ctrl.setLockOnTarget(this.fighters.p1.ctrl);

    // Debris regenerates around the zone, staying clear of both fighters' feet
    // (a mission encounter can begin anywhere, not just at the ±5 duel spawns).
    if (!opts.keepCover) {
      regenerateCover(undefined, {
        ...zone,
        radius: Math.max(zone.radius + 1, 6),
        clear: [p1Pos, p2Pos],
      });
    }
  }

  get isOver(): boolean {
    return this.winner !== null;
  }

  getWinner(): FighterId | null {
    return this.winner;
  }

  /** Read-only access to a fighter's controller (for client rendering). */
  controller(id: FighterId): CharacterController {
    return this.fighters[id].ctrl;
  }

  /** Legacy melee accessor — no swing arc in a shooter, always 0 (slice-5 removal). */
  attackProgress(_id: FighterId): number {
    return 0;
  }

  /** Legacy melee accessor — no combo system in the stat-duel (slice-5 removal). */
  comboState(_id: FighterId): ComboState | null {
    return null;
  }

  /**
   * Make a fighter AI-controlled (PvE). The RangedAI holds Fire on a difficulty-
   * scaled cadence and reactively dodges shots the sim reports via `onIncomingFire`.
   */
  attachAI(id: FighterId, difficulty: AIDifficulty) {
    this.ais[id] = new RangedAI(difficulty, this.fighters[id].classId);
  }

  private inputFor(id: FighterId, inputs: Partial<Record<FighterId, InputSystem>>): InputSystem {
    const ai = this.ais[id];
    if (ai) return ai.getInput();
    const provided = inputs[id];
    if (!provided) throw new Error(`No input or AI for fighter ${id}`);
    return provided;
  }

  /**
   * Advance the fight one step. Inputs are virtual InputSystems (the caller —
   * server or client — sets actions on them); `dt` is the real elapsed time.
   * Returns the authoritative events produced this step.
   */
  step(
    dt: number,
    inputs: Partial<Record<FighterId, InputSystem>> = {},
    cameraYaw: Partial<Record<FighterId, number>> = {},
  ): SimEvent[] {
    this.events = [];
    if (this.winner !== null) return this.events;

    this.tick++;
    const clampedDt = Math.min(dt, 0.05);
    const ids = ['p1', 'p2'] as FighterId[];

    // 0. AI-controlled fighters decide their input first (movement + dodge).
    for (const id of ids) {
      const ai = this.ais[id];
      if (ai) {
        const opp = id === 'p1' ? 'p2' : 'p1';
        ai.update(clampedDt, this.fighters[id].ctrl, this.fighters[opp].ctrl);
      }
    }

    // 1. Movement / dodge. Camera-relative on the client (the local player passes
    //    its camera yaw); the server passes none → world-frame (0).
    for (const id of ids) {
      const f = this.fighters[id];
      if (!f.ctrl.state.isDead) f.ctrl.update(clampedDt, this.inputFor(id, inputs), cameraYaw[id] ?? 0);
    }

    // 2. Weapons: tick cooldown/reload, then fire if Fire is held and ready.
    for (const id of ids) {
      this.updateWeapon(id, clampedDt);
      this.handleFire(id, this.inputFor(id, inputs));
    }

    // 3. Keep bodies from overlapping (they should stay at range, but just in case).
    this.fighters.p1.ctrl.separateFrom(this.fighters.p2.ctrl, FIGHTER_SEPARATION);

    // 4. Advance in-flight projectiles and resolve any that arrive this step.
    this.updateProjectiles(clampedDt);

    // 5. Systems.
    this.knockback.update(clampedDt, 'p1', this.fighters.p1.ctrl);
    this.knockback.update(clampedDt, 'p2', this.fighters.p2.ctrl);
    // Knockback slides the body AFTER the in-update arena clamp, so re-pin both
    // inside the pit — a hard hit at the edge must not shove a fighter off the floor.
    this.fighters.p1.ctrl.clampToBounds();
    this.fighters.p2.ctrl.clampToBounds();

    // Shove fighters out of any cover they walked/slid into, then re-pin to bounds.
    for (const id of ids) {
      const s = this.fighters[id].ctrl.state;
      const [nx, nz] = resolveCover(s.position.x, s.position.z, COVER_FIGHTER_RADIUS);
      s.position.x = nx;
      s.position.z = nz;
      this.fighters[id].ctrl.clampToBounds();
    }

    this.damage.updateStamina(clampedDt);

    // 6. Advance input frame edges.
    for (const id of ids) this.inputFor(id, inputs).update();

    return this.events;
  }

  // ── Weapon lifecycle ──────────────────────────────────────────────────────

  private updateWeapon(id: FighterId, dt: number) {
    const w = this.fighters[id].weapon;
    if (w.reloading) {
      w.reloadTimer -= dt;
      if (w.reloadTimer <= 0) {
        w.reloading = false;
        w.ammo = w.gun.magazine;
      }
      return;
    }
    if (w.cooldown > 0) w.cooldown -= dt;
  }

  private handleFire(id: FighterId, input: InputSystem) {
    const s = this.fighters[id].ctrl.state;
    if (s.isDead || s.isDodging || s.isStaggered) return;
    const w = this.fighters[id].weapon;
    if (w.reloading || w.cooldown > 0 || w.ammo <= 0) return;
    if (!input.getAction(Action.Fire).held) return; // auto-fire while held, gated by cadence
    this.fireShot(id);
  }

  private fireShot(id: FighterId) {
    const f = this.fighters[id];
    const oppId: FighterId = id === 'p1' ? 'p2' : 'p1';
    const target = this.fighters[oppId];
    const gun = f.weapon.gun;

    f.weapon.ammo -= 1;
    f.weapon.cooldown = 60 / gun.fireRate;
    if (f.weapon.ammo <= 0) {
      f.weapon.reloading = true;
      f.weapon.reloadTimer = gun.reloadTime;
      this.events.push({ kind: 'reload', fighter: id, duration: gun.reloadTime });
    }

    const sPos = f.ctrl.state.position;
    const tPos = target.ctrl.state.position;

    // Line of sight: a cover piece between shooter and target absorbs the shot.
    // When blocked, the tracer stops at the cover face and no damage is dealt.
    const block = losHit(sPos.x, sPos.z, tPos.x, tPos.z);
    const blocked = block !== null;

    // Accuracy is PRE-ROLLED here (not at arrival) so a missing round can be
    // AIMED wide — the player literally sees what the accuracy stat buys.
    // Dodge i-frames still override at arrival; that's the dodge mechanic.
    const willHit = Math.random() < gun.accuracy;

    let aim: THREE.Vector3;
    if (blocked) {
      aim = new THREE.Vector3(block.x, TORSO_HEIGHT, block.z);
    } else if (willHit) {
      aim = new THREE.Vector3(tPos.x, TORSO_HEIGHT, tPos.z);
    } else {
      // A wide shot: shove the aim point past the target's shoulder (random
      // side), vary the height, and let it carry a few metres beyond them so
      // the tracer visibly flies PAST rather than evaporating on the torso.
      const toT = new THREE.Vector3(tPos.x - sPos.x, 0, tPos.z - sPos.z);
      const d = toT.length() || 1e-3;
      toT.multiplyScalar(1 / d);
      const perp = new THREE.Vector3(-toT.z, 0, toT.x);
      const sideSign = Math.random() < 0.5 ? -1 : 1;
      const wide = new THREE.Vector3(tPos.x, 0, tPos.z)
        .addScaledVector(perp, sideSign * (0.55 + Math.random() * 0.6))
        .addScaledVector(toT, 2.5); // overshoot past the target
      wide.y = TORSO_HEIGHT + (Math.random() - 0.35) * 0.7;
      aim = wide;
    }
    const planarDir = new THREE.Vector3(aim.x - sPos.x, 0, aim.z - sPos.z);
    const planarDist = planarDir.length() || 1e-3;
    planarDir.multiplyScalar(1 / planarDist);
    // Muzzle sits at gun height, just in front of the shooter toward the target.
    const origin = new THREE.Vector3(sPos.x, MUZZLE_HEIGHT, sPos.z).addScaledVector(planarDir, 0.4);
    const dir = aim.clone().sub(origin);
    const dist = dir.length() || 1e-3; // to the aim point (clipped at cover if blocked)
    dir.multiplyScalar(1 / dist);

    // Pre-roll crit (gun + a slice of the class crit rate) and range falloff. Falloff
    // uses the TRUE shooter→target distance, not the cover-clipped tracer length.
    const stats = this.damage.getStats(id);
    const critChance = gun.critChance + (stats?.critRate ?? 0) * 0.5;
    const crit = Math.random() < critChance;
    const rangeDist = Math.hypot(tPos.x - sPos.x, tPos.z - sPos.z);
    const falloff = rangeDist <= gun.range ? 1 : Math.max(0.45, 1 - (rangeDist - gun.range) * 0.07);
    const damage = gun.damage * (crit ? gun.critMult : 1) * falloff;
    const arriveIn = dist / gun.projectileSpeed;

    this.projectiles.push({
      shooterId: id,
      targetId: oppId,
      damage,
      crit,
      willHit,
      arriveIn,
      impact: aim,
      blocked,
    });

    // Only warn the AI of a real threat — a shot eating cover isn't one. Wide
    // shots still warn (the defender can't know a round will miss mid-flight).
    if (!blocked) this.ais[oppId]?.onIncomingFire(arriveIn, target.ctrl);

    this.events.push({
      kind: 'fire',
      fighter: id,
      gunId: gun.id,
      origin: [origin.x, origin.y, origin.z],
      dir: [dir.x, dir.y, dir.z],
      speed: gun.projectileSpeed,
      target: [aim.x, aim.y, aim.z],
    });
  }

  // ── Projectile resolution ─────────────────────────────────────────────────

  private updateProjectiles(dt: number) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.arriveIn -= dt;
      if (p.arriveIn <= 0) {
        this.resolveProjectile(p);
        this.projectiles.splice(i, 1);
      }
    }
  }

  private resolveProjectile(p: Projectile) {
    const target = this.fighters[p.targetId];
    const ts = target.ctrl.state;
    const torso: [number, number, number] = [ts.position.x, TORSO_HEIGHT, ts.position.z];

    // Shot ate cover — spark on the wall, no damage.
    if (p.blocked) {
      this.fighters[p.shooterId].hitStreak = 0;
      this.events.push({ kind: 'projectileHit', shooterId: p.shooterId, targetId: p.targetId, hit: false, crit: false, dodged: false, position: [p.impact.x, p.impact.y, p.impact.z] });
      return;
    }

    if (ts.isDead) {
      this.events.push({ kind: 'projectileHit', shooterId: p.shooterId, targetId: p.targetId, hit: false, crit: false, dodged: false, position: torso });
      return;
    }

    // Dodging = i-frames (the whole point of travel-time); else the pre-rolled
    // accuracy decides. A dodge whiffs at the body (the round passes through
    // where they were); a wide shot whiffs out at its own aim point.
    const dodged = ts.isDodging;
    const landed = !dodged && p.willHit;
    if (landed) {
      this.applyShotDamage(p);
    } else {
      this.fighters[p.shooterId].hitStreak = 0;
      const at: [number, number, number] = dodged ? torso : [p.impact.x, p.impact.y, p.impact.z];
      this.events.push({ kind: 'projectileHit', shooterId: p.shooterId, targetId: p.targetId, hit: false, crit: false, dodged, position: at });
    }
  }

  private applyShotDamage(p: Projectile) {
    const atk = this.fighters[p.shooterId];
    const def = this.fighters[p.targetId];
    const defStats = this.damage.getStats(p.targetId);

    const reduction = (defStats?.defense ?? 1) * 0.06;
    const finalDamage = Math.max(1, Math.round(p.damage * (1 - reduction)));
    const hitType: 'light' | 'heavy' | 'special' = p.crit ? 'special' : finalDamage >= 22 ? 'heavy' : 'light';

    const knockbackDir = new THREE.Vector3()
      .subVectors(def.ctrl.state.position, atk.ctrl.state.position)
      .setY(0)
      .normalize();
    const force = KNOCKBACK_FORCE[hitType];
    const hitPosition = new THREE.Vector3(def.ctrl.state.position.x, TORSO_HEIGHT, def.ctrl.state.position.z);

    // Bullets ignore the (legacy melee) guard — dodge i-frames are the only
    // defense in the stat-duel, so holding Block must not reduce shot damage.
    def.ctrl.applyDamage(finalDamage, knockbackDir, force, false);

    // Reaction (the sim owns gameplay state; the client just plays the clip).
    def.reactionAnim = REACTION_ANIM[hitType];
    def.ctrl.applyStagger(STAGGER_DURATION[hitType]);
    this.knockback.applyKnockback(p.targetId, {
      direction: knockbackDir,
      force,
      hitType,
      killed: def.ctrl.state.isDead,
    });

    atk.hitStreak += 1;
    def.hitStreak = 0;
    const dir = hitDirection(def.ctrl, knockbackDir);

    const event: DamageEvent = {
      attackerId: p.shooterId,
      defenderId: p.targetId,
      rawDamage: Math.round(p.damage),
      finalDamage,
      blocked: false,
      parried: false,
      critical: p.crit,
      hitType,
      knockbackDir,
      knockbackForce: force,
      hitStun: STAGGER_DURATION[hitType],
      hitPosition,
      killed: def.ctrl.state.isDead,
    };

    this.events.push({ kind: 'hit', event, comboCount: atk.hitStreak, direction: dir });
    this.events.push({ kind: 'projectileHit', shooterId: p.shooterId, targetId: p.targetId, hit: true, crit: p.crit, dodged: false, position: [hitPosition.x, hitPosition.y, hitPosition.z] });

    if (def.ctrl.state.isDead && this.winner === null) {
      this.winner = p.shooterId;
      this.events.push({ kind: 'ko', winner: p.shooterId, loser: p.targetId });
    }
  }

  // ── Snapshot ────────────────────────────────────────────────────────────────

  private animStateOf(f: Fighter): AnimState {
    const s = f.ctrl.state;
    if (s.isDead) return AnimState.Death;
    if (s.isStaggered) return f.reactionAnim;
    if (s.isDodging) return AnimState.Dodge;
    const speed = Math.hypot(s.velocity.x, s.velocity.z);
    if (speed > 0.2) return s.isRunning ? AnimState.Run : AnimState.Walk;
    // Standing mag change reads as the reload clip; on the move, locomotion wins.
    if (f.weapon.reloading) return AnimState.Reload;
    return AnimState.Idle;
  }

  private fighterState(f: Fighter): SimFighterState {
    const s = f.ctrl.state;
    const stats = this.damage.getStats(f.id);
    const w = f.weapon;
    return {
      id: f.id,
      classId: f.classId,
      position: [s.position.x, s.position.y, s.position.z],
      rotation: s.rotation,
      velocity: [s.velocity.x, s.velocity.y, s.velocity.z],
      health: s.health,
      maxHealth: s.maxHealth,
      stamina: stats?.stamina ?? 0,
      staminaMax: stats?.staminaMax ?? 100,
      animState: this.animStateOf(f),
      isAttacking: false,
      isBlocking: s.isBlocking,
      isDodging: s.isDodging,
      isStaggered: s.isStaggered,
      isGrounded: s.isGrounded,
      isDead: s.isDead,
      gunId: w.gun.id,
      ammo: w.ammo,
      magazine: w.gun.magazine,
      reloading: w.reloading,
      reloadProgress: w.reloading
        ? Math.min(1, Math.max(0, 1 - w.reloadTimer / w.gun.reloadTime))
        : 0,
    };
  }

  snapshot(): SimSnapshot {
    return {
      tick: this.tick,
      fighters: { p1: this.fighterState(this.fighters.p1), p2: this.fighterState(this.fighters.p2) },
      winner: this.winner,
    };
  }
}

export { FIXED_DT };
