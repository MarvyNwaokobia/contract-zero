// The War Table's model: where things sit on the map and what is moving between them.
//
// Positions are a SCHEMATIC, not geography. The server knows three sites (Dustline Depot,
// Blacksite, Cinder Yard) and two merchants, never coordinates, so each gets a fixed slot
// on the table and the map says so. What is real is everything attached to a slot: who
// owns it, what it holds, what is short, which line is down, what is on the road.
//
// Shipments are stored as owner, resource, units, dispatch tick and arrival tick, and
// "from off-map". So a convoy travels from the table's edge to its owner's territory,
// at the progress the server computed from those ticks. It is a strategic transport
// marker, not vehicle telemetry, and never claims a specific depot as its destination.

import { convoyState } from './convoy'
import type { MarketMerchant, MarketOrder, ResourceName, SiteStatus, WarActor, WarConvoy, WarRoomView } from '@/lib/api'

export interface Pt { x: number; y: number }
export const TABLE_VIEW = { w: 760, h: 340 }
/** Where supply enters the table: the "off-map" origin of every shipment. */
/** How far below a lone facility's centre a route stops, clear of its icon. */
export const NODE_CLEARANCE = 40
export const OFF_MAP: Pt = { x: 712, y: 318 }

const SITE_SLOT: Record<string, Pt> = { 'dustline-depot': { x: 150, y: 225 }, blacksite: { x: 270, y: 85 }, 'cinder-yard': { x: 600, y: 110 } }
const MERCHANT_SLOT: Record<string, Pt> = { vex: { x: 370, y: 226 }, halcyon: { x: 520, y: 238 } }

export interface TableFacility {
  id: string
  kind: 'site' | 'exchange'
  name: string
  subtitle: string
  /** Faction or merchant id. */
  owner: string
  pos: Pt
  siteId?: string
}
export interface Territory { owner: string; name: string; anchor: Pt; facilityIds: string[] }
export interface TableConvoy {
  id: number; owner: string; ownerName: string; resource: ResourceName; units: number
  state: 'in_transit' | 'seized' | 'arrived' | 'other'; seizedBy?: string
  from: Pt; to: Pt; /** The route drawn: along the table's bottom edge, then up to the owner's territory. */ path: Pt[]; pos: Pt; progress: number; dispatchedAt: number; arrivesAt: number
}
export interface TableModel { facilities: TableFacility[]; territories: Territory[]; convoys: TableConvoy[]; offMap: Pt }

export interface TableInput {
  sites: SiteStatus[]
  war: Pick<WarRoomView['world'], 'actors' | 'convoys'>
  merchants?: MarketMerchant[]
}

const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y)

/** The point `t` (0..1) of the way along a polyline, by length. */
export function pointAlong(path: Pt[], t: number): Pt {
  const total = path.slice(1).reduce((s, p, i) => s + dist(path[i], p), 0)
  if (total === 0) return path[0]
  let left = Math.max(0, Math.min(1, t)) * total
  for (let i = 1; i < path.length; i++) {
    const seg = dist(path[i - 1], path[i])
    if (left <= seg || i === path.length - 1) {
      const k = seg === 0 ? 0 : Math.min(1, left / seg)
      return { x: path[i - 1].x + (path[i].x - path[i - 1].x) * k, y: path[i - 1].y + (path[i].y - path[i - 1].y) * k }
    }
    left -= seg
  }
  return path[path.length - 1]
}
const centroid = (ps: Pt[]): Pt => ({ x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length })

export function buildTable(input: TableInput): TableModel {
  const actors = new Map(input.war.actors.map((a) => [a.id, a]))
  const facilities: TableFacility[] = input.sites.map((s, i) => ({
    id: s.id, kind: 'site', name: s.name, subtitle: s.environment, owner: s.owner,
    pos: SITE_SLOT[s.id] ?? { x: 110 + i * 130, y: 40 }, siteId: s.id,
  }))
  // Merchants have no sites: each is its own facility on the exchange row.
  const merchants = input.war.actors.filter((a) => a.kind === 'merchant')
  merchants.forEach((m, i) => facilities.push({ id: `exchange:${m.id}`, kind: 'exchange', name: m.name, subtitle: 'Merchant', owner: m.id, pos: MERCHANT_SLOT[m.id] ?? { x: 380 + i * 110, y: 270 } }))

  const territories: Territory[] = []
  for (const owner of new Set(facilities.map((f) => f.owner))) {
    const mine = facilities.filter((f) => f.owner === owner)
    territories.push({ owner, name: actors.get(owner)?.name ?? owner, anchor: centroid(mine.map((f) => f.pos)), facilityIds: mine.map((f) => f.id) })
  }
  const anchor = (owner: string) => territories.find((t) => t.owner === owner)?.anchor

  const convoys: TableConvoy[] = []
  for (const c of input.war.convoys as WarConvoy[]) {
    const to = anchor(c.owner)
    if (!to) continue // an owner with nothing on the table has nowhere honest to draw to
    const { state, by } = convoyState(c.status)
    const progress = Math.max(0, Math.min(1, c.progress))
    // A seized convoy no longer travels: it sits with whoever took it.
    const seizerAnchor = state === 'seized' && by ? anchor(by) : undefined
    // Off-map supply runs along the bottom edge, then up to the owner: it never crosses another faction's facility.
    // A merchant is a single node: stop short of it so a nearly-delivered marker does not cover its icon.
    const lone = (territories.find((x) => x.owner === c.owner)?.facilityIds.length ?? 0) === 1
    const end: Pt = lone ? { x: to.x, y: to.y + NODE_CLEARANCE } : to
    const path: Pt[] = [OFF_MAP, { x: end.x, y: OFF_MAP.y }, end]
    const pos = state === 'in_transit' ? pointAlong(path, progress) : (seizerAnchor ?? to)
    convoys.push({ id: c.id, owner: c.owner, ownerName: c.owner_name, resource: c.resource, units: c.units, state, seizedBy: by, from: OFF_MAP, to, path, pos, progress, dispatchedAt: c.dispatched_at, arrivesAt: c.arrives_at })
  }
  return { facilities, territories, convoys, offMap: OFF_MAP }
}

/** Glyph slots for a supply gauge: `slots` equal parts of the target, filled by stock.
 *  Scalable by construction (never one object per unit); overflow is reported, not drawn. */
export function supplySlots(stock: number, target: number, slots = 6): { filled: number; slots: number; overflow: boolean; ratio: number } {
  const ratio = target > 0 ? stock / target : stock > 0 ? 1 : 0
  return { filled: Math.max(0, Math.min(slots, Math.round(ratio * slots))), slots, overflow: ratio > 1.25, ratio }
}

export type { WarActor, MarketOrder }
