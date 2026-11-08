import { Action, InputSystem } from '../input/InputSystem';
import type { CharacterController } from '../character';

// PvE difficulty ladder. Climbs the Campaign (Easy → Boss): higher tiers fire a
// larger share of the time, react faster, and dodge more incoming shots. Lives
// here because RangedAI is the only AI the shooter runs.
export enum AIDifficulty {
  Easy = 'easy',
  Medium = 'medium',
  Hard = 'hard',
  Boss = 'boss',
}

/**
 * Fire-and-dodge AI for the ranged stat-duel.
 *
 * In a stat-duel the gun supplies the offense (accuracy/damage live in GunStats),
 * so the AI is deliberately tiny: it holds Fire on a difficulty-scaled duty cycle
 * and reactively rolls to dodge incoming shots. Difficulty climbs the PvE Campaign
 * ladder (Easy → Boss) by firing a larger share of the time, reacting faster, and
 * dodging more of the player's shots. It drives a virtual InputSystem exactly like
 * a human pad, so the headless CombatSim treats it identically to a network player.
 *
 * The sim calls `onIncomingFire()` the instant a projectile is launched at this
 * fighter — that's the only "perception" the AI gets, and what makes dodge timing
 * (not aim) the skill that scales.
 */

interface RangedAIConfig {
  dodgeChance: number;    // chance to attempt a dodge per incoming shot
  reactionTime: number;   // min delay (s) before a reactive dodge can fire
  aggressiveness: number; // fire duty cycle — fraction of time holding the trigger
}

const RANGED_CONFIGS: Record<AIDifficulty, RangedAIConfig> = {
  [AIDifficulty.Easy]:   { dodgeChance: 0.15, reactionTime: 0.35, aggressiveness: 0.45 },
  [AIDifficulty.Medium]: { dodgeChance: 0.30, reactionTime: 0.22, aggressiveness: 0.65 },
  [AIDifficulty.Hard]:   { dodgeChance: 0.50, reactionTime: 0.14, aggressiveness: 0.85 },
  [AIDifficulty.Boss]:   { dodgeChance: 0.70, reactionTime: 0.08, aggressiveness: 1.0 },
};

// Start the dodge this many seconds before impact so its i-frames are live on arrival.
const DODGE_LEAD = 0.16;

export class RangedAI {
  private input = new InputSystem();
  private config: RangedAIConfig;
  private firing = true;
  private cycleTimer = 0;
  private pendingDodge: number | null = null;
  // Circle-strafe state — flips direction on a timer / near the arena edge.
  private strafeDir = Math.random() < 0.5 ? 1 : -1;
  private strafeTimer = 1 + Math.random() * 1.5;

  constructor(difficulty: AIDifficulty = AIDifficulty.Medium, _classId = 'berserker') {
    this.config = { ...RANGED_CONFIGS[difficulty] };
  }

  getInput(): InputSystem {
    return this.input;
  }

  update(dt: number, self: CharacterController, opponent: CharacterController) {
    if (self.state.isDead) {
      this.input.releaseAction(Action.Fire);
      this.input.setStick(0, 0);
      return;
    }

    this.updateMovement(dt, self, opponent);

    // Reactive dodge — fire the scheduled evade once its lead timer elapses.
    if (this.pendingDodge !== null) {
      this.pendingDodge -= dt;
      if (this.pendingDodge <= 0) {
        this.input.triggerAction(Action.Dodge);
        this.pendingDodge = null;
      }
    }

    // Fire discipline — a duty cycle scaled by aggressiveness. Higher difficulty
    // holds the trigger a larger share of the time; easier bots pause (beatable).
    this.cycleTimer -= dt;
    if (this.cycleTimer <= 0) {
      this.firing = !this.firing;
      const a = this.config.aggressiveness;
      this.cycleTimer = this.firing ? 0.4 + a * 1.2 : (1 - a) * 1.5 + 0.2;
    }
    // No point holding the trigger mid-dodge (the sim blocks firing while dodging).
    if (this.firing && !self.state.isDodging) this.input.triggerAction(Action.Fire);
    else this.input.releaseAction(Action.Fire);
  }

  // Circle-strafe the opponent at a mid range so cover comes into play (a static
  // bot would just trade in the open). The stick is world-frame (the AI is fed
  // cameraYaw 0), so worldX→stick.x and worldZ→-stick.y.
  private updateMovement(dt: number, self: CharacterController, opponent: CharacterController) {
    if (self.state.isDodging) {
      this.input.setStick(0, 0); // the roll owns movement; don't fight it
      return;
    }

    const sx = self.state.position.x, sz = self.state.position.z;
    const ox = opponent.state.position.x, oz = opponent.state.position.z;
    let tx = ox - sx, tz = oz - sz;
    const range = Math.hypot(tx, tz) || 1;
    tx /= range; tz /= range;

    // Perpendicular = strafe; plus a range-keeping nudge toward/away (~10m ideal).
    let wx = -tz * this.strafeDir;
    let wz = tx * this.strafeDir;
    const rangeBias = Math.max(-1, Math.min(1, (range - 10) * 0.3)) * 0.7;
    wx += tx * rangeBias;
    wz += tz * rangeBias;

    // Steer back from the zone edge, and flip the strafe when cornered. The
    // zone centre/radius come from the controller config (missions fight in
    // zones away from the world origin).
    const [zcx, zcz] = self.config.arenaCenter;
    const ex = sx - zcx, ez = sz - zcz;
    const distC = Math.hypot(ex, ez);
    this.strafeTimer -= dt;
    if (distC > self.config.arenaRadius * 0.85) {
      wx += (-ex / (distC || 1)) * 1.3;
      wz += (-ez / (distC || 1)) * 1.3;
      this.strafeTimer = Math.min(this.strafeTimer, 0.15);
    }
    if (this.strafeTimer <= 0) {
      this.strafeDir *= -1;
      this.strafeTimer = 1.2 + Math.random() * 1.6;
    }

    const wlen = Math.hypot(wx, wz) || 1;
    const speed = 0.78;
    this.input.setStick((wx / wlen) * speed, -(wz / wlen) * speed);
  }

  /** Called by the sim when a shot is launched at this fighter — decide to evade. */
  onIncomingFire(timeToArrive: number, self: CharacterController) {
    if (self.state.isDead || self.state.isDodging || this.pendingDodge !== null) return;
    if (Math.random() >= this.config.dodgeChance) return;
    this.pendingDodge = Math.max(this.config.reactionTime, timeToArrive - DODGE_LEAD);
  }
}
