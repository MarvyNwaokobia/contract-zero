// Which things at a site belong to which production line, so a line the economy says is down
// can be seen (and heard) to be down. The line names are the server's own (site.rs); the
// mapping from a line to the props that make it run is authored here, once, from the levels.
//
//   Dustline Depot   munitions line (ammunition): the munitions warehouse.   fuel depot: the motor pool's trucks.
//   Blacksite        server room (ammunition): the servers.                   APC motor bay (fuel): the trucks.
//   Cinder Yard      fractionation unit (fuel): the stack, the steam vents and the pumps.
//
// Where a line has no machinery of its own to idle (the munitions warehouse), it still gets an
// "offline" marker where its work is done, and its sounds are not made.

import type { Art, Box, LevelDef, LevelId } from './levels'

export type LineResource = 'ammo' | 'med' | 'fuel'

export interface WorldCues {
  tick: number
  lines_down: { resource: LineResource; line: string; until: number }[]
  deliveries: { resource: LineResource; units: number; arrives_at: number; state: 'arriving' | 'arrived' | string }[]
}

interface LineMap { boxKinds?: Box['kind'][]; artKinds?: Art['kind'][]; /** Where the marker stands when there is nothing to centre it on. */ fallback: 'cargo' | 'start' }

/** Per site, per resource, the props that run that line. Only lines the server names appear. */
export const LINE_MAP: Record<LevelId, Partial<Record<LineResource, LineMap>>> = {
  dustline_depot: { ammo: { fallback: 'cargo' }, fuel: { boxKinds: ['truck'], fallback: 'start' } },
  blacksite: { ammo: { boxKinds: ['server'], fallback: 'cargo' }, fuel: { boxKinds: ['truck'], fallback: 'start' } },
  cinder_yard: { fuel: { boxKinds: ['pump'], artKinds: ['steam', 'stack'], fallback: 'cargo' } },
}

export interface IdleLine { resource: LineResource; line: string; until: number; anchor: [number, number] }
export interface IdleProps {
  art: Set<Art>
  boxes: Set<Box>
  lines: IdleLine[]
}

export const NO_IDLE: IdleProps = { art: new Set(), boxes: new Set(), lines: [] }

const centroid = (pts: [number, number][]): [number, number] => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length]

/** The props that are idle because their line is down, and where to mark each line. */
export function idleProps(level: LevelDef, cues?: WorldCues | null): IdleProps {
  if (!cues || cues.lines_down.length === 0) return NO_IDLE
  const out: IdleProps = { art: new Set(), boxes: new Set(), lines: [] }
  for (const down of cues.lines_down) {
    const m = LINE_MAP[level.id]?.[down.resource]
    if (!m) continue // the server named a line this map has no props for: nothing is invented
    const boxes = [...level.walls, ...level.cover].filter((b) => m.boxKinds?.includes(b.kind))
    const art = level.art.filter((a) => m.artKinds?.includes(a.kind))
    boxes.forEach((b) => out.boxes.add(b)); art.forEach((a) => out.art.add(a))
    const pts = [...boxes.map((b) => [b.x, b.z] as [number, number]), ...art.map((a) => [a.x, a.z] as [number, number])]
    out.lines.push({ ...down, anchor: pts.length ? centroid(pts) : m.fallback === 'cargo' ? level.points.cargo : level.start })
  }
  return out
}

/** Whether a delivery is landing or has just landed (a truck is unloading). */
export const isDelivering = (cues?: WorldCues | null): boolean => !!cues && cues.deliveries.length > 0

/** Game hours as the war room writes them: "D3 10:00". */
export const worldClock = (tick: number) => `D${Math.floor(tick / 24)} ${String(tick % 24).padStart(2, '0')}:00`
