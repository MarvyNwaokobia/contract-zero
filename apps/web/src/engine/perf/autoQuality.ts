/**
 * Auto quality: steps the graphics tier down when the frame rate can't hold.
 *
 * Feed it every frame's duration. Once a second it computes the frame rate; after a
 * warm-up (loading hitches don't count), `SLOW_SECONDS` consecutive seconds under
 * `FLOOR_FPS` step one tier down: high → medium → low. It never steps back up
 * during a session: oscillating between tiers is worse than either.
 */
export const FLOOR_FPS = 45;
export const SLOW_SECONDS = 3;
export const WARMUP_SECONDS = 3;

export type AutoLevel = 0 | 1 | 2; // high · medium · low

export class AutoQuality {
  level: AutoLevel;
  private acc = 0;
  private frames = 0;
  private slow = 0;
  private warm = WARMUP_SECONDS;
  /** The last measured frame rate (for readouts). */
  fps = 0;

  constructor(level: AutoLevel = 0) { this.level = level; }

  /** One frame. Returns the new level when it steps down, else null. */
  frame(dt: number): AutoLevel | null {
    this.acc += dt;
    this.frames += 1;
    if (this.acc < 1) return null;
    this.fps = this.frames / this.acc;
    this.acc = 0;
    this.frames = 0;
    if (this.warm > 0) { this.warm -= 1; return null; }
    this.slow = this.fps < FLOOR_FPS ? this.slow + 1 : 0;
    if (this.slow >= SLOW_SECONDS && this.level < 2) {
      this.level = (this.level + 1) as AutoLevel;
      this.slow = 0;
      this.warm = WARMUP_SECONDS; // let the new tier settle before judging it
      return this.level;
    }
    return null;
  }
}

/** Stored as cz_degraded: '1' (legacy) and 'low' are low, 'medium' is medium. */
export function readAutoLevel(v: string | null): AutoLevel {
  return v === '1' || v === 'low' ? 2 : v === 'medium' ? 1 : 0;
}
export function writeAutoLevel(l: AutoLevel): string | null {
  return l === 2 ? 'low' : l === 1 ? 'medium' : null;
}
