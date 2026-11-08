// Sign in to the CONTRACT ZERO API the way a wallet does: a NEP-413 signed message
// over a single-use server nonce, by a full-access key of the account. Returns a
// fetch wrapper that carries the session cookie.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { KeyPair } from 'near-api-js';

const NEP413_TAG = 2 ** 31 + 413;

function borshString(s) {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
}

/** SHA-256 of tag ++ borsh({message, nonce, recipient, callbackUrl: None}). */
export function nep413Hash(message, nonce, recipient) {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(NEP413_TAG);
  const payload = Buffer.concat([borshString(message), Buffer.from(nonce), borshString(recipient), Buffer.from([0])]);
  return createHash('sha256').update(Buffer.concat([tag, payload])).digest();
}

export function loadKey(file) {
  const k = JSON.parse(readFileSync(file, 'utf8'));
  return { accountId: k.account_id, keyPair: KeyPair.fromString(k.private_key) };
}

/** Sign a sign-in challenge with `keyPair` claiming `accountId`. Returns the raw response. */
export async function signIn(api, accountId, keyPair) {
  const ch = await (await fetch(`${api}/auth/challenge`, { method: 'POST' })).json();
  const nonce = Buffer.from(ch.nonce, 'base64');
  const { signature } = keyPair.sign(nep413Hash(ch.message, nonce, ch.recipient));
  const r = await fetch(`${api}/auth/wallet`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account_id: accountId, public_key: keyPair.getPublicKey().toString(), signature: Buffer.from(signature).toString('base64'), nonce: ch.nonce }),
  });
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  return { status: r.status, body: await r.json(), cookie, challenge: ch, signature };
}

/** A fetch bound to a session cookie. */
export function client(api, cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(api + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}) };
}
