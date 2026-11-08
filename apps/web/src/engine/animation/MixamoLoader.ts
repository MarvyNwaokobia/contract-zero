import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

// The clean shooter animation set — one clip per gameplay state the duel drives.
// Idle/walk/run/fire/dodge + two damage flinches (light, heavy — a crit reads as a
// heavy flinch) + death + victory. Everything melee was retired with the
// fighter→shooter pivot; see AnimationStateMachine for how these map to states.
export const CLIP_NAMES = {
  rifleIdle: 'rifleIdle',           // Idle — stand at the ready with the gun
  gunplayShooting: 'gunplayShooting', // Fire — one-shot muzzle animation
  walk: 'walk',                     // rifle-held walk (forward; reversed = backpedal)
  run: 'run',                       // rifle-held run
  strafeLeft: 'strafeLeft',         // sideways locomotion, soft-lock camera era
  strafeRight: 'strafeRight',
  reloading: 'reloading',           // mag change — plays while the sim reloads
  dodge: 'dodge',                   // Dodge — reactive roll / side-step
  hitReaction: 'hitReaction',       // HitLight — light flinch
  gettingHit: 'gettingHit',         // HitHeavy — heavier flinch (also crits)
  deathForward: 'deathForward',     // Death — the loser
  victory: 'victory',               // Victory — the winner
  // ── Verb era (CLONE_PLAN slice 6b): the blade + bare hands ──
  meleeHorizontal: 'meleeHorizontal', // armed strike 1 — wide horizontal cut
  hook: 'hook',                       // armed strike 2 — tight hooking swing
  melee360: 'melee360',               // armed strike 3 — full spinning low cut
  jumpAttack: 'jumpAttack',           // boss/big overhead leap
  crossPunch: 'crossPunch',           // unarmed strike 1
  hookPunch: 'hookPunch',             // unarmed strike 2
  comboPunch: 'comboPunch',           // unarmed strike 3
  throwObject: 'throwObject',         // the Edge leaves the hand
} as const;

const ALL_ANIMS: Record<string, string> = {
  [CLIP_NAMES.rifleIdle]: '/characters/raw/Rifle Idle.fbx',
  [CLIP_NAMES.gunplayShooting]: '/characters/raw/Gunplay Shooting.fbx',
  // NOTE: the Slim Shooter Pack's 'walking.fbx' / 'rifle run.fbx' fail in
  // FBXLoader ("Unknown property type") — pack-exported FBX variant. Keep the
  // known-good originals until rifle walk/run are re-downloaded INDIVIDUALLY
  // from Mixamo (individual downloads, like the strafes, parse fine).
  [CLIP_NAMES.walk]: '/characters/raw/Walking.fbx',
  [CLIP_NAMES.run]: '/characters/raw/Running.fbx',
  [CLIP_NAMES.strafeLeft]: '/characters/raw/Strafe Left.fbx',
  [CLIP_NAMES.strafeRight]: '/characters/raw/Strafe Right.fbx',
  [CLIP_NAMES.reloading]: '/characters/raw/Slim Shooter Pack/reloading.fbx',
  [CLIP_NAMES.dodge]: '/characters/raw/Dodging.fbx',
  [CLIP_NAMES.hitReaction]: '/characters/raw/Hit Reaction.fbx',
  [CLIP_NAMES.gettingHit]: '/characters/raw/Getting Hit.fbx',
  [CLIP_NAMES.deathForward]: '/characters/raw/Standing Death Forward 02.fbx',
  [CLIP_NAMES.victory]: '/characters/raw/Victory.fbx',
  [CLIP_NAMES.meleeHorizontal]: '/characters/raw/Standing Melee Attack Horizontal.fbx',
  [CLIP_NAMES.hook]: '/characters/raw/Hook.fbx',
  [CLIP_NAMES.melee360]: '/characters/raw/Standing Melee Attack 360 Low.fbx',
  [CLIP_NAMES.jumpAttack]: '/characters/raw/Jump Attack.fbx',
  [CLIP_NAMES.crossPunch]: '/characters/raw/Cross Punch.fbx',
  [CLIP_NAMES.hookPunch]: '/characters/raw/Hook Punch.fbx',
  [CLIP_NAMES.comboPunch]: '/characters/raw/Combo Punch.fbx',
  [CLIP_NAMES.throwObject]: '/characters/raw/Throw.fbx',
};

const allClips: Map<string, THREE.AnimationClip> = new Map();
let loadingPromise: Promise<void> | null = null;
let loadComplete = false;

/**
 * Per-clip locomotion measurements, taken from the Hips position track BEFORE it
 * is stripped for in-place playback. `groundSpeed` is the clip's baked horizontal
 * travel in clip-units per second at timeScale 1 — i.e. how fast the feet are
 * really moving. The locomotion blender uses it to lock the cycle cadence to the
 * body's ground speed so the feet stop skating. `hipY` is the mean hip height,
 * kept so callers can convert clip-units → world metres if the rigs differ.
 */
export interface ClipStride {
  groundSpeed: number;
  hipY: number;
}
const clipStride: Map<string, ClipStride> = new Map();

export function getClipStride(name: string): ClipStride | undefined {
  return clipStride.get(name);
}

// Reads the Hips position track and records the clip's baked horizontal stride
// speed + mean hip height under the friendly clip name. Called before the root
// track is stripped for in-place playback.
function measureRootStride(clip: THREE.AnimationClip, name: string): void {
  const hipsPos = clip.tracks.find(
    (t) => t.name.includes('Hips') && t.name.includes('position')
  );
  if (hipsPos) {
    const v = hipsPos.values; // [x,y,z, x,y,z, ...]
    const n = Math.floor(v.length / 3);
    if (n >= 2 && clip.duration > 0) {
      const x0 = v[0], z0 = v[2];
      const x1 = v[(n - 1) * 3], z1 = v[(n - 1) * 3 + 2];
      const horiz = Math.hypot(x1 - x0, z1 - z0);
      let sumY = 0;
      for (let i = 0; i < n; i++) sumY += v[i * 3 + 1];
      clipStride.set(name, {
        groundSpeed: horiz / clip.duration,
        hipY: sumY / n,
      });
    }
  }
}

// Conform a clip's bone-track name to the GLB rig's bone naming so PropertyBinding
// can actually find its target node.
//
// FBXLoader yields colon-less track names ("mixamorigHips.quaternion") and Mixamo
// sometimes numbers a duplicate skeleton ("mixamorig2Hips"). Critically, the GLB
// rigs are loaded by three's GLTFLoader, which runs every node through
// PropertyBinding.sanitizeNodeName — and that STRIPS the ":" out of Blender's
// "mixamorig:Hips", so the actual bone is named "mixamorigHips". The clip tracks
// must therefore be colon-LESS too; injecting a ":" (as this once did) makes
// PropertyBinding find no target node → not a single track binds → the rig sits at
// its bind pose = permanent T-pose. Normalize every mixamorig[N][:]Bone form to the
// colon-less "mixamorigBone" the rig uses. (Exported for the regression test that
// guards this binding contract.)
export function normalizeBoneTrackName(trackName: string): string {
  return trackName.replace(
    /^mixamorig\d*:?(\w)/,
    (_, first: string) => 'mixamorig' + first.toUpperCase(),
  );
}

function retargetClip(clip: THREE.AnimationClip, name: string): THREE.AnimationClip {
  // Name the clip up front so the stride map keys by the same friendly name the
  // state machine looks clips up under.
  clip.name = name;

  for (const track of clip.tracks) {
    track.name = normalizeBoneTrackName(track.name);
  }

  // Measure baked root travel before discarding it (used to kill foot-skate).
  measureRootStride(clip, name);

  clip.tracks = clip.tracks.filter(track => {
    if (track.name.includes('Hips') && track.name.includes('position')) {
      return false;
    }
    return true;
  });

  return clip;
}

export async function loadMixamoAnimations(): Promise<Map<string, THREE.AnimationClip>> {
  if (allClips.size > 0) return allClips;
  if (loadingPromise) {
    await loadingPromise;
    return allClips;
  }

  loadingPromise = (async () => {
    const loader = new FBXLoader();
    const entries = Object.entries(ALL_ANIMS);
    console.log(`[MixamoLoader] Loading ${entries.length} animations...`);

    await Promise.allSettled(
      entries.map(async ([name, path]) => {
        try {
          const group = await loader.loadAsync(path);
          if (group.animations.length > 0) {
            const clip = retargetClip(group.animations[0], name);
            allClips.set(name, clip);
          }
        } catch (e) {
          console.warn(`[MixamoLoader] Failed: ${name} — ${(e as Error).message}`);
        }
      })
    );

    const loco = [CLIP_NAMES.walk, CLIP_NAMES.run, CLIP_NAMES.strafeLeft, CLIP_NAMES.strafeRight]
      .filter((n) => clipStride.has(n));
    console.log(
      `[MixamoLoader] Loaded ${allClips.size}/${entries.length} animations` +
      (loco.length
        ? ` — root motion detected on: ${loco.join(', ')}`
        : ` — locomotion clips are in-place (no baked stride; cadence is speed-matched)`)
    );
    loadComplete = true;
  })();

  await loadingPromise;
  return allClips;
}

export function getMixamoClips(): Map<string, THREE.AnimationClip> {
  return allClips;
}

// True once every Mixamo FBX has finished loading. Consumers wait on this before
// binding the clip set, so a fighter never latches a half-loaded set (which left
// walk/run missing → the idle pose sliding across the floor).
export function isMixamoLoadComplete(): boolean {
  return loadComplete;
}
