// Typed client for the CONTRACT ZERO API (apps/api).
import type { ConvoyContract, SiteConditions, SiteRef } from '@/engine/fps/convoy';
import type { FieldRecord } from '@/engine/fps/field';
import type { MissionStory, StoryLine } from '@/engine/story/presence';

/** The API base URL. Sessions are a SameSite cookie, so in local development the API
 *  must be on the same site as the page: `localhost` and `127.0.0.1` are different
 *  sites to a browser, so a loopback API URL follows the page's own loopback form. */
function apiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';
  if (typeof window === 'undefined') return configured;
  try {
    const u = new URL(configured);
    const loopback = (h: string) => h === 'localhost' || h === '127.0.0.1';
    if (loopback(u.hostname) && loopback(window.location.hostname)) u.hostname = window.location.hostname;
    return u.toString().replace(/\/$/, '');
  } catch {
    return configured;
  }
}
export const API = apiBase();

export type ResourceName = 'ammo' | 'med' | 'fuel';

export interface Squad { rifles: number; sidearms: number }
export interface GuardPlan {
  planned: number;
  ammo_available: number;
  hall: Squad;
  yard: Squad;
  guard_hp: number;
  sidearm_damage_bp: number;
  reinforce_per_drop: number;
  reinforce_every_secs_x100: number;
}

export type OpKind = 'raid' | 'sabotage' | 'recovery';

export interface BoardEntry {
  kind: OpKind;
  /** The target's production of this resource is down (sabotaged). */
  disrupted: boolean;
  target: string;
  target_name: string;
  resource: ResourceName;
  manifest: number;
  defense: number;
  guards: GuardPlan;
  bounty: { id: number; sponsor: string; sponsor_name: string; amount: number; expires_at: number } | null;
  market_value: { bid: number; unit_bid: number };
  /** Where it happens. Absent from servers before sites. */
  site?: SiteRef;
  mission: ConvoyContract;
}

/** The server's account of a run, after a batch of mission events. */
export interface FieldVerdicts {
  phase: 'in_progress' | 'extracted' | 'tainted'; taint: string | null; carried: string[]; planted: string[]; secured: string[];
  milestones: string[]; last_seq: number; verdicts: { seq: number; verdict: string }[];
}

/** The world clock: one game hour is `tick_secs` real seconds. */
export interface WorldClock { tick: number; day: number; hour: number; tick_secs: number; conditions: SiteConditions }

/** A site and the production lines that are down there. */
export interface SiteStatus {
  id: string; name: string; owner: string; layout: string; shared_layout: boolean; environment: string;
  lines: { line: string; resource: ResourceName; down_until: number | null }[];
}

export interface Holdings { credits: number; ammo: number; med: number; fuel: number }

export interface ActorView {
  id: string;
  name: string;
  kind: 'faction' | 'merchant';
  holdings: Holdings;
  requirement: Record<ResourceName, number>;
  ammo_target: number;
  credit_reserve: number;
  defense: number;
  recent_raids: number;
}

export interface PriceView {
  resource: ResourceName;
  stock: number;
  price: { cost: number; stock: number; target: number; net_demand_24h: number; margin_bp: number; scarcity_bp: number; demand_bp: number; mid: number; ask: number; bid: number };
}

export interface WorldView {
  tick: number;
  day: number;
  hour: number;
  zone: string;
  clock?: WorldClock;
  sites?: SiteStatus[];
  actors: ActorView[];
  market: { insolvent: boolean; strategy: { margin_bp: number; spread_bp: number } };
  prices: PriceView[];
  board: BoardEntry[];
  flows: Record<string, { issued: number; destroyed: number; conserved: boolean }>;
}

export interface MissionStart { session: string; raid: number; min_secs: number; mission: ConvoyContract; story?: MissionStory }

export interface MissionResult {
  outcome: 'extracted' | 'killed' | 'rejected';
  reason: string | null;
  elapsed_secs: number;
  min_secs: number;
  raid: number;
  target: string;
  resource: ResourceName;
  extracted_units: number;
  bounty: number;
  player_holdings: { credits: number; cargo: number };
  /** Present when NEAR settlement is enabled. 'queued' here is NOT settlement. */
  settlement: { op_id: string; status: string } | null;
  kind?: OpKind;
  /** What the cargo was, and what the player reported doing (object ids). */
  manifest?: number;
  record?: FieldRecord | null;
  site?: SiteRef;
  /** The cast's account of what happened, written from the result. */
  debrief?: StoryLine[];
  codename?: string | null;
}

export interface SettlementView {
  op_id: string;
  kind: string;
  status: 'pending' | 'submitted' | 'confirmed' | 'failed' | 'compensated';
  settled_on_chain: boolean;
  tx_hashes: string[];
  explorer: string[];
  error: string | null;
}

export interface AgentEvent {
  seq: number;
  tick: number;
  source: string;
  kind: string;
  payload: {
    planner?: string;
    trigger?: string;
    context?: [string, number][];
    action?: Record<string, unknown> | null;
    rationale?: string;
    validation?: 'accepted' | 'rejected' | 'no_action';
    error?: string | null;
    [k: string]: unknown;
  };
}

export interface ExchangePrice {
  resource: ResourceName
  stock: number
  target: number
  ask: number
  bid: number
  mid: number
  scarcity_bp: number
  demand_bp: number
  net_demand_24h: number
  buy_10: number | null
  sell_10: number | null
}

export interface GearRef { id: string; title: string; token: string }
export interface ArmoryItem { id: string; title: string; token: string; list_price: number; price: number; stock: number; owned: number }
export interface FactionStanding { actor: string; name: string; jobs_for: number; earned_from: number; operations_against: number; units_taken: number; score: number; tier: string }
export interface Standing { vex_score: number; vex_tier: string; vex_discount_bp: number; vex_traded: number; factions: FactionStanding[] }
export interface Career {
  account: string
  totals: { operations: number; extracted: number; lost: number; units_moved: number; fees_earned: number }
  missions: { at: string; codename: string | null; outcome: string; kind: OpKind | null; target: string | null; resource: ResourceName | null; units: number | null; fee: number | null; secs: number | null; settlement: { op_id: string; status: string; settled_on_chain: boolean; explorer: string[] } | null }[]
  standing: Standing
  gear: { id: string; title: string; owned: number }[]
}

export interface PlayerQuote {
  id: number
  player: string
  resource: ResourceName
  /** A gun from Vex's armory (then `resource` is meaningless). */
  gear?: GearRef | null
  side: 'buy' | 'sell'
  qty: number
  total: number
  unit: number
  status: { status: 'open' | 'released' } | { status: 'settled'; trade: number }
}

export interface ExchangeView {
  tick: number
  settlement: 'near' | 'off_chain'
  quote_ttl_secs: number
  merchant: { id: string; name: string; insolvent: boolean; credits: number }
  prices: ExchangePrice[]
  shortages: { actor: string; name: string; resource: ResourceName; have: number; target: number; short: number }[]
  engine_holdings: Holdings | null
  chain_holdings: Holdings | null
  open_quote: PlayerQuote | null
  trades: { id: number; tick: number; resource: ResourceName; side: 'buy' | 'sell'; qty: number; total: number; gear?: string }[]
  armory?: ArmoryItem[]
  standing?: Standing | null
}

export interface QuoteCreated {
  quote: PlayerQuote
  expires_in_secs: number
  settled_on_chain: boolean
  posted?: { tx_hash: string; explorer: string }
  /** What the player's wallet signs (null when the economy runs off-chain). */
  chain: { receiver_id: string; method: string; args: Record<string, string>; gas: string; deposit: string } | null
}

export interface QuoteState {
  quote: PlayerQuote
  status: 'open' | 'settled' | 'released'
  chain_quote: string | null
  expires_in_secs: number
  settled_on_chain: boolean
  tx_hashes: string[]
  explorer: string[]
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API}${path}`, { credentials: 'include', ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
  return body as T;
}

// ── War Room ──

export interface WarActor {
  id: string; name: string; kind: 'faction' | 'merchant'; holdings: Holdings
  production: Record<ResourceName, number>; requirement: Record<ResourceName, number>
  credit_reserve: number; income_per_day: number; defense: number
  doctrine: { base_defense: number; max_price_mult: number; aggression: number }
  disrupted: { resource: ResourceName; until: number }[]
  recent_raids: number
  grudges: { player: string; raids: number; sabotage: number; recoveries: number; units_lost: number; last_tick: number }[]
  rivals: { sponsor: string; sponsor_name: string; bounties_paid: number; last_tick: number | null }[]
}
export interface WarConvoy { id: number; owner: string; owner_name: string; resource: ResourceName; units: number; defense: number; dispatched_at: number; arrives_at: number; progress: number; status: { state: string; by?: string } }
export interface WarContract { id: number; kind: OpKind; sponsor: string; sponsor_name: string; target: string; target_name: string; resource: ResourceName; amount: number; expires_at: number }
export interface WarPrice { resource: ResourceName; ask: number; bid: number; mid: number; stock: number; target: number }
export interface WarRoomView {
  world: { tick: number; day: number; hour: number; actors: WarActor[]; convoys: WarConvoy[]; contracts: WarContract[]; contracts_paid: number; prices: WarPrice[]; merchant_insolvent: boolean }
  history: { tick: number; prices: Record<ResourceName, { ask: number; bid: number; stock: number }>; holdings: Record<string, Holdings & { defense: number }> }[]
  broadcasts: { tick: number; actor: string; text: string; model: string }[]
  settlement: Record<string, number>
  planner: { configured: boolean; last_call: { tick: number; model: string; ok: boolean; latency_ms: number } | null }
}
export interface ChainTx { op_id?: string; kind?: string; status: string; settled_on_chain?: boolean; tx_hashes?: string[]; explorer?: string[]; error?: string | null; note?: string }
export interface CausalChain {
  seq: number; tick: number; kind: 'decision' | 'operation'; actor: string; actor_name: string
  trigger: string; observed: [string, unknown][] | null
  proposal: { planner: string; source?: string; action?: Record<string, unknown> | null; summary?: string; rationale: string | null }
  validation: { status: string; error: string | null; by: string }
  transactions?: ChainTx[]; transaction?: ChainTx
  world: string[]; gameplay: string[]
}
export interface SimulationView {
  simulated: true; note: string; ticks: number; conserved: boolean
  series: { tick: number; factions: Record<string, { holdings: Holdings; defense: number }>; merchant: Holdings; prices: Record<ResourceName, number>; shortages: number }[]
  decisions: { tick: number; actor: string; trigger: string; rationale: string; validation: string }[]
  simulated_raids: { id: number; resource: ResourceName; manifest: number; extracted: boolean }[]
}

export const api = {
  world: () => req<WorldView>('/world'),
  board: () => req<{ board: BoardEntry[] }>('/board').then((b) => b.board),
  player: (id: string) => req<{ player: string; holdings: Holdings; active_raid: number | null }>(`/players/${encodeURIComponent(id)}`),
  decisions: (limit = 30) => req<{ events: AgentEvent[] }>(`/events?kind=agent_decision&limit=${limit}`).then((e) => e.events),
  // The player is the signed-in session; the server never takes it from the body.
  startMission: (target: string, resource: ResourceName, kind: OpKind = 'raid', gun?: string) =>
    req<MissionStart>('/missions/start', { method: 'POST', body: JSON.stringify({ target, resource, kind, gun }) }),
  quoteGear: (gear: string) => req<QuoteCreated>('/exchange/quotes', { method: 'POST', body: JSON.stringify({ gear, side: 'buy', qty: 1 }) }),
  career: () => req<Career>('/me/career'),
  missionStory: (session: string) => req<{ story: MissionStory }>(`/missions/${session}/story`).then((r) => r.story),
  settlement: (opId: string) => req<SettlementView>(`/settlements/${encodeURIComponent(opId)}`),
  completeMission: (session: string, outcome: 'extracted' | 'killed', kills: number, record?: FieldRecord) =>
    req<{ replayed: boolean; result: MissionResult }>(`/missions/${session}/complete`, { method: 'POST', body: JSON.stringify({ outcome, kills, record }) }),
  /** The live mission event stream (services/protocol.rs on the server). */
  missionEvents: (session: string, events: unknown[]) =>
    req<FieldVerdicts>(`/missions/${session}/events`, { method: 'POST', body: JSON.stringify({ events }) }),
  /** Choose the weapon after the briefing; ownership is checked against the ledger. */
  missionLoadout: (session: string, gun: string) =>
    req<{ session: string; gun: string }>(`/missions/${session}/loadout`, { method: 'POST', body: JSON.stringify({ gun }) }),
  profile: () => req<{ account: string; method: string; provider: string | null; callsign: string | null; enlisted_at: string | null }>('/me/profile'),
  setProfile: (callsign: string) => req<{ callsign: string }>('/me/profile', { method: 'POST', body: JSON.stringify({ callsign }) }),
  exchange: (player?: string | null) => req<ExchangeView>(`/exchange${player ? `?player=${encodeURIComponent(player)}` : ''}`),
  quote: (resource: ResourceName, side: 'buy' | 'sell', qty: number) =>
    req<QuoteCreated>('/exchange/quotes', { method: 'POST', body: JSON.stringify({ resource, side, qty }) }),
  quoteState: (id: number) => req<QuoteState>(`/exchange/quotes/${id}`),
  confirmQuote: (id: number, txHash?: string) => req<QuoteState>(`/exchange/quotes/${id}/confirm`, { method: 'POST', body: JSON.stringify({ tx_hash: txHash ?? null }) }),
  warRoom: (hours = 96) => req<WarRoomView>(`/warroom?hours=${hours}`),
  timeline: (limit = 40) => req<{ chains: CausalChain[] }>(`/warroom/timeline?limit=${limit}`).then((t) => t.chains),
  simulate: (ticks: number, seed?: number, raidChancePct?: number) =>
    req<SimulationView>('/observer/simulate', { method: 'POST', body: JSON.stringify({ ticks, seed: seed ?? null, raid_chance_pct: raidChancePct ?? null }) }),
  acceptOffChain: (id: number) => req<QuoteState>(`/exchange/quotes/${id}/accept`, { method: 'POST' }),
};

// ── account id format (display/validation only: identity comes from the session) ──

/** Same rules the server applies (apps/api/src/handlers/missions.rs). */
export function validAccountId(id: string): boolean {
  if (id.length < 2 || id.length > 64) return false;
  if (!/^[a-z0-9._-]+$/.test(id)) return false;
  if (/^[._-]|[._-]$/.test(id) || /[._-]{2}/.test(id)) return false;
  return true;
}

/** A short, friendly label for an account: implicit (64-hex) accounts are shortened. */
export function accountLabel(id: string): string {
  return /^[0-9a-f]{64}$/.test(id) ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

export const RESOURCE_LABEL: Record<ResourceName, string> = { ammo: 'Ammunition', med: 'Medical supplies', fuel: 'Fuel' };
