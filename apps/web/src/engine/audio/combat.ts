// Pure helpers for combat sound: where a round passed, how long a sound takes to arrive,
// how far is "distant", what an alarm sounds like at each level. No WebAudio here, so it is
// all unit-tested headlessly.

export type Vec3 = [number, number, number]

/** The closest a segment from→to comes to point p, and how far along it (0..1). */
export function closestApproach(from: Vec3, to: Vec3, p: Vec3): { dist: number; t: number; point: Vec3 } {
  const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]]
  const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - from[0]) * d[0] + (p[1] - from[1]) * d[1] + (p[2] - from[2]) * d[2]) / len2))
  const point: Vec3 = [from[0] + d[0] * t, from[1] + d[1] * t, from[2] + d[2] * t]
  return { dist: Math.hypot(p[0] - point[0], p[1] - point[1], p[2] - point[2]), t, point }
}

/** A round that passes within this many metres of the head is heard going by. */
export const NEAR_MISS_M = 2.5
/** 0..1: how loud the whiz is. 1 at the ear, 0 at the edge of the near-miss band. */
export const nearMissStrength = (dist: number) => Math.max(0, Math.min(1, 1 - dist / NEAR_MISS_M))

export const SPEED_OF_SOUND = 343
/** Seconds a sound takes to arrive, capped so a far shot still feels connected to its flash. */
export const propagationDelay = (dist: number, cap = 0.35) => Math.min(cap, Math.max(0, dist) / SPEED_OF_SOUND)

export type DistanceClass = 'near' | 'mid' | 'far'
export const NEAR_M = 12
export const FAR_M = 30
export function distanceClass(dist: number): DistanceClass {
  return dist < NEAR_M ? 'near' : dist < FAR_M ? 'mid' : 'far'
}

export type AlarmLevel = 1 | 2 | 3
export interface AlarmPattern { loHz: number; hiHz: number; periodS: number; gain: number; second: boolean }
/** Alarms escalate by getting faster, higher and fuller: 1 = alerted, 2 = fuse lit, 3 = final seconds. */
export function alarmPattern(level: AlarmLevel): AlarmPattern {
  return {
    1: { loHz: 520, hiHz: 780, periodS: 1.0, gain: 0.035, second: false },
    2: { loHz: 600, hiHz: 960, periodS: 0.62, gain: 0.042, second: false },
    3: { loHz: 700, hiHz: 1200, periodS: 0.34, gain: 0.05, second: true },
  }[level]
}

/** Seconds between a walker's steps. Faster movement, quicker cadence; clamped to a believable range. */
export const stepInterval = (speed: number) => Math.max(0.22, Math.min(0.7, 0.62 - speed * 0.09))
