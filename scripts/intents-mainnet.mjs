#!/usr/bin/env node
// NEAR Intents mainnet acceptance (REAL FUNDS; run only with explicit approval).
//
// Swaps 0.1 NEAR (as wNEAR) for USDC through the official 1Click service, entirely on
// NEAR: the deposit is a plain wNEAR transfer to the quote's deposit address, and the
// USDC is delivered to the same account. Every protocol step goes through the game
// API's adapter, so the quote (correlation id, signature), the deposit and each status
// are stored (intents_quotes, intents_executions).
//
//   CZ_ADMIN_TOKEN=… node scripts/intents-mainnet.mjs [api] > evidence.json
// The API must run with NEAR_INTENTS_EXECUTION=mainnet-approved (capped by
// NEAR_INTENTS_MAX_USD, default $1). The key is the fresh mainnet account in
// ~/.contract-zero/keys/mainnet; it is never printed.

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from 'near-api-js';

const API = process.argv[2] ?? 'http://127.0.0.1:8080';
const ADMIN = process.env.CZ_ADMIN_TOKEN;
const RPC = process.env.NEAR_MAINNET_RPC ?? 'https://rpc.mainnet.fastnear.com';
const WNEAR = 'wrap.near';
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const AMOUNT = 100_000_000_000_000_000_000_000n; // 0.1 NEAR
const STORAGE = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR (NEP-145 minimum on both tokens)
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
if (!ADMIN) throw new Error('CZ_ADMIN_TOKEN is required');

const dir = `${homedir()}/.contract-zero/keys/mainnet`;
const file = readdirSync(dir).find((f) => f.endsWith('.json'));
const k = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
const provider = new JsonRpcProvider({ url: RPC });
const me = new Account(k.account_id, provider, new KeyPairSigner(KeyPair.fromString(k.private_key)));
const view = (c, m, a) => provider.callFunction({ contractId: c, method: m, args: a });
const call = async (contractId, methodName, args, deposit = 0n, gas = 50_000_000_000_000n) => {
  const r = await me.callFunctionRaw({ contractId, methodName, args, deposit, gas });
  const fail = r.status?.Failure ?? r.receipts_outcome?.map((x) => x.outcome.status?.Failure).find(Boolean);
  if (fail) throw new Error(`${contractId}.${methodName} failed: ${JSON.stringify(fail).slice(0, 300)} (tx ${r.transaction.hash})`);
  return r.transaction.hash;
};
const api = async (method, path, body) => {
  const r = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${j.error}`);
  return j;
};

const out = { network: 'mainnet', account: k.account_id, steps: [] };
const step = (name, data) => { out.steps.push({ name, ...data }); log(name, JSON.stringify(data)); };

const acct = await provider.viewAccount({ accountId: k.account_id });
step('funded', { near: (Number(BigInt(acct.amount) / 10n ** 21n) / 1000).toFixed(3) });
if (BigInt(acct.amount) < AMOUNT + 4n * STORAGE + 50_000_000_000_000_000_000_000n) throw new Error('fund the account with at least 0.2 NEAR first');

// 1. A live quote through the adapter (value-capped by the API).
const q = await api('POST', '/intents/quote', {
  execute: true, origin_asset: `nep141:${WNEAR}`, destination_asset: `nep141:${USDC}`, amount: AMOUNT.toString(),
  recipient: k.account_id, deposit_type: 'ORIGIN_CHAIN', recipient_type: 'DESTINATION_CHAIN', slippage_bps: 100,
});
const quote = q.quote;
step('quote', { correlation_id: quote.correlation_id, signature: quote.signature, amount_in: quote.amount_in, amount_out: quote.amount_out, min_amount_out: quote.min_amount_out, deposit_address: quote.deposit_address, deadline: quote.deadline, fees: quote.app_fees });
if (!quote.deposit_address) throw new Error('no deposit address: not a live quote');

// 2. Token storage: ours on both tokens, and the deposit address on wNEAR.
for (const [token, who] of [[WNEAR, k.account_id], [USDC, k.account_id], [WNEAR, quote.deposit_address]]) {
  const reg = await view(token, 'storage_balance_of', { account_id: who });
  if (reg) continue;
  const tx = await call(token, 'storage_deposit', { account_id: who, registration_only: true }, STORAGE);
  step('storage_deposit', { token, account: who, tx });
}

// 3. Wrap exactly the quoted input.
const amountIn = BigInt(quote.amount_in);
const wrapTx = await call(WNEAR, 'near_deposit', {}, amountIn);
step('wrap', { amount: amountIn.toString(), tx: wrapTx });

// 4. Deposit to the quote's address, before its deadline.
if (Date.parse(quote.deadline) <= Date.now()) throw new Error('quote expired before the deposit');
const usdcBefore = BigInt(await view(USDC, 'ft_balance_of', { account_id: k.account_id }));
const depTx = await call(WNEAR, 'ft_transfer', { receiver_id: quote.deposit_address, amount: amountIn.toString(), memo: `cz ${quote.correlation_id}` }, 1n, 30_000_000_000_000n);
step('deposit', { to: quote.deposit_address, amount: amountIn.toString(), tx: depTx });
const sub = await api('POST', '/intents/deposit', { deposit_address: quote.deposit_address, tx_hash: depTx, near_sender: k.account_id }).catch((e) => ({ error: e.message }));
step('deposit_submitted', sub);

// 5. Track execution to the end.
let st;
for (let i = 0; i < 90; i++) {
  st = await api('GET', `/intents/status/${quote.deposit_address}`).catch((e) => ({ status: 'ERROR', meaning: e.message }));
  if (i % 3 === 0) log('status', st.status, st.meaning);
  if (['SUCCESS', 'REFUNDED', 'FAILED'].includes(st.status)) break;
  await wait(5000);
}
step('final_status', { status: st.status, meaning: st.meaning, swap_details: st.raw?.swapDetails ?? null });

// 6. Verify what arrived.
const usdcAfter = BigInt(await view(USDC, 'ft_balance_of', { account_id: k.account_id }));
const received = usdcAfter - usdcBefore;
step('verified', { usdc_received: received.toString(), min_amount_out: quote.min_amount_out, at_least_minimum: received >= BigInt(quote.min_amount_out ?? '0') });
console.log(JSON.stringify(out, null, 2));
process.exit(st.status === 'SUCCESS' && received >= BigInt(quote.min_amount_out ?? '0') ? 0 : 1);
