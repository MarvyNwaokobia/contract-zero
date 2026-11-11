// Everything the War Table says about one facility, assembled from real records.
// Nothing here is computed from a model of the world: it filters and joins what the
// server already returned, and leaves a field empty when there is no record.

import type { AgentEvent, BoardEntry, MarketOrder, OperationRecord, SiteStatus, WarActor, WarContract, WarConvoy, WorldView } from '@/lib/api'
import type { TableFacility } from './table'

export interface FacilityIntel {
  facility: TableFacility
  /** The faction or merchant that holds it. Stock is the owner's, shared across its sites. */
  owner: WarActor | undefined
  site: SiteStatus | undefined
  /** Production lines at this site, and whether each is down. */
  lines: SiteStatus['lines']
  /** Contracts the board offers here. */
  missions: BoardEntry[]
  /** Players deployed here right now. */
  activeOperations: number
  convoys: WarConvoy[]
  openOrders: MarketOrder[]
  contractsAgainst: WarContract[]
  /** Recent completed operations against the owner, newest first. */
  attacks: OperationRecord[]
  /** The owner's latest logged decision: what it is working on. */
  latestDecision: AgentEvent | undefined
}

export interface IntelInput {
  actors: WarActor[]
  convoys: WarConvoy[]
  contracts: WarContract[]
  world?: Pick<WorldView, 'sites' | 'board' | 'raids'>
  orders?: MarketOrder[]
  operations?: OperationRecord[]
  /** Newest first, as the server returns them. */
  decisions?: AgentEvent[]
}

export function facilityIntel(f: TableFacility, d: IntelInput): FacilityIntel {
  const site = f.siteId ? d.world?.sites?.find((s) => s.id === f.siteId) : undefined
  return {
    facility: f,
    owner: d.actors.find((a) => a.id === f.owner),
    site,
    lines: site?.lines ?? [],
    missions: f.siteId ? (d.world?.board ?? []).filter((e) => e.site?.id === f.siteId) : [],
    activeOperations: f.siteId ? (d.world?.raids ?? []).filter((r) => r.status.state === 'active' && r.plan.site === f.siteId).length : 0,
    convoys: d.convoys.filter((c) => c.owner === f.owner),
    openOrders: (d.orders ?? []).filter((o) => o.requester === f.owner && o.status.status === 'open'),
    contractsAgainst: d.contracts.filter((c) => c.target === f.owner),
    attacks: (d.operations ?? []).filter((o) => o.consequence.target === f.owner).slice(0, 3),
    latestDecision: (d.decisions ?? []).find((e) => e.source === f.owner || e.source === `agent:${f.owner}`),
  }
}
