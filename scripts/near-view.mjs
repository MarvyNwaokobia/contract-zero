#!/usr/bin/env node
// Read-only NEAR testnet view call: node scripts/near-view.mjs <contract> <method> [json-args]
const [contract, method, args = '{}'] = process.argv.slice(2);
const r = await fetch(process.env.NEAR_RPC_URL ?? 'https://rpc.testnet.fastnear.com', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: Buffer.from(args).toString('base64') } }),
});
const j = await r.json();
if (!j.result?.result) { console.error(JSON.stringify(j.error ?? j.result)); process.exit(1); }
console.log(Buffer.from(j.result.result).toString());
