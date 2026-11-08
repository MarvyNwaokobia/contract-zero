// Typed client for the CONTRACT ZERO API (apps/api).
import type { ConvoyContract } from '@/engine/fps/convoy';

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

export interface BoardEntry {
  target: string;
  target_name: string;
  resource: ResourceName;
  manifest: number;
  defense: number;
  guards: GuardPlan;
  bounty: { id: number; sponsor: string; sponsor_name: string; amount: number; expires_at: number } | null;
  market_value: { bid: number; unit_bid: number };
  mission: ConvoyContract;
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
  actors: ActorView[];
  market: { insolvent: boolean; strategy: { margin_bp: number; spread_bp: number } };
  prices: PriceView[];
  board: BoardEntry[];
  flows: Record<string, { issued: number; destroyed: number; conserved: boolean }>;
}

export interface MissionStart { session: string; raid: number; min_secs: number; mission: ConvoyContract }

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

export interface PlayerQuote {
  id: number
  player: string
  resource: ResourceName
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
  trades: { id: number; tick: number; resource: ResourceName; side: 'buy' | 'sell'; qty: number; total: number }[]
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

export const api = {
  world: () => req<WorldView>('/world'),
  board: () => req<{ board: BoardEntry[] }>('/board').then((b) => b.board),
  player: (id: string) => req<{ player: string; holdings: Holdings; active_raid: number | null }>(`/players/${encodeURIComponent(id)}`),
  decisions: (limit = 30) => req<{ events: AgentEvent[] }>(`/events?kind=agent_decision&limit=${limit}`).then((e) => e.events),
  // The player is the signed-in session; the server never takes it from the body.
  startMission: (target: string, resource: ResourceName) =>
    req<MissionStart>('/missions/start', { method: 'POST', body: JSON.stringify({ target, resource }) }),
  settlement: (opId: string) => req<SettlementView>(`/settlements/${encodeURIComponent(opId)}`),
  completeMission: (session: string, outcome: 'extracted' | 'killed', kills: number) =>
    req<{ replayed: boolean; result: MissionResult }>(`/missions/${session}/complete`, { method: 'POST', body: JSON.stringify({ outcome, kills }) }),
  exchange: (player?: string | null) => req<ExchangeView>(`/exchange${player ? `?player=${encodeURIComponent(player)}` : ''}`),
  quote: (resource: ResourceName, side: 'buy' | 'sell', qty: number) =>
    req<QuoteCreated>('/exchange/quotes', { method: 'POST', body: JSON.stringify({ resource, side, qty }) }),
  quoteState: (id: number) => req<QuoteState>(`/exchange/quotes/${id}`),
  confirmQuote: (id: number, txHash?: string) => req<QuoteState>(`/exchange/quotes/${id}/confirm`, { method: 'POST', body: JSON.stringify({ tx_hash: txHash ?? null }) }),
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
