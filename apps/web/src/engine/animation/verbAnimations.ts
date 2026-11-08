import { AnimState, type AnimationMap } from './AnimationStateMachine';
import { CLIP_NAMES } from './MixamoLoader';

/**
 * Animation maps for the VERB game (CLONE_PLAN slice 6b) — the blade-and-fists
 * combat that replaced the stat-duel. Kept separate from CLASS_ANIMATIONS so
 * the legacy shooter keeps its own table untouched.
 *
 * The armed melee string uses the machine's 'chain' pool: horizontal cut →
 * hook → spinning low cut, advancing per combo cancel exactly like the sim's
 * 3-stage string. Bare hands chain cross → hook → combo. Timings lean on the
 * sim's cadence (attack states canInterrupt so the next cancel takes over).
 */

const strafes = { left: CLIP_NAMES.strafeLeft, right: CLIP_NAMES.strafeRight };

function base(tempo: number): AnimationMap {
  return {
    [AnimState.Idle]: { clip: CLIP_NAMES.rifleIdle, loop: true, speed: tempo * 0.92, fadeIn: 0.2, fadeOut: 0.2, canInterrupt: true },
    [AnimState.Walk]: { clip: CLIP_NAMES.walk, clipsByMove: strafes, loop: true, speed: 1.0, fadeIn: 0.15, fadeOut: 0.15, canInterrupt: true },
    [AnimState.Run]: { clip: CLIP_NAMES.run, clipsByMove: strafes, loop: true, speed: tempo, fadeIn: 0.12, fadeOut: 0.12, canInterrupt: true },
    [AnimState.Dodge]: { clip: CLIP_NAMES.dodge, loop: false, speed: 1.45, fadeIn: 0.04, fadeOut: 0.1, duration: 0.45, canInterrupt: false, nextState: AnimState.Idle },
    [AnimState.HitLight]: { clip: CLIP_NAMES.hitReaction, loop: false, speed: 1.3, fadeIn: 0.04, fadeOut: 0.12, canInterrupt: true, nextState: AnimState.Idle },
    [AnimState.HitHeavy]: { clip: CLIP_NAMES.gettingHit, loop: false, speed: 1.05, fadeIn: 0.04, fadeOut: 0.16, canInterrupt: true, nextState: AnimState.Idle },
    [AnimState.Death]: { clip: CLIP_NAMES.deathForward, loop: false, speed: 1.0, fadeIn: 0.08, fadeOut: 0, canInterrupt: false },
    [AnimState.Victory]: { clip: CLIP_NAMES.victory, loop: false, speed: 1.0, fadeIn: 0.2, fadeOut: 0, canInterrupt: false },
  };
}

/** The hero: full verb set. */
export function heroAnimations(): AnimationMap {
  return {
    ...base(1.0),
    // Armed string — clip pool advances with the combo, mirroring sim stages.
    [AnimState.Attack]: {
      clip: CLIP_NAMES.meleeHorizontal,
      clips: [CLIP_NAMES.meleeHorizontal, CLIP_NAMES.hook, CLIP_NAMES.melee360],
      variant: 'chain',
      loop: false, speed: 1.6, fadeIn: 0.05, fadeOut: 0.1,
      canInterrupt: true, nextState: AnimState.Idle,
    },
    [AnimState.AttackUnarmed]: {
      clip: CLIP_NAMES.crossPunch,
      clips: [CLIP_NAMES.crossPunch, CLIP_NAMES.hookPunch, CLIP_NAMES.comboPunch],
      variant: 'chain',
      loop: false, speed: 1.7, fadeIn: 0.04, fadeOut: 0.08,
      canInterrupt: true, nextState: AnimState.Idle,
    },
    [AnimState.Throw]: {
      clip: CLIP_NAMES.throwObject,
      loop: false, speed: 1.9, fadeIn: 0.04, fadeOut: 0.1,
      canInterrupt: true, nextState: AnimState.Idle,
    },
  };
}

/** Troops: one strike voice per archetype so silhouettes read at a glance. */
export function enemyAnimations(archetype: 'rusher' | 'gunner' | 'bulwark'): AnimationMap {
  const strike =
    archetype === 'bulwark' ? CLIP_NAMES.melee360 :
    archetype === 'gunner' ? CLIP_NAMES.gunplayShooting :
      CLIP_NAMES.hook;
  return {
    ...base(archetype === 'bulwark' ? 0.85 : archetype === 'rusher' ? 1.1 : 1.0),
    [AnimState.Attack]: {
      clip: strike,
      loop: false, speed: archetype === 'bulwark' ? 1.1 : 1.4,
      fadeIn: 0.05, fadeOut: 0.12, canInterrupt: true, nextState: AnimState.Idle,
    },
  };
}

/** Cinder: heavier tempo, a strike voice per move (scene picks by move). */
export function bossAnimations(): AnimationMap {
  return {
    ...base(0.9),
    [AnimState.Attack]: {
      clip: CLIP_NAMES.hook,
      clips: [CLIP_NAMES.hook, CLIP_NAMES.meleeHorizontal],
      variant: 'chain',
      loop: false, speed: 1.4, fadeIn: 0.05, fadeOut: 0.12,
      canInterrupt: true, nextState: AnimState.Idle,
    },
    [AnimState.AttackUnarmed]: { // the ring slam: full spin
      clip: CLIP_NAMES.melee360,
      loop: false, speed: 1.2, fadeIn: 0.05, fadeOut: 0.12,
      canInterrupt: true, nextState: AnimState.Idle,
    },
    [AnimState.Throw]: { // ember toss
      clip: CLIP_NAMES.throwObject,
      loop: false, speed: 1.5, fadeIn: 0.05, fadeOut: 0.1,
      canInterrupt: true, nextState: AnimState.Idle,
    },
  };
}
