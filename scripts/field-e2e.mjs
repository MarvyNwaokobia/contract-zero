#!/usr/bin/env node
// Mission integrity end to end, against the live API and NEAR testnet.
//
// The server settles a contract only from its own account of the run, built from the
// event stream (apps/api/src/services/protocol.rs). This script attacks that account
// and then plays one run legitimately:
//
//  - sites, conditions and the object list come with the contract;
//  - the loadout is checked against the ledger;
//  - a client-written record without a server-observed run settles nothing;
//  - teleporting, a clock ahead of the server, and a forged take taint the run;
//  - a replayed event is ignored, not re-applied;
//  - an unknown, finished or expired session accepts no events;
//  - death settles nothing;
//  - a legitimate partial extraction (walked at walking pace, E held on one case,
//    the countdown run in the zone) pays exactly that case, once, on chain.
//
// Usage: node scripts/field-e2e.mjs [apiUrl] [target]   (target: vanguard (default) or ashen, for Cinder Yard)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { client, loadKey, signIn } from './lib/cz-auth.mjs';

const API = process.argv[2] ?? 'http://127.0.0.1:8080';
const TARGET = process.argv[3] ?? 'vanguard';
const RPC = 'https://rpc.testnet.fastnear.com';
const ASSETS = 'assets.contract-zero.testnet';
const LAYOUTS = JSON.parse(readFileSync(new URL('../apps/api/src/services/layouts.json', import.meta.url), 'utf8'));
const key = loadKey(`${homedir()}/.contract-zero/keys/players-full/player.contract-zero.testnet.json`);
const PLAYER = key.accountId;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); log(ok ? 'PASS' : 'FAIL', name, detail); };

function dbUrl() {
  const env = readFileSync(new URL('../apps/api/.env', import.meta.url), 'utf8');
  return env.split('\n').find((l) => l.startsWith('DATABASE_URL='))?.slice('DATABASE_URL='.length);
}
const psql = (sql) => execFileSync('psql', [dbUrl(), '-tAc', sql], { encoding: 'utf8' }).trim();

async function bal(account, token, tries = 6) {
  for (;;) {
    try {
      const args = Buffer.from(JSON.stringify({ account_id: account, token_id: token })).toString('base64');
      const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: ASSETS, method_name: 'mt_balance_of', args_base64: args } }) })).json();
      return +JSON.parse(Buffer.from(r.result.result).toString());
    } catch (e) { if (--tries <= 0) throw e; await wait(5000); }
  }
}

const login = await signIn(API, PLAYER, key.keyPair);
if (login.status !== 200) throw new Error('sign-in failed');
const me = client(API, login.cookie);

async function start() {
  for (let i = 0; i < 30; i++) {
    const board = (await me.get('/board')).body.board;
    const e = board.find((b) => b.kind === 'raid' && b.target === TARGET) ?? board.find((b) => b.kind === 'raid');
    if (e) {
      const r = await me.post('/missions/start', { target: e.target, resource: e.resource, kind: 'raid' });
      if (r.status === 200) return { ...r.body, at: Date.now() };
      log('start refused, retrying:', r.status, r.body.error);
    }
    await wait(10_000);
  }
  throw new Error('no raid could be started');
}
const complete = (s, outcome, record) => me.post(`/missions/${s.session}/complete`, { outcome, kills: 4, record });

/** A scripted player that reports events in real time on its own clock. */
class Runner {
  constructor(s) { this.s = s; this.seq = 0; this.layout = LAYOUTS[s.mission.site.layout]; this.pos = [...this.layout.start]; }
  t() { return Date.now() - this.s.at; }
  async send(kind, extra = {}) {
    const ev = { seq: ++this.seq, t: this.t(), pos: this.pos.map((v) => +v.toFixed(2)), kind, ...extra };
    const r = await me.post(`/missions/${this.s.session}/events`, { events: [ev] });
    this.last = r.body;
    return r;
  }
  /** Walk to a point at 3 m/s, one heartbeat a second. */
  async walk(to) {
    for (;;) {
      const d = Math.hypot(to[0] - this.pos[0], to[1] - this.pos[1]);
      if (d < 0.05) return;
      const step = Math.min(d, 3);
      await wait(1000);
      this.pos = [this.pos[0] + ((to[0] - this.pos[0]) * step) / d, this.pos[1] + ((to[1] - this.pos[1]) * step) / d];
      await this.send('pos');
    }
  }
  async hold(object, secs, done) {
    await this.send('hold_start', { object });
    await wait(secs * 1000 + 150);
    return this.send(done, { object });
  }
}

// 1. Site, conditions and objects come with the contract.
const board = (await me.get('/board')).body;
check('board carries the clock', !!board.clock?.conditions?.phase, `${board.clock?.hour}:00 ${board.clock?.conditions?.phase}`);
check('each contract has a site', board.board.every((b) => b.site?.id), board.board.map((b) => `${b.kind}:${b.target}/${b.resource}→${b.site?.id}`).join(' '));

// 2. Loadout after the briefing, checked against the ledger.
let s = await start();
check('start opens an event-protocol session', s.protocol === 2 && s.mission.field.cases.length > 0, `${s.mission.field.cases.length} cases for ${s.mission.cargo.units} units at ${s.mission.site.name}`);
const unowned = await me.post(`/missions/${s.session}/loadout`, { gun: 'seraph_lmg' });
check('an unowned gun is refused at loadout', unowned.status === 400, unowned.body.error);
check('standard issue is accepted', (await me.post(`/missions/${s.session}/loadout`, { gun: 'smg' })).status === 200);

// 3. A client-written record, with no run behind it, settles nothing.
const forged = await complete(s, 'extracted', { secured: s.mission.field.cases.map((c) => c.id), charges: [], delivered: null, looted: [] });
check('a forged record without a run settles nothing', forged.body.result?.outcome === 'rejected' && forged.body.result.extracted_units === 0, forged.body.result?.reason);
check('a finished session takes no more events', (await new Runner(s).send('pos')).status === 400);

// 4. Impossible runs taint the session.
s = await start();
let r = new Runner(s);
r.pos = r.layout.cases[0];
await r.send('collect', { object: 'case-1' });
check('teleporting to the cargo taints the run', r.last.phase === 'tainted', r.last.taint);
const after = await complete(s, 'extracted');
check('a tainted run settles nothing', after.body.result?.outcome === 'rejected', after.body.result?.reason);

s = await start();
r = new Runner(s);
const ahead = await me.post(`/missions/${s.session}/events`, { events: [{ seq: 1, t: 600_000, pos: r.pos, kind: 'pos' }] });
check('a client clock ahead of the server taints the run', ahead.body.phase === 'tainted', ahead.body.taint);
await complete(s, 'killed');

// 5. Replays are ignored; unknown and expired sessions accept nothing.
s = await start();
r = new Runner(s);
await wait(1100);
await r.send('pos');
const dup = await me.post(`/missions/${s.session}/events`, { events: [{ seq: 1, t: r.t(), pos: r.pos, kind: 'pos' }] });
check('a replayed event is ignored, not re-applied', dup.body.verdicts?.[0]?.verdict.startsWith('ignored') && dup.body.phase === 'in_progress', dup.body.verdicts?.[0]?.verdict);
const ghost = await me.post(`/missions/00000000-0000-4000-8000-000000000000/events`, { events: [{ seq: 1, t: 0, pos: [0, 0], kind: 'pos' }] });
check('an unknown session accepts no events', ghost.status === 400, ghost.body.error);
psql(`UPDATE mission_sessions SET expires_at = now() - interval '1 second' WHERE id = '${s.session}'`);
const late = await r.send('pos');
check('an expired session accepts no events', late.status === 400 && /expired/.test(late.body.error), late.body.error);
const lateDone = await complete(s, 'extracted');
check('an expired session settles nothing', lateDone.body.result?.outcome === 'rejected', lateDone.body.result?.reason);

// 6. Death settles nothing.
s = await start();
const dead = await complete(s, 'killed');
check('death secures nothing', dead.body.result?.outcome === 'killed' && dead.body.result.extracted_units === 0);

// 7. A legitimate partial extraction, played at walking pace.
s = await start();
r = new Runner(s);
const res = s.mission.cargo.resource;
const case1 = s.mission.field.cases[0];
const chainBefore = await bal(PLAYER, res);
log(`legitimate run at ${s.mission.site.name}: walking in, holding E on ${case1.id} (${case1.units} units of ${s.mission.cargo.units}), extracting…`);
await r.walk(r.layout.entry); await r.send('reach', { milestone: 'entry' });
await r.walk(r.layout.push); await r.send('reach', { milestone: 'push' });
await r.walk(r.layout.cases[0]);
await r.hold(case1.id, 2.0, 'collect');
check('the server saw the case taken', r.last.carried?.includes(case1.id), JSON.stringify(r.last.carried));
await r.walk(r.layout.exfil.pos);
await r.send('extract_call');
await wait(8_300);
await r.send('extract_complete');
check('the server saw the extraction', r.last.phase === 'extracted', JSON.stringify(r.last.secured));
const ok = await complete(s, 'extracted');
const out = ok.body.result;
check('it settles exactly the carried case', out?.outcome === 'extracted' && out.extracted_units === case1.units, `${out?.extracted_units} of ${out?.manifest} ${res}${out?.reason ? ` (${out.reason})` : ''}`);
check('the bounty needs half the manifest', 2 * case1.units >= out.manifest || out.bounty === 0, `bounty ${out?.bounty}`);
const again = await complete(s, 'extracted');
check('a replayed completion settles nothing new', again.body.replayed === true && again.body.result.extracted_units === case1.units);
const events = +psql(`SELECT count(*) FROM mission_events WHERE session = '${s.session}'`);
check('every event is kept with its verdict', events === r.seq, `${events} events`);

// 8. On chain, exactly once.
const op = out.settlement?.op_id;
let st;
for (let i = 0; i < 120 && op; i++) {
  st = (await me.get(`/settlements/${encodeURIComponent(op)}`)).body;
  if (['confirmed', 'failed', 'compensated'].includes(st.status)) break;
  await wait(4000);
}
check('the settlement confirms on NEAR', st?.status === 'confirmed' && st.settled_on_chain, `${op} ${st?.status} ${st?.tx_hashes?.[0] ?? ''}`);
const chainAfter = await bal(PLAYER, res);
check('the player received exactly the carried units on chain', chainAfter - chainBefore === case1.units, `${res} ${chainBefore} → ${chainAfter}`);
check('one settlement row for the operation', +psql(`SELECT count(*) FROM settlements WHERE op_id = '${op}'`) === 1);

const failed = results.filter((x) => !x.ok);
log(`${results.length - failed.length}/${results.length} passed`);
console.log(JSON.stringify({ results, settlement: st ? { op_id: op, status: st.status, tx: st.tx_hashes, explorer: st.explorer } : null }, null, 2));
process.exit(failed.length ? 1 : 0);
