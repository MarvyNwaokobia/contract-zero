/**
 * The geometry the server needs to check a mission's events: where you start, the
 * objective points, where each object stands, and the extraction zones. Generated
 * from `levels.ts` into apps/api/src/services/layouts.json (`npm run export:layouts`);
 * a test fails if the two ever drift.
 */
import { LEVELS, type LevelId } from './levels'

export interface ServerLayout {
  start: [number, number]
  bounds: { min_x: number; max_x: number; min_z: number; max_z: number }
  entry: [number, number]
  push: [number, number]
  cases: [number, number][]
  seized: [number, number]
  charges: [number, number][]
  ammo: [number, number][]
  med: [number, number][]
  exfil: { pos: [number, number]; radius: number }
  handover: { pos: [number, number]; radius: number }
}

export function serverLayouts(): Record<LevelId, ServerLayout> {
  const out = {} as Record<LevelId, ServerLayout>
  for (const [id, lv] of Object.entries(LEVELS) as [LevelId, (typeof LEVELS)[LevelId]][]) {
    out[id] = {
      start: lv.start,
      bounds: { min_x: lv.bounds.minX, max_x: lv.bounds.maxX, min_z: lv.bounds.minZ, max_z: lv.bounds.maxZ },
      entry: lv.points.entry,
      push: lv.points.push,
      cases: lv.field.cases,
      seized: lv.field.seized,
      charges: lv.points.charges,
      ammo: lv.field.ammo,
      med: lv.field.med,
      exfil: { pos: lv.field.exfil.pos, radius: lv.field.exfil.radius },
      handover: { pos: lv.field.handover.pos, radius: lv.field.handover.radius },
    }
  }
  return out
}
