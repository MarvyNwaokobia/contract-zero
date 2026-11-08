#!/usr/bin/env node
// Owned gear end to end on NEAR testnet: Vex's armory → a firm quote → the player
// signs accept_offer with their own key → the gun token lands in the player's
// account → the server lets them deploy with it, and refuses a gun they don't own.
//
// Usage: node scripts/gear-e2e.mjs [apiUrl] [gear]
import { homedir } from 'node:os';
import { Account, JsonRpcProvider, KeyPairSigner, actions } from 'near-api-js';
import { client, loadKey, signIn } from './lib/cz-auth.mjs';

const API = process.argv[2] ?? 'http://127.0.0.1:8080';
const GEAR = process.argv[3] ?? 'marksman';
const RPC = 'https://rpc.testnet.fastnear.com';
const ASSETS = 'assets.contract-zero.testnet';
const key = loadKey(`${homedir()}/.contract-zero/keys/players-full/player.contract-zero.testnet.json`);
const PLAYER = key.accountId;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const must = (c, m) => { if (!c) throw new Error(m); };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function bal(account, token, tries = 6) {
  try { return await balOnce(account, token) } catch (e) { if (tries <= 1) throw e; await wait(5000); return bal(account, token, tries - 1) }
}
async function balOnce(account, token) {
  const args = Buffer.from(JSON.stringify({ account_id: account, token_id: token })).toString('base64');
  const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: ASSETS, method_name: 'mt_balance_of', args_base64: args } }) })).json();
  return +JSON.parse(Buffer.from(r.result.result).toString());
}

const login = await signIn(API, PLAYER, key.keyPair);
must(login.status === 200, 'sign-in failed');
const me = client(API, login.cookie);

// The armory must be stocked on chain before Vex can sell (the restock mints
// through the next ledger batch).
const token = `gun:${GEAR}`;
for (let i = 0; i < 360 && (await bal('vex.contract-zero.testnet', token)) < 1; i++) {
  if (i === 0) log(`waiting for ${token} to reach Vex on chain…`);
  await wait(10_000);
}
const vexHas = await bal('vex.contract-zero.testnet', token);
must(vexHas >= 1, `Vex holds no ${token} on chain`);
const before = await bal(PLAYER, token);
const credits0 = await bal(PLAYER, 'credits');
log('armory', JSON.stringify((await me.get(`/exchange?player=${PLAYER}`)).body.armory));

// A gun the player doesn't own is refused at deployment.
const board = (await me.get('/board')).body.board;
const e = board.find((b) => b.kind === 'raid');
const unowned = ['marksman', 'ashfall_carbine', 'seraph_lmg'].find((g) => g !== GEAR);
const refused = await me.post('/missions/start', { target: e.target, resource: e.resource, kind: e.kind, gun: unowned });
log('deploy with an unowned gun →', refused.status, refused.body.error);

// Quote → player-signed accept_offer → confirm.
let q;
for (let i = 0; i < 12; i++) {
  q = await me.post('/exchange/quotes', { gear: GEAR, side: 'buy', qty: 1 });
  if (q.status === 200) break;
  log('quote refused, retrying:', q.status, q.body.error);
  await wait(10_000);
}
must(q.status === 200, `quote: ${JSON.stringify(q.body)}`);
log('quote', JSON.stringify(q.body.quote), 'posted', q.body.posted?.tx_hash);
const c = q.body.chain;
const wallet = new Account(PLAYER, new JsonRpcProvider({ url: RPC }), new KeyPairSigner(key.keyPair));
const tx = await wallet.signAndSendTransaction({ receiverId: c.receiver_id, actions: [actions.functionCall(c.method, c.args, BigInt(c.gas), 0n)], waitUntil: 'FINAL' });
log('player signed', c.method, tx.transaction.hash);
let st = (await me.post(`/exchange/quotes/${q.body.quote.id}/confirm`, { tx_hash: tx.transaction.hash })).body;
for (let i = 0; i < 10 && st.status === 'open'; i++) { await wait(3000); st = (await me.post(`/exchange/quotes/${q.body.quote.id}/confirm`, {})).body; }
must(st.status === 'settled' && st.settled_on_chain, `not settled: ${JSON.stringify(st)}`);
const after = await bal(PLAYER, token);
const credits1 = await bal(PLAYER, 'credits');
log(`on chain: ${PLAYER} ${token} ${before} → ${after}, credits ${credits0} → ${credits1}`);
must(after === before + 1, 'gun token did not arrive');
must(credits0 - credits1 === q.body.quote.total, 'wrong price on chain');

// Now the server lets them carry it in.
const ok = await me.post('/missions/start', { target: e.target, resource: e.resource, kind: e.kind, gun: GEAR });
log('deploy with the owned gun →', ok.status, ok.body.story?.codename ?? ok.body.error);
must(ok.status === 200, 'owned gun refused');
const done = await me.post(`/missions/${ok.body.session}/complete`, { outcome: 'killed', kills: 0 });
must(done.status === 200, 'could not close the session');
must(refused.status >= 400, 'unowned gun was accepted');
const career = (await me.get('/me/career')).body;
log('career', JSON.stringify({ totals: career.totals, standing: career.standing, gear: career.gear }));
console.log('OK');
