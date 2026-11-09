#!/usr/bin/env node
// Physical cargo end to end, against the live API and NEAR testnet:
//
//  - a contract carries its site, the hour's conditions and its object list;
//  - the loadout is chosen after the briefing and checked against the ledger;
//  - forged records are refused: an unknown case, the same case twice, no record;
//  - a run reported faster than its interactions physically take is refused;
//  - death settles nothing;
//  - a partial extraction pays exactly the cases carried out, once, and the
//    settlement confirms on chain with that amount.
//
// Usage: node scripts/field-e2e.mjs [apiUrl]
import { homedir } from 'node:os';
import { client, loadKey, signIn } from './lib/cz-auth.mjs';

const API = process.argv[2] ?? 'http://127.0.0.1:8080';
const RPC = 'https://rpc.testnet.fastnear.com';
const ASSETS = 'assets.contract-zero.testnet';
const key = loadKey(`${homedir()}/.contract-zero/keys/players-full/player.contract-zero.testnet.json`);
const PLAYER = key.accountId;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); log(ok ? 'PASS' : 'FAIL', name, detail); };

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
    const e = board.find((b) => b.kind === 'raid' && b.target === 'vanguard') ?? board.find((b) => b.kind === 'raid');
    if (e) {
      const r = await me.post('/missions/start', { target: e.target, resource: e.resource, kind: 'raid' });
      if (r.status === 200) return r.body;
      log('start refused, retrying:', r.status, r.body.error);
    }
    await wait(10_000);
  }
  throw new Error('no raid could be started');
}
const complete = (s, outcome, record) => me.post(`/missions/${s.session}/complete`, { outcome, kills: 4, record });

// 1. Site, conditions and objects come with the contract.
const board = (await me.get('/board')).body;
check('board carries the clock', !!board.clock?.conditions?.phase, `${board.clock?.hour}:00 ${board.clock?.conditions?.phase}`);
const raid = board.board.find((b) => b.kind === 'raid');
check('each contract has a site', board.board.every((b) => b.site?.id), board.board.map((b) => `${b.kind}:${b.target}/${b.resource}→${b.site?.id}`).join(' '));
check('the same contract stays at the same site', raid && raid.site.id === (raid.target === 'ashen' ? 'cinder-yard' : raid.resource === 'med' ? 'blacksite' : 'dustline-depot'));

// 2. Loadout after the briefing, checked against the ledger.
let s = await start();
const m = s.mission;
check('start returns the object list', m.field.cases.reduce((n, c) => n + c.units, 0) === m.cargo.units, `${m.field.cases.length} cases for ${m.cargo.units} units`);
const unowned = await me.post(`/missions/${s.session}/loadout`, { gun: 'seraph_lmg' });
check('an unowned gun is refused at loadout', unowned.status === 400, unowned.body.error);
const issued = await me.post(`/missions/${s.session}/loadout`, { gun: 'smg' });
check('standard issue is accepted', issued.status === 200);

// 3. Forgeries.
const dup = await complete(s, 'extracted', { secured: ['case-1', 'case-1'], charges: [], delivered: null, looted: [] });
check('the same case twice is refused', dup.body.result?.outcome === 'rejected', dup.body.result?.reason);
s = await start();
const fake = await complete(s, 'extracted', { secured: ['case-99'], charges: [], delivered: null, looted: [] });
check('a case that is not on site is refused', fake.body.result?.outcome === 'rejected', fake.body.result?.reason);
s = await start();
const none = await complete(s, 'extracted', undefined);
check('no record means nothing secured', none.body.result?.outcome === 'rejected' && none.body.result.extracted_units === 0, none.body.result?.reason);
s = await start();
const fast = await complete(s, 'extracted', { secured: s.mission.field.cases.map((c) => c.id), charges: [], delivered: null, looted: [] });
check('faster than the interactions take is refused', fast.body.result?.outcome === 'rejected', fast.body.result?.reason);

// 4. Death settles nothing, whatever was carried.
s = await start();
const dead = await complete(s, 'killed', { secured: ['case-1'], charges: [], delivered: null, looted: [] });
check('death secures nothing', dead.body.result?.outcome === 'killed' && dead.body.result.extracted_units === 0);

// 5. A partial extraction pays exactly the cases carried out.
s = await start();
const res = s.mission.cargo.resource;
const caseUnits = s.mission.field.cases[0].units;
const need = s.min_secs + 4;
log(`partial extraction: carrying case-1 (${caseUnits} units) of ${s.mission.cargo.units}; waiting ${need}s of mission time…`);
const chainBefore = await bal(PLAYER, res);
await wait(need * 1000);
const ok = await complete(s, 'extracted', { secured: ['case-1'], charges: [], delivered: null, looted: [s.mission.field.containers[0].id] });
const r = ok.body.result;
check('partial extraction settles the carried case only', r?.outcome === 'extracted' && r.extracted_units === caseUnits, `${r?.extracted_units} of ${r?.manifest} ${res}`);
check('the bounty needs half the manifest', 2 * caseUnits >= r.manifest || r.bounty === 0, `bounty ${r.bounty}`);
const again = await complete(s, 'extracted', { secured: s.mission.field.cases.map((c) => c.id), charges: [], delivered: null, looted: [] });
check('a replay returns the first result and settles nothing new', again.body.replayed === true && again.body.result.extracted_units === caseUnits);

// 6. On chain.
const op = r.settlement?.op_id;
let st;
for (let i = 0; i < 90 && op; i++) {
  st = (await me.get(`/settlements/${encodeURIComponent(op)}`)).body;
  if (['confirmed', 'failed', 'compensated'].includes(st.status)) break;
  await wait(4000);
}
check('the settlement confirms on NEAR', st?.status === 'confirmed' && st.settled_on_chain, `${op} ${st?.status} ${st?.tx_hashes?.[0] ?? ''}`);
const chainAfter = await bal(PLAYER, res);
check('the player received exactly the carried units on chain', chainAfter - chainBefore === caseUnits, `${res} ${chainBefore} → ${chainAfter}`);

const failed = results.filter((x) => !x.ok);
log(`${results.length - failed.length}/${results.length} passed`);
console.log(JSON.stringify({ results, settlement: st ? { op_id: op, status: st.status, tx: st.tx_hashes, explorer: st.explorer } : null }, null, 2));
process.exit(failed.length ? 1 : 0);
