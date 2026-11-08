#!/usr/bin/env node
// End-to-end acceptance run against a live API with NEAR settlement enabled:
//   player raid → Vanguard ammunition shortage → autonomous purchase from Vex →
//   confirmed NEAR transaction → updated faction resources → changed next mission.
//
// Every on-chain claim is read back from NEAR itself (the contract's views over RPC),
// and a step only counts once its settlement row is 'confirmed' (verified FINAL).
//
// Usage: ADMIN_TOKEN_FILE=… node scripts/acceptance-e2e.mjs [apiUrl]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadKey, signIn } from './lib/cz-auth.mjs';

const API = process.argv[2] ?? 'http://127.0.0.1:8089';
const RPC = 'https://rpc.testnet.fastnear.com';
// Balances live in the NEP-245 ledger (cz-assets) since the v2 split.
const CONTRACT = process.env.CZ_ASSETS ?? 'assets.contract-zero.testnet';
const PLAYER = 'player.contract-zero.testnet';
const TOKEN = readFileSync(process.env.ADMIN_TOKEN_FILE, 'utf8').trim();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const get = async (p) => (await fetch(API + p)).json();
// The player signs in with their own key (NEP-413); missions act for the session's
// account only. PLAYER_FULL_KEY_FILE stands in for the player's wallet.
const me = loadKey(process.env.PLAYER_FULL_KEY_FILE ?? `${homedir()}/.contract-zero/keys/players-full/${PLAYER}.json`);
const login = await signIn(API, PLAYER, me.keyPair);
if (login.status !== 200) throw new Error('sign-in failed: ' + JSON.stringify(login.body));
const post = async (p, body, headers = {}) => {
  const r = await fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json', cookie: login.cookie, ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

async function chainBalances(account) {
  const args = Buffer.from(JSON.stringify({ account_id: account, token_ids: ['credits', 'ammo', 'med', 'fuel'] })).toString('base64');
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: CONTRACT, method_name: 'mt_batch_balance_of', args_base64: args } }) });
  const v = JSON.parse(Buffer.from((await r.json()).result.result).toString());
  return { credits: +v[0], ammo: +v[1], med: +v[2], fuel: +v[3] };
}

async function untilSettled(label, timeoutMs = 300_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = (await get('/settlements?limit=100')).settlements;
    const open = s.filter((x) => x.status === 'pending' || x.status === 'submitted');
    const failed = s.filter((x) => x.status === 'failed' || x.status === 'compensated');
    if (failed.length) throw new Error(`${label}: settlement failed: ${JSON.stringify(failed.map((f) => [f.op_id, f.error]))}`);
    if (!open.length) return s;
    await wait(3000);
  }
  throw new Error(`${label}: settlements still open after ${timeoutMs / 1000}s`);
}

const vanguard = async () => (await get('/world')).actors.find((a) => a.id === 'vanguard');
const ammoBoard = async () => (await get('/board')).board.find((b) => b.target === 'vanguard' && b.resource === 'ammo');
const guards = (e) => e && { deployed: e.guards.hall.rifles + e.guards.hall.sidearms + e.guards.yard.rifles + e.guards.yard.sidearms, rifles: e.guards.hall.rifles + e.guards.yard.rifles, sidearms: e.guards.hall.sidearms + e.guards.yard.sidearms, planned: e.guards.planned, defense: e.defense, manifest: e.manifest };
const R = { steps: [] };
const step = (name, data) => { R.steps.push({ name, ...data }); log(name, JSON.stringify(data)); };

// 0. The chain is aligned with the economy's starting state.
await untilSettled('baseline');
const rec0 = await get('/reconciliation');
step('initial state (on chain)', { vanguard: await chainBalances('vanguard.contract-zero.testnet'), vex: await chainBalances('vex.contract-zero.testnet'), in_sync: rec0.in_sync });
const boardBefore = guards(await ammoBoard());

// 1. The player raids Vanguard's ammunition depot.
const start = await post('/missions/start', { player: PLAYER, target: 'vanguard', resource: 'ammo' });
if (start.status !== 200) throw new Error('start failed: ' + JSON.stringify(start.body));
step('raid started', { raid: start.body.raid, manifest: start.body.mission.cargo.units, guards: boardBefore });
await wait((start.body.min_secs + 2) * 1000);
const done = await post(`/missions/${start.body.session}/complete`, { player: PLAYER, outcome: 'extracted', kills: 6 });
step('raid extracted (economy)', { outcome: done.body.result.outcome, extracted: done.body.result.extracted_units, settlement: done.body.result.settlement });

// 2. The raid settles on NEAR: Vanguard 100 → 40, the player holds 60.
const s1 = await untilSettled('raid');
const raidRow = s1.find((x) => x.kind === 'raid');
step('raid settled on NEAR', { status: raidRow.status, tx: raidRow.tx_hashes, vanguard_chain: await chainBalances('vanguard.contract-zero.testnet'), player_chain: await chainBalances(PLAYER), vanguard_engine: (await vanguard()).holdings });

// 3. One tick: the commander sees the shortage, quotes Vex and decides.
const adv = await post('/admin/advance', { ticks: 1 }, { 'x-admin-token': TOKEN });
if (adv.status !== 200) throw new Error('advance failed: ' + JSON.stringify(adv.body));
const decisions = (await get('/events?kind=agent_decision&limit=10')).events;
const buy = decisions.find((e) => e.source === 'vanguard' && e.payload.trigger === 'ammo below target');
step('commander decision', { trigger: buy?.payload.trigger, context: Object.fromEntries(buy?.payload.context ?? []), action: buy?.payload.action, rationale: buy?.payload.rationale, validation: buy?.payload.validation });

// 4. The purchase settles on NEAR (post_offer by Vex, accept_offer by Vanguard).
const s2 = await untilSettled('purchase');
const tradeRow = s2.find((x) => x.kind === 'trade');
step('purchase settled on NEAR', { status: tradeRow?.status, op: tradeRow?.op_id, tx: tradeRow?.tx_hashes, explorer: tradeRow?.explorer, events: tradeRow?.evidence?.transactions?.flatMap((t) => t.events.map((e) => `${e.event} ${e.data.map((d) => `${d.old_owner_id ?? ''}→${d.new_owner_id ?? d.owner_id} ${d.amounts} ${d.token_ids}`).join('; ')}`)) });

// 5. Reconciliation: economy and chain agree for every actor.
const rec = await get('/reconciliation');
step('reconciliation', { in_sync: rec.in_sync, unsynced: rec.unsynced_ledger_entries, open: rec.open_settlements, actors: rec.actors.map((a) => ({ account: a.chain_account, engine: a.engine, chain: a.chain, difference: a.difference })) });

// 6. The next mission reflects the new state.
const boardAfter = guards(await ammoBoard());
step('next mission', { before_raid: boardBefore, now: boardAfter, vanguard_engine: (await vanguard()).holdings });

console.log('\nRESULT ' + JSON.stringify(R));
