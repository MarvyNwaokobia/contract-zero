#!/usr/bin/env node
// Sign-in and trading-session run against a live API on NEAR testnet.
//
//  1. Nothing that acts for a player works without a session; a supplied account id
//     is never accepted as proof.
//  2. Wallet sign-in (NEP-413): accepted for a full-access key; refused for replays,
//     limited keys, and keys that don't belong to the claimed account.
//  3. Trading session: the player adds a session key scoped to the game controller and
//     opens a session with budgets (the relayer pays that gas); then trades with NO
//     wallet prompt, the session key signing directly. The contract enforces the
//     budget; the relayer refuses trades and anything off its allow-list; the session
//     key signs itself out, after which it is powerless on chain.
//
// Usage: node scripts/auth-e2e.mjs [apiUrl]
//   PLAYER_FULL_KEY_FILE  the test player's full-access key (stands in for their wallet)
//   PLAYER_KEY_FILE       a limited key of the same player (must be refused for sign-in)
import { homedir } from 'node:os';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, encodeSignedDelegate } from 'near-api-js';
import { client, loadKey, signIn } from './lib/cz-auth.mjs';

const API = process.argv[2] ?? 'http://127.0.0.1:8080';
const RPC = 'https://rpc.testnet.fastnear.com';
const WORLD = 'world2.contract-zero.testnet';
const K = `${homedir()}/.contract-zero/keys`;
const full = loadKey(process.env.PLAYER_FULL_KEY_FILE ?? `${K}/players-full/player.contract-zero.testnet.json`);
const limited = loadKey(process.env.PLAYER_KEY_FILE ?? `${K}/players/player.contract-zero.testnet.json`);
const PLAYER = full.accountId;
const provider = new JsonRpcProvider({ url: RPC });

const R = { steps: [] };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const step = (name, data) => { R.steps.push({ name, ...data }); log(name, JSON.stringify(data)); };
const must = (c, m) => { if (!c) throw new Error(m); };
const anon = client(API);

async function nearBalance(account) {
  const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: account } }) })).json();
  return BigInt(r.result.amount);
}

async function view(contract, method, args) {
  const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }) })).json();
  return JSON.parse(Buffer.from(r.result.result).toString());
}

/** A quote for the signed-in player, reusing one that is still open. */
async function quote(api, resource, side, qty) {
  const x = await api.get(`/exchange?player=${PLAYER}`);
  if (x.body.open_quote) {
    const s = await api.get(`/exchange/quotes/${x.body.open_quote.id}`);
    const [kind, id] = s.body.chain_quote.split(':');
    const q = s.body.quote;
    const chain = kind === 'offer'
      ? { receiver_id: WORLD, method: 'accept_offer', args: { offer_id: id, max_total: String(q.total) }, gas: '60000000000000' }
      : { receiver_id: WORLD, method: 'accept_bid', args: { bid_id: id, min_total: String(q.total) }, gas: '60000000000000' };
    return { status: 200, body: { quote: q, chain, reused: true } };
  }
  return api.post('/exchange/quotes', { resource, side, qty });
}

/** Sign and send `action` directly with `key` (the chain sees that key as the signer). */
async function direct(key, receiverId, action) {
  const acct = new Account(PLAYER, provider, new KeyPairSigner(key));
  try {
    const r = await acct.signAndSendTransaction({ receiverId, actions: [action], waitUntil: 'FINAL', throwOnFailure: false });
    const fail = JSON.stringify(r.status?.Failure ?? r.receipts_outcome?.map((x) => x.outcome.status.Failure).filter(Boolean) ?? []);
    const ok = r.status?.SuccessValue !== undefined && Buffer.from(r.status.SuccessValue, 'base64').toString() === 'true';
    return { hash: r.transaction.hash, ok, fail };
  } catch (e) {
    return { hash: e.txHash ?? null, ok: false, fail: String(e.message ?? e) };
  }
}

/** Sign `action` on `receiverId` as a delegate action with `signerKey`; ask the API to relay it. */
async function relayed(api, signerKey, receiverId, action) {
  const acct = new Account(PLAYER, provider, new KeyPairSigner(signerKey));
  const { signedDelegate } = await acct.createSignedMetaTransaction({ receiverId, actions: [action], blockHeightTtl: 120 });
  return api.post('/relay/delegate', { signed_delegate: Buffer.from(encodeSignedDelegate(signedDelegate)).toString('base64') });
}

// ── 1. no session, no action ────────────────────────────────────────────────
for (const [p, b] of [['/exchange/quotes', { player: PLAYER, resource: 'med', side: 'buy', qty: 1 }], ['/missions/start', { player: PLAYER, target: 'vanguard', resource: 'ammo' }], ['/relay/delegate', { signed_delegate: 'AA==' }]]) {
  const r = await anon.post(p, b);
  must(r.status === 401, `${p} without a session returned ${r.status}`);
}
step('no session → refused', { endpoints: ['/exchange/quotes', '/missions/start', '/relay/delegate'], status: 401, note: 'a player id in the body is not proof' });

// ── 2. wallet sign-in ───────────────────────────────────────────────────────
const ok = await signIn(API, PLAYER, full.keyPair);
must(ok.status === 200 && ok.cookie, `sign-in failed: ${JSON.stringify(ok.body)}`);
const me = client(API, ok.cookie);
const s = await me.get('/auth/session');
must(s.status === 200 && s.body.account === PLAYER, 'session does not name the player');
step('wallet sign-in (NEP-413, full-access key)', { account: s.body.account, method: s.body.method, key: s.body.public_key, cookie: 'HttpOnly; SameSite=Lax' });

// Replay of the same signed challenge.
const replay = await fetch(`${API}/auth/wallet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account_id: PLAYER, public_key: full.keyPair.getPublicKey().toString(), signature: Buffer.from(ok.signature).toString('base64'), nonce: ok.challenge.nonce }) });
must(replay.status === 401, `replay: expected 401, got ${replay.status}`);
const lim = await signIn(API, PLAYER, limited.keyPair);
must(lim.status === 401, `limited key: expected 401, got ${lim.status} ${JSON.stringify(lim.body)}`);
const other = await signIn(API, 'vanguard.contract-zero.testnet', full.keyPair);
must(other.status === 401, `foreign account: expected 401, got ${other.status} ${JSON.stringify(other.body)}`);
step('sign-in refusals', { replayed_nonce: replay.status, limited_key: `${lim.status} ${lim.body.error}`, someone_elses_account: `${other.status} ${other.body.error}` });

const spoof = await me.post('/exchange/quotes', { player: 'vanguard.contract-zero.testnet', resource: 'med', side: 'buy', qty: 1 });
must(spoof.status === 403, `acting as another account returned ${spoof.status}`);
step('acting as another account', { status: spoof.status, error: spoof.body.error });

// ── 3. trading session ──────────────────────────────────────────────────────
const sessionKey = KeyPair.fromRandom('ed25519');
const pk = sessionKey.getPublicKey().toString();
const wallet = new Account(PLAYER, provider, new KeyPairSigner(full.keyPair));
// The player's own authority (their wallet) adds the scoped key…
const add = await wallet.signAndSendTransaction({ receiverId: PLAYER, actions: [actions.addFunctionCallAccessKey(sessionKey.getPublicKey(), WORLD, ['accept_offer', 'accept_bid', 'revoke_session'], 250_000_000_000_000_000_000_000n)], waitUntil: 'FINAL' });
step('session key added (player-signed AddKey, scoped to the controller)', { tx: add.transaction.hash, key: pk, methods: 'accept_offer, accept_bid, revoke_session' });
// …and opens the session with budgets, relayed (the relayer pays the gas; the player
// pays only the refundable 0.001 NEAR storage deposit).
const reg = await relayed(me, full.keyPair, WORLD, actions.functionCall('register_session', { public_key: pk, credit_budget: '120', unit_budget: '0', ttl_secs: 3600 }, 30_000_000_000_000n, 1_000_000_000_000_000_000_000n));
must(reg.status === 200 && reg.body.ok, `register_session relay failed: ${JSON.stringify(reg.body)}`);
const sess = await view(WORLD, 'get_session', { account_id: PLAYER, public_key: pk });
step('session opened (relayed)', { tx: reg.body.tx_hash, on_chain: sess });

// Trades are never relayed: in a meta-transaction the chain would see the relayer as
// the signer, so the API refuses before anything is submitted.
const qr = await quote(me, 'med', 'buy', 1);
must(qr.status === 200, `quote failed: ${JSON.stringify(qr.body)}`);
const cr = qr.body.chain;
const tr = await relayed(me, sessionKey, cr.receiver_id, actions.functionCall(cr.method, cr.args, BigInt(cr.gas), 0n));
must(tr.status === 401, `a relayed trade was accepted: ${JSON.stringify(tr.body)}`);
step('relayed trades are refused (signer would be the relayer)', { status: tr.status, error: tr.body.error });

// A trade inside the budget, signed directly by the session key: no wallet prompt.
const t1 = await direct(sessionKey, cr.receiver_id, actions.functionCall(cr.method, cr.args, BigInt(cr.gas), 0n));
must(t1.ok, `session trade failed: ${t1.fail}`);
const done1 = await me.post(`/exchange/quotes/${qr.body.quote.id}/confirm`, { tx_hash: t1.hash });
must(done1.body.status === 'settled' && done1.body.settled_on_chain, `not settled: ${JSON.stringify(done1.body)}`);
const left = await view(WORLD, 'get_session', { account_id: PLAYER, public_key: pk });
step('session-key trade (no wallet prompt), budget enforced by the contract', { quote: `${qr.body.quote.qty} med for ${qr.body.quote.total} cr`, tx: t1.hash, signer_key: pk, settled_on_chain: true, budget: `120 → ${left.credit_budget}` });

// Over budget: the contract refuses, whatever the client asks.
const q2 = await quote(me, 'med', 'buy', 1);
must(q2.status === 200, `quote failed: ${JSON.stringify(q2.body)}`);
const c2 = q2.body.chain;
must(q2.body.quote.total > Number(left.credit_budget), 'test needs a quote above the remaining budget');
const t2 = await direct(sessionKey, c2.receiver_id, actions.functionCall(c2.method, c2.args, BigInt(c2.gas), 0n));
must(!t2.ok && t2.fail.includes("over this session's credit budget"), `over-budget trade was not refused: ${t2.fail}`);
step('over-budget trade refused on chain', { quote_total: q2.body.quote.total, budget_left: left.credit_budget, tx: t2.hash, reason: "over this session's credit budget" });

// Off the allow-list: never submitted.
const t3 = await relayed(me, sessionKey, 'assets.contract-zero.testnet', actions.functionCall('mt_transfer', { receiver_id: 'vex.contract-zero.testnet', token_id: 'ammo', amount: '1' }, 30_000_000_000_000n, 1n));
must(t3.status === 401, `relayer accepted an off-list action: ${t3.status}`);
step('relayer refuses actions off its allow-list', { attempt: 'mt_transfer on cz-assets', status: t3.status, error: t3.body.error });

// The session key signs itself out (relayed: sign-out moves nothing); afterwards it
// is powerless on chain even though the key still exists.
const rv = await relayed(me, sessionKey, WORLD, actions.functionCall('revoke_session', { public_key: pk }, 30_000_000_000_000n, 0n));
must(rv.status === 200 && rv.body.ok, `revoke failed: ${JSON.stringify(rv.body)}`);
const q4 = await quote(me, 'med', 'buy', 1);
const c4 = q4.body.chain;
const t4 = await direct(sessionKey, c4.receiver_id, actions.functionCall(c4.method, c4.args, BigInt(c4.gas), 0n));
must(!t4.ok && t4.fail.includes('this session was revoked'), `revoked key still trades: ${t4.fail}`);
step('session revoked by its own key; key now powerless', { revoke_tx: rv.body.tx_hash, refused_tx: t4.hash, reason: 'this session was revoked', session: await view(WORLD, 'get_session', { account_id: PLAYER, public_key: pk }) });

// Tidy up: the player's wallet deletes the key.
const del = await wallet.signAndSendTransaction({ receiverId: PLAYER, actions: [actions.deleteKey(sessionKey.getPublicKey())], waitUntil: 'FINAL' });
step('session key deleted', { tx: del.transaction.hash });

const out = await me.post('/auth/logout');
const gone = await me.get('/auth/session');
must(gone.status === 401, 'session survived logout');
step('sign-out', { logout: out.status, session_after: gone.status });
console.log('\nRESULT', JSON.stringify(R));
