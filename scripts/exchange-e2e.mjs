#!/usr/bin/env node
// End-to-end Exchange run against a live API with NEAR settlement enabled:
//   the player sells raid cargo to Vex, buys supplies with the proceeds, and leaves
//   one quote to lapse, with every trade signed by the PLAYER's own key, exactly as
//   a wallet would sign it. The server never holds a player key.
//
// Every balance claim is read back from cz-assets over RPC, and every trade must
// leave engine and chain equal for the player and for Vex.
//
// Usage: node scripts/exchange-e2e.mjs [apiUrl]
//   PLAYER_KEY_FILE  a function-call key for the player, limited to world2's
//                    accept_offer / accept_bid (default ~/.contract-zero/keys/players/<player>.json)
//   LAPSE=1          also wait out a quote's TTL and check it is released (~6 min)
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Account, JsonRpcProvider } from 'near-api-js';

const API = process.argv[2] ?? 'http://127.0.0.1:8080';
const RPC = 'https://rpc.testnet.near.org';
const ASSETS = process.env.CZ_ASSETS ?? 'assets.contract-zero.testnet';
const PLAYER = process.env.PLAYER ?? 'player.contract-zero.testnet';
const VEX = 'vex.contract-zero.testnet';
const KEY = JSON.parse(readFileSync(process.env.PLAYER_KEY_FILE ?? `${homedir()}/.contract-zero/keys/players/${PLAYER}.json`, 'utf8'));
const player = new Account(PLAYER, new JsonRpcProvider({ url: RPC }), KEY.private_key);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const get = async (p) => (await fetch(API + p)).json();
const post = async (p, body) => {
  const r = await fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json() };
};
const R = { steps: [] };
const step = (name, data) => { R.steps.push({ name, ...data }); log(name, JSON.stringify(data)); };
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

async function chain(account) {
  const args = Buffer.from(JSON.stringify({ account_id: account, token_ids: ['credits', 'ammo', 'med', 'fuel'] })).toString('base64');
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: ASSETS, method_name: 'mt_batch_balance_of', args_base64: args } }) });
  const v = JSON.parse(Buffer.from((await r.json()).result.result).toString());
  return { credits: +v[0], ammo: +v[1], med: +v[2], fuel: +v[3] };
}

const same = (a, b) => ['credits', 'ammo', 'med', 'fuel'].every((k) => (a?.[k] ?? 0) === (b?.[k] ?? 0));

async function reconciledPlayer() {
  const x = await get(`/exchange?player=${PLAYER}`);
  return { engine: x.engine_holdings, chain: x.chain_holdings, equal: same(x.engine_holdings, x.chain_holdings) };
}

/** Quote → the player signs the acceptance → confirm. Returns the settled quote. */
async function trade(label, resource, side, qty) {
  const before = { player: await chain(PLAYER), vex: await chain(VEX) };
  const q = await post('/exchange/quotes', { player: PLAYER, resource, side, qty });
  must(q.status === 200, `${label}: quote refused: ${JSON.stringify(q.body)}`);
  const { quote, chain: c, posted } = q.body;
  step(`${label}: quote`, { id: quote.id, side, qty, resource, total: quote.total, posted_by_vex: posted.tx_hash, sign: `${c.method}(${JSON.stringify(c.args)})` });

  // The player's own signature: a function-call key that can call nothing but
  // accept_offer / accept_bid on the controller.
  const tx = await player.callFunctionRaw({ contractId: c.receiver_id, methodName: c.method, args: c.args, gas: BigInt(c.gas), deposit: 0n, waitUntil: 'FINAL' });
  const hash = tx.transaction_outcome?.id ?? tx.transaction?.hash;
  const result = tx.status?.SuccessValue !== undefined ? Buffer.from(tx.status.SuccessValue, 'base64').toString() : JSON.stringify(tx.status);
  step(`${label}: player signed`, { tx: hash, signer: PLAYER, final: result, explorer: `https://testnet.nearblocks.io/txns/${hash}` });
  must(result === 'true', `${label}: the controller callback did not report success: ${result}`);

  const done = await post(`/exchange/quotes/${quote.id}/confirm`, { tx_hash: hash });
  must(done.status === 200 && done.body.status === 'settled' && done.body.settled_on_chain, `${label}: not settled: ${JSON.stringify(done.body)}`);
  const after = { player: await chain(PLAYER), vex: await chain(VEX) };
  const sign = side === 'buy' ? 1 : -1;
  must(after.player[resource] - before.player[resource] === sign * qty, `${label}: player ${resource} moved wrong`);
  must(after.player.credits - before.player.credits === -sign * quote.total, `${label}: player credits moved wrong`);
  must(after.vex[resource] - before.vex[resource] === -sign * qty && after.vex.credits - before.vex.credits === sign * quote.total, `${label}: Vex moved wrong`);
  const rec = await reconciledPlayer();
  must(rec.equal, `${label}: player engine ≠ chain: ${JSON.stringify(rec)}`);
  step(`${label}: settled on NEAR`, { player_chain: `${JSON.stringify(before.player)} → ${JSON.stringify(after.player)}`, vex_chain: `${JSON.stringify(before.vex)} → ${JSON.stringify(after.vex)}`, player_engine_equals_chain: rec.equal });
  return { quote, hash };
}

// 0. Starting point: what the player owns on chain, and the market they see.
const x0 = await get(`/exchange?player=${PLAYER}`);
must(x0.settlement === 'near', 'the API is not settling on NEAR');
step('market', { prices: x0.prices.map((p) => `${p.resource}: ask ${p.ask} bid ${p.bid} stock ${p.stock}/${p.target}`), shortages: x0.shortages.map((s) => `${s.name} short ${s.short} ${s.resource}`) });
step('player holdings (chain)', { chain: x0.chain_holdings });

// 1. Sell raid cargo to Vex.
const sell = await trade('sell 30 ammo', 'ammo', 'sell', 30);
// 2. Spend the proceeds.
const medUnit = (await get('/exchange')).prices.find((p) => p.resource === 'med').ask;
const medQty = Math.max(1, Math.min(5, Math.floor((sell.quote.total * 0.9) / medUnit)));
await trade(`buy ${medQty} med`, 'med', 'buy', medQty);

// 3. Optional: a quote nobody accepts is released, on chain and in the engine.
if (process.env.LAPSE === '1') {
  const vexBefore = await chain(VEX);
  const q = await post('/exchange/quotes', { player: PLAYER, resource: 'fuel', side: 'buy', qty: 1 });
  must(q.status === 200, `lapse: quote refused: ${JSON.stringify(q.body)}`);
  step('lapse: quote left unsigned', { id: q.body.quote.id, ttl_secs: q.body.expires_in_secs });
  const end = Date.now() + (q.body.expires_in_secs + 120) * 1000;
  let s;
  while (Date.now() < end) {
    s = (await get(`/exchange/quotes/${q.body.quote.id}`));
    if (s.status !== 'open') break;
    await wait(10_000);
  }
  must(s?.status === 'released', `lapse: quote not released: ${JSON.stringify(s)}`);
  must(same(vexBefore, await chain(VEX)), 'lapse: Vex balances changed');
  step('lapse: released', { status: s.status, cancel_tx: s.tx_hashes?.slice(-1)[0], vex_unchanged: true });
}

// 4. Everything reconciles.
// With the world clock running, actors' production and consumption reach the chain
// in periodic flow batches, so a difference is legitimate only while ledger entries
// are still unsynced; the trades themselves were checked leg by leg above.
const rec = await get('/reconciliation');
step('reconciliation', { in_sync: rec.in_sync, unsynced_ledger_entries: rec.unsynced_ledger_entries, open_settlements: rec.open_settlements.length, actors: rec.actors.map((a) => `${a.chain_account}: ${JSON.stringify(a.difference)}`) });
must(rec.in_sync || rec.unsynced_ledger_entries > 0 || rec.open_settlements.length > 0, 'actors differ with nothing left to sync');
const p = await reconciledPlayer();
step('player', { engine: p.engine, chain: p.chain, equal: p.equal });
console.log('\nRESULT', JSON.stringify(R));
