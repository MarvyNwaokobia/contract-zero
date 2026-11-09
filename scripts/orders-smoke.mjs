// Live supply-order smoke test on testnet that nets to zero: Vanguard places a buy
// order (credits into escrow), Vex proposes, Vanguard cancels, the escrow returns.
// Signs with the scoped v3 function-call keys from ~/.contract-zero/keys/v3.
//   node scripts/orders-smoke.mjs
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from 'near-api-js';
const RPC = 'https://rpc.testnet.fastnear.com', WORLD = 'world2.contract-zero.testnet', ASSETS = 'assets.contract-zero.testnet';
const provider = new JsonRpcProvider({ url: RPC });
const acct = (name) => { const k = JSON.parse(readFileSync(`${homedir()}/.contract-zero/keys/v3/${name}.contract-zero.testnet.json`, 'utf8')); return new Account(k.account_id, provider, new KeyPairSigner(KeyPair.fromString(k.private_key))); };
const view = async (c, m, a) => { const r = await provider.callFunction({ contractId: c, method: m, args: a }); return r; };
const bal = (who, t) => view(ASSETS, 'mt_balance_of', { account_id: who, token_id: t });
const call = async (a, method, args) => { const r = await a.callFunctionRaw({ contractId: WORLD, methodName: method, args, gas: 200_000_000_000_000n }); return r.transaction.hash; };
const id = `smoke-${Date.now()}`;
const before = { v: await bal('vanguard.contract-zero.testnet', 'credits'), escrow: await bal(WORLD, 'credits') };
const v = acct('vanguard'), x = acct('vex');
const h1 = await call(v, 'place_order', { order_id: id, side: 'Buy', token_id: 'ammo', quantity: '5', limit_credits: '150', allow_partial: false, ttl_secs: 600 });
const placed = await view(WORLD, 'get_order', { order_id: id });
const mid = { v: await bal('vanguard.contract-zero.testnet', 'credits'), escrow: await bal(WORLD, 'credits') };
const h2 = await call(x, 'propose', { order_id: id, proposal_id: 'vex-1', quantity: '5', total_credits: '140', ttl_secs: 300 });
const prop = await view(WORLD, 'get_proposal', { order_id: id, proposal_id: 'vex-1' });
const h3 = await call(v, 'cancel_order', { order_id: id });
const closed = await view(WORLD, 'get_order', { order_id: id });
const after = { v: await bal('vanguard.contract-zero.testnet', 'credits'), escrow: await bal(WORLD, 'credits') };
console.log(JSON.stringify({ order: id, txs: { place: h1, propose: h2, cancel: h3 }, placed_state: placed.state, proposal: prop, closed: { state: closed.state, reason: closed.close_reason }, credits: { before, while_open: mid, after } }, null, 1));
