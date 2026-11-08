#!/usr/bin/env node
// Sabotage (and, if the world offers one, recovery) end to end on NEAR testnet:
//   the world produces the contract (agents, not the script) → a signed-in player
//   runs the operation → the server settles it → the chain shows the consequence.
//
// Usage: ADMIN_TOKEN_FILE=… node scripts/operations-e2e.mjs [apiUrl]
//   The admin token only fast-forwards the world clock until a contract appears.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { client, loadKey, signIn } from './lib/cz-auth.mjs';

const API = process.argv[2] ?? 'http://127.0.0.1:8080';
const RPC = 'https://rpc.testnet.fastnear.com';
const ASSETS = 'assets.contract-zero.testnet';
const TOKEN = readFileSync(process.env.ADMIN_TOKEN_FILE, 'utf8').trim();
const key = loadKey(`${homedir()}/.contract-zero/keys/players-full/player.contract-zero.testnet.json`);
const PLAYER = key.accountId;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const must = (c, m) => { if (!c) throw new Error(m); };

async function chain(account) {
  const args = Buffer.from(JSON.stringify({ account_id: account, token_ids: ['credits', 'ammo', 'med', 'fuel'] })).toString('base64');
  const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: ASSETS, method_name: 'mt_batch_balance_of', args_base64: args } }) })).json();
  const v = JSON.parse(Buffer.from(r.result.result).toString());
  return { credits: +v[0], ammo: +v[1], med: +v[2], fuel: +v[3] };
}

const anon = client(API);
async function advance(ticks) {
  const r = await fetch(`${API}/admin/advance`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN }, body: JSON.stringify({ ticks }) });
  must(r.ok, `advance failed ${r.status}`);
}
async function settled(timeoutMs = 300_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = (await anon.get('/settlements?limit=50')).body.settlements;
    const open = s.filter((x) => x.status === 'pending' || x.status === 'submitted');
    const bad = s.filter((x) => x.status === 'failed');
    must(!bad.length, `settlement failed: ${JSON.stringify(bad.map((b) => [b.op_id, b.error]))}`);
    if (!open.length) return s;
    await wait(3000);
  }
  throw new Error('settlements still open');
}

async function findContract(kind, maxTicks) {
  for (let t = 0; t < maxTicks; t += 6) {
    const e = (await anon.get('/board')).body.board.find((b) => b.kind === kind);
    if (e) return e;
    await advance(6);
  }
  return null;
}

async function runOperation(me, e) {
  const vgBefore = await chain('vanguard.contract-zero.testnet');
  const pBefore = await chain(PLAYER);
  const vexBefore = await chain('vex.contract-zero.testnet');
  const start = await me.post('/missions/start', { target: e.target, resource: e.resource, kind: e.kind });
  must(start.status === 200, `start: ${JSON.stringify(start.body)}`);
  log(`${e.kind}: started`, JSON.stringify({ raid: start.body.raid, min_secs: start.body.min_secs, manifest: e.manifest, fee: e.bounty?.amount }));
  await wait((start.body.min_secs + 1) * 1000);
  const done = await me.post(`/missions/${start.body.session}/complete`, { outcome: 'extracted', kills: 3 });
  must(done.status === 200 && done.body.result.outcome === 'extracted', `complete: ${JSON.stringify(done.body)}`);
  log(`${e.kind}: completed`, JSON.stringify({ units: done.body.result.extracted_units, fee: done.body.result.bounty, settlement: done.body.result.settlement }));
  const rows = await settled();
  const op = rows.find((r) => r.op_id === `op:${start.body.raid}`);
  const vgAfter = await chain('vanguard.contract-zero.testnet');
  const pAfter = await chain(PLAYER);
  const vexAfter = await chain('vex.contract-zero.testnet');
  const rec = (await anon.get('/reconciliation')).body;
  return { op: op && { status: op.status, tx: op.tx_hashes, explorer: op.explorer }, vanguard: { before: vgBefore, after: vgAfter }, vex: { before: vexBefore, after: vexAfter }, player: { before: pBefore, after: pAfter }, result: done.body.result, in_sync: rec.in_sync, unsynced: rec.unsynced_ledger_entries };
}

const login = await signIn(API, PLAYER, key.keyPair);
must(login.status === 200, 'sign-in failed');
const me = client(API, login.cookie);
await settled();

const sab = await findContract('sabotage', 24 * 8);
must(sab, 'no sabotage contract appeared in 8 game days');
log('sabotage contract on the board', JSON.stringify({ target: sab.target_name, resource: sab.resource, destroys: sab.manifest, fee: sab.bounty?.amount, sponsor: sab.bounty?.sponsor_name }));
await settled();
const s = await runOperation(me, sab);
log('SABOTAGE', JSON.stringify(s, null, 1));
must(s.op?.status === 'confirmed', 'fee not confirmed on chain');
must(s.player.after.credits - s.player.before.credits === s.result.bounty, 'player not paid the fee on chain');
const board = (await anon.get('/board')).body.board;
log('after: is the line down?', JSON.stringify(board.filter((b) => b.resource === sab.resource).map((b) => ({ kind: b.kind, disrupted: b.disrupted }))));
const world = (await anon.get('/world')).body;
log('sabotage events', JSON.stringify((await anon.get('/events?limit=40')).body.events.filter((e) => JSON.stringify(e.payload).includes('production_disrupted')).slice(0, 1)));
console.log('\nDONE', world.tick);
