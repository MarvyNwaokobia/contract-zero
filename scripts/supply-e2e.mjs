#!/usr/bin/env node
// Supply orders end to end, against the live API and NEAR testnet.
//
//   A. A player raids a faction's ammunition → its commander posts a supply order →
//      Vex and Halcyon each propose (or decline) → the commander picks one by its
//      rule → the order settles on world2 (place, proposals, fill) → the faction's
//      next mission is armed from the new stock.
//   B. The test player trades through the same market, chain-first: places an order in
//      their own name, waits for competing proposals on chain, accepts the best, and
//      the API applies it only after reading it back. Then the attacks: a replayed
//      confirmation, someone else's order, a fill that never happened, a cancel racing
//      an accept, and an order nobody answers that expires and refunds.
//   C. The official NEAR Intents adapter: a live dry quote, and a game asset refused.
//   Finally the economy and the chain reconcile exactly.
//
//   CZ_ADMIN_TOKEN=… node scripts/supply-e2e.mjs [api] [target]
// The admin token (optional) fast-forwards the world clock while waiting; it is read
// from the environment and never printed. Keys come from ~/.contract-zero.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Account, JsonRpcProvider, KeyPairSigner } from 'near-api-js';
import { client, loadKey, signIn } from './lib/cz-auth.mjs';

const API = process.argv[2] ?? 'http://127.0.0.1:8080';
const TARGET = process.argv[3] ?? 'ashen';
const RPC = 'https://rpc.testnet.fastnear.com', WORLD = 'world2.contract-zero.testnet', ASSETS = 'assets.contract-zero.testnet';
const ADMIN = process.env.CZ_ADMIN_TOKEN;
const provider = new JsonRpcProvider({ url: RPC });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const results = [];
const evidence = {};
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); log(ok ? 'PASS' : 'FAIL', name, typeof detail === 'string' ? detail : JSON.stringify(detail)); };
const dbUrl = () => readFileSync(new URL('../apps/api/.env', import.meta.url), 'utf8').split('\n').find((l) => l.startsWith('DATABASE_URL='))?.slice(13);
const psql = (sql) => execFileSync('psql', [dbUrl(), '-tAc', sql], { encoding: 'utf8' }).trim();
const view = (contract, method, args) => provider.callFunction({ contractId: contract, method, args });
const bal = async (who, token) => +(await view(ASSETS, 'mt_balance_of', { account_id: who, token_id: token }));
const advance = async (ticks = 1) => { if (!ADMIN) return wait(60_000 * ticks); await fetch(`${API}/admin/advance`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN }, body: JSON.stringify({ ticks }) }); };

const key = loadKey(`${homedir()}/.contract-zero/keys/players-full/player.contract-zero.testnet.json`);
const PLAYER = key.accountId;
const login = await signIn(API, PLAYER, key.keyPair);
if (login.status !== 200) throw new Error('sign-in failed');
const me = client(API, login.cookie);
const signer = new Account(PLAYER, provider, new KeyPairSigner(key.keyPair));
/** The player signs a world2 call with their own key (as a wallet would). */
const sign = async (methodName, args, gas = methodName === 'accept_proposal' ? 110_000_000_000_000n : 80_000_000_000_000n) => {
  try {
    const r = await signer.callFunctionRaw({ contractId: WORLD, methodName, args, gas });
    const fail = r.status?.Failure ?? r.receipts_outcome?.map((x) => x.outcome.status?.Failure).find(Boolean);
    return { hash: r.transaction.hash, ok: !fail, fail: fail ? JSON.stringify(fail).slice(0, 200) : null };
  } catch (e) { return { hash: null, ok: false, fail: String(e.message ?? e).slice(0, 200) }; }
};
const market = async () => (await me.get('/market')).body;
// Fast-forward only where asked: player orders carry wall-clock deadlines on chain, so
// racing the engine's clock ahead of them would expire them early in the game only.
const until = async (what, f, tries = 40, tick = false) => {
  for (let i = 0; i < tries; i++) {
    const v = await f();
    if (v) return v;
    if (tick && i % 3 === 2) await advance(1); else await wait(4000);
  }
  log(`gave up waiting for ${what}`);
  return null;
};
const stepsConfirmed = (o, prefixes) => prefixes.every((p) => o.settlement.some((s) => s.op_id.startsWith(p) && s.status === 'confirmed'));

// ── A. raid → shortage → competing proposals → settlement → next mission ─────
log(`A. raiding ${TARGET}'s ammunition…`);
const before = (await market()).orders.map((o) => o.id);
let start;
for (let i = 0; i < 20 && !start; i++) {
  const board = (await me.get('/board')).body.board;
  const e = board.find((b) => b.kind === 'raid' && b.target === TARGET && b.resource === 'ammo');
  if (e) {
    const r = await me.post('/missions/start', { target: TARGET, resource: 'ammo', kind: 'raid' });
    if (r.status === 200) start = { ...r.body, at: Date.now() };
    else log('start refused:', r.status, r.body.error);
  }
  if (!start) await advance(1);
}
check('a raid on the faction\'s ammunition starts', !!start, start ? `${start.mission.cargo.units} units at ${start.mission.site.name}` : 'no ammo raid on the board');
const LAYOUTS = JSON.parse(readFileSync(new URL('../apps/api/src/services/layouts.json', import.meta.url), 'utf8'));
if (start) {
  const lay = LAYOUTS[start.mission.site.layout];
  let seq = 0, pos = [...lay.start], last;
  const send = async (kind, extra = {}) => { const r = await me.post(`/missions/${start.session}/events`, { events: [{ seq: ++seq, t: Date.now() - start.at, pos: pos.map((v) => +v.toFixed(2)), kind, ...extra }] }); last = r.body; return r; };
  const walk = async (to) => { for (;;) { const d = Math.hypot(to[0] - pos[0], to[1] - pos[1]); if (d < 0.05) return; const s = Math.min(d, 3); await wait(1000); pos = [pos[0] + ((to[0] - pos[0]) * s) / d, pos[1] + ((to[1] - pos[1]) * s) / d]; await send('pos'); } };
  await walk(lay.entry); await send('reach', { milestone: 'entry' });
  await walk(lay.push); await send('reach', { milestone: 'push' });
  // Take every case (the faction loses its whole depot share).
  for (const [i, c] of start.mission.field.cases.entries()) {
    if (i >= 3) break; // carry limit
    await walk(lay.cases[i]);
    await send('hold_start', { object: c.id }); await wait(2_150); await send('collect', { object: c.id });
  }
  await walk(lay.exfil.pos); await send('extract_call'); await wait(8_300); await send('extract_complete');
  const done = (await me.post(`/missions/${start.session}/complete`, { outcome: 'extracted', kills: 4 })).body.result;
  check('the raid extracts and settles', done?.outcome === 'extracted' && done.extracted_units > 0, `${done?.extracted_units} of ${done?.manifest} ammo`);
  evidence.raid = { session: start.session, units: done?.extracted_units, op: done?.settlement?.op_id };
}

// The commander notices and asks the market.
const order = await until('the commander\'s supply order', async () => (await market()).orders.find((o) => !before.includes(o.id) && o.requester === TARGET && o.side === 'buy' && o.resource === 'ammo'), 40, true);
check('the commander posts a supply order (not a purchase from one merchant)', !!order, order ? `#${order.id}: ${order.qty} ammo, at most ${order.limit_total} cr, urgency ${order.urgency}` : '');
let filled;
if (order) {
  filled = await until('proposals, a choice and on-chain settlement', async () => {
    const o = (await market()).orders.find((x) => x.id === order.id);
    return o && o.fills.length > 0 && stepsConfirmed(o, [`order:${o.chain_id}`, `fill:${o.chain_id}|`]) ? o : null;
  }, 120);
  const chain = (await me.get('/warroom/procurement?limit=20')).body.chains.find((c) => c.order === order.id);
  const proposers = new Set(filled?.proposals.map((p) => p.merchant) ?? []);
  const answered = new Set(chain?.answers.map((a) => a.merchant) ?? []);
  check('both merchants considered the order', answered.has('vex') && answered.has('halcyon'), chain?.answers.map((a) => `${a.merchant}: ${a.proposed ? 'proposed' : 'declined'}`).join('; '));
  check('merchants proposed on chain', filled && filled.proposals.every((p) => filled.settlement.some((s) => s.op_id === `propose:${filled.chain_id}|${p.chain_proposal_id}` && s.status === 'confirmed')), [...proposers].join(', '));
  const choice = chain?.choices.find((c) => c.validation === 'accepted');
  check('the commander chose by its rule, and said why', !!choice && /urgent|routine/.test(choice.rationale), choice?.rationale);
  if (filled) {
    const onchain = await view(WORLD, 'get_order', { order_id: filled.chain_id });
    const delivered = filled.fills.reduce((a, f) => a + f.qty, 0), paid = filled.fills.reduce((a, f) => a + f.total, 0);
    check('the chain holds the same fills', +onchain.quantity - +onchain.remaining === delivered && +onchain.settled_credits === paid, `${delivered} ammo for ${paid} cr; on chain ${onchain.state} ${+onchain.quantity - +onchain.remaining}/${onchain.settled_credits}`);
    evidence.autonomous = { order: filled.chain_id, settlement: filled.settlement.map((s) => ({ op: s.op_id, tx: s.tx_hashes })), choice: choice?.rationale, next_mission: chain?.next_mission };
    check('the next mission is armed from the new stock', chain?.next_mission && chain.next_mission.rifles > 0, JSON.stringify(chain?.next_mission));
  }
}

// ── B. the player trades through the same market, chain-first ────────────────
log('B. the player places a supply order of their own…');
const medBefore = await bal(PLAYER, 'med');
const prep = (await me.post('/market/orders/prepare', { side: 'buy', resource: 'med', qty: 3, limit_total: 300, allow_partial: false, ttl_ticks: 20 })).body;
check('the API prepares the exact call to sign', prep.call?.method === 'place_order' && prep.call.args.order_id === prep.order_id, prep.order_id);
const placed = await sign('place_order', prep.call.args);
check('the player signs place_order with their own key', placed.ok, placed.hash ?? placed.fail);
let conf = await until('confirmation', async () => { const r = await me.post('/market/orders/confirm', { order_id: prep.order_id, tx_hash: placed.hash }); return r.status === 200 ? r : null; }, 8, false);
check('the API records it only after reading it back', conf?.status === 200, conf?.body);
const engineId = conf?.body.order;
const replay = await me.post('/market/orders/confirm', { order_id: prep.order_id, tx_hash: placed.hash });
check('a replayed confirmation is refused', replay.status === 409, replay.body.error);
const foreign = await me.post('/market/orders/confirm', { order_id: order?.chain_id ?? 'o1', tx_hash: null });
check("someone else's order can't be claimed", foreign.status === 403 || foreign.status === 400, foreign.body.error);
const mine = await until('proposals on chain', async () => {
  const o = (await market()).orders.find((x) => x.id === engineId);
  const ready = o?.proposals.filter((p) => p.status === 'pending' && o.settlement.some((s) => s.op_id === `propose:${o.chain_id}|${p.chain_proposal_id}` && s.status === 'confirmed'));
  return ready?.length ? { o, ready } : null;
}, 90);
check('trading partners answer the player on chain', !!mine, mine?.ready.map((p) => `${p.merchant_name} ${p.qty} for ${p.total}`).join(' vs '));
if (mine) {
  const best = [...mine.ready].sort((a, b) => a.total * b.qty - b.total * a.qty)[0];
  const early = await me.post(`/market/orders/${engineId}/accept`, { proposal: best.id });
  check('a fill the chain has not seen is refused', early.status === 409, early.body.error);
  const acc = await sign('accept_proposal', { order_id: mine.o.chain_id, proposal_id: best.chain_proposal_id });
  check('the player accepts the best offer on chain', acc.ok, acc.hash ?? acc.fail);
  const applied = await until('the API to apply the fill', async () => { const r = await me.post(`/market/orders/${engineId}/accept`, { proposal: best.id, tx_hash: acc.hash }); return r.status === 200 ? r : null; }, 8, false);
  check('the API applies it after reading the fill back', applied?.status === 200);
  const medAfter = await bal(PLAYER, 'med');
  check('the player received exactly the goods on chain', medAfter - medBefore === best.qty, `med ${medBefore} → ${medAfter}`);
  evidence.player_order = { order: mine.o.chain_id, place_tx: placed.hash, accept_tx: acc.hash, merchant: best.merchant, qty: best.qty, total: best.total };
}

log('B2. a cancel racing an accept…');
const prep2 = (await me.post('/market/orders/prepare', { side: 'buy', resource: 'ammo', qty: 4, limit_total: 200, allow_partial: false, ttl_ticks: 20 })).body;
const p2 = await sign('place_order', prep2.call.args);
const c2 = await until('confirmation', async () => { const r = await me.post('/market/orders/confirm', { order_id: prep2.order_id, tx_hash: p2.hash }); return r.status === 200 ? r : null; }, 8, false);
const id2 = c2?.body.order;
const ready2 = await until('a proposal on chain', async () => {
  const o = (await market()).orders.find((x) => x.id === id2);
  const p = o?.proposals.find((q) => q.status === 'pending' && o.settlement.some((s) => s.op_id === `propose:${o.chain_id}|${q.chain_proposal_id}` && s.status === 'confirmed'));
  return p ? { o, p } : null;
}, 90);
if (ready2) {
  const [x, y] = await Promise.all([sign('cancel_order', { order_id: ready2.o.chain_id }), sign('accept_proposal', { order_id: ready2.o.chain_id, proposal_id: ready2.p.chain_proposal_id })]);
  const onchain = await view(WORLD, 'get_order', { order_id: ready2.o.chain_id });
  check('exactly one of cancel and accept wins on chain', x.ok !== y.ok || (onchain.close_reason === 'cancelled') !== (onchain.fills > 0), `cancel ${x.ok ? 'ok' : 'refused'}, accept ${y.ok ? 'ok' : 'refused'}; chain ${onchain.state}/${onchain.close_reason} fills ${onchain.fills}`);
  const ca = await me.post(`/market/orders/${id2}/cancel`, { tx_hash: x.hash });
  const ac = await me.post(`/market/orders/${id2}/accept`, { proposal: ready2.p.id, tx_hash: y.hash });
  check('the economy mirrors only the winner', (ca.status === 200) !== (ac.status === 200), `cancel ${ca.status}, accept ${ac.status}`);
} else check('a proposal arrived for the race', false);

log('B3. an order nobody answers expires and refunds…');
const credBefore = await bal(PLAYER, 'credits');
const prep3 = (await me.post('/market/orders/prepare', { side: 'buy', resource: 'fuel', qty: 5, limit_total: 5, allow_partial: false, ttl_ticks: 1 })).body;
const p3 = await sign('place_order', prep3.call.args);
const c3 = await until('confirmation', async () => { const r = await me.post('/market/orders/confirm', { order_id: prep3.order_id, tx_hash: p3.hash }); return r.status === 200 ? r : null; }, 8, false);
check('a 1 cr/unit order is placed and escrowed', c3?.status === 200 && (await bal(PLAYER, 'credits')) === credBefore - 5);
const lapsed = await until('expiry on chain', async () => { const o = await view(WORLD, 'get_order', { order_id: prep3.order_id }); return o?.state === 'Closed' && o.close_reason === 'expired' ? o : null; }, 90);
check('no merchant answers below its floor, and it expires on chain', !!lapsed, lapsed?.close_reason);
check('the escrow came back exactly', (await bal(PLAYER, 'credits')) === credBefore, `${credBefore} → ${await bal(PLAYER, 'credits')}`);

// ── C. the official NEAR Intents adapter ─────────────────────────────────────
log('C. NEAR Intents (1Click, mainnet, read-only)…');
const ov = (await me.get('/intents')).body;
check('1Click is reachable and lists its assets', ov.reachable && ov.supported_assets > 0, `${ov.supported_assets} assets, execution ${ov.adapter.execution}`);
check('CONTRACT ZERO assets are not among them', ov.contract_zero_assets_supported === false);
const dq = await me.post('/intents/quote', { origin_asset: 'nep141:wrap.near', destination_asset: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', amount: '100000000000000000000000' });
check('a live dry quote returns its minimum and reference', dq.status === 200 && dq.body.quote.dry && !dq.body.quote.deposit_address && dq.body.quote.min_amount_out, `${dq.body.quote?.amount_out_formatted} USDC (min ${dq.body.quote?.min_amount_out}), ${dq.body.quote?.correlation_id}`);
check('the quote is kept with its protocol reference', +psql(`SELECT count(*) FROM intents_quotes WHERE correlation_id = '${dq.body.quote?.correlation_id}'`) === 1);
const cz = await me.post('/intents/quote', { origin_asset: 'nep245:assets.contract-zero.testnet:ammo', destination_asset: 'nep141:wrap.near', amount: '10' });
check('a game asset is refused before any request', cz.status === 422, cz.body.error);
evidence.intents = { correlation_id: dq.body.quote?.correlation_id, amount_out: dq.body.quote?.amount_out, min_amount_out: dq.body.quote?.min_amount_out, fees: dq.body.quote?.app_fees };

// ── reconciliation ───────────────────────────────────────────────────────────
const rec = await until('the settlement queue to drain', async () => { const r = (await me.get('/reconciliation')).body; return r.open_settlements.length === 0 ? r : null; }, 150);
check('economy and chain reconcile exactly', rec?.exact === true, rec ? rec.actors.filter((a) => Object.keys(a.difference_net_of_unsynced).length).map((a) => `${a.engine_account} ${JSON.stringify(a.difference_net_of_unsynced)}`).join('; ') || 'no differences' : 'queue did not drain');

const failed = results.filter((x) => !x.ok);
log(`${results.length - failed.length}/${results.length} passed`);
writeFileSync(process.env.OUT ?? '/dev/stdout', JSON.stringify({ results, evidence }, null, 2) + '\n');
process.exit(failed.length ? 1 : 0);
