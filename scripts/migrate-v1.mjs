#!/usr/bin/env node
// Snapshot the frozen v1 contract for the given holders, prove the snapshot is
// complete (per token, sum of holders == v1 mt_supply), and print the import entries.
// Usage: node scripts/migrate-v1.mjs <holder>...   (read-only)
const RPC = process.env.NEAR_RPC_URL ?? 'https://rpc.testnet.near.org';
const V1 = 'world.contract-zero.testnet';
const TOKENS = ['credits', 'ammo', 'med', 'fuel'];
async function view(contract, method, args) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }) });
  return JSON.parse(Buffer.from((await r.json()).result.result).toString());
}
const holders = process.argv.slice(2);
if (!(await view(V1, 'is_frozen', {}))) throw new Error('v1 is not frozen: refuse to snapshot');
const supply = (await view(V1, 'mt_batch_supply', { token_ids: TOKENS })).map(Number);
const entries = [];
const sums = TOKENS.map(() => 0);
for (const h of holders) {
  const b = (await view(V1, 'mt_batch_balance_of', { account_id: h, token_ids: TOKENS })).map(Number);
  b.forEach((v, i) => { sums[i] += v; if (v > 0) entries.push({ account_id: h, token_id: TOKENS[i], amount: String(v) }); });
}
const complete = TOKENS.every((_, i) => sums[i] === supply[i]);
console.log(JSON.stringify({ v1_supply: Object.fromEntries(TOKENS.map((t, i) => [t, supply[i]])), holder_sums: Object.fromEntries(TOKENS.map((t, i) => [t, sums[i]])), complete, entries }));
if (!complete) process.exit(1);
