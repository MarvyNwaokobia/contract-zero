#!/usr/bin/env node
// Build CZ_KEYS_JSON (one secret holding every signing key the API needs) for a host
// with no key files. It REFUSES to write to a terminal: pipe it straight into the
// host's secret store, e.g.
//   railway variables --set "CZ_KEYS_JSON=$(node scripts/keys-json.mjs)"
// Reads ~/.contract-zero/keys/v3 (actor and server keys) and the relayer key.
// Only the key itself travels (account, public and private key); anything else in a
// key file, such as a wallet's seed phrase, stays on this machine.
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

if (process.stdout.isTTY) {
  console.error('refusing to print signing keys to a terminal; pipe this into your secret store');
  process.exit(2);
}
const out = {};
const add = (file) => {
  const k = JSON.parse(readFileSync(file, 'utf8'));
  const account = k.account_id ?? file.split('/').pop().replace(/\.json$/, '');
  if (!k.public_key?.startsWith('ed25519:') || !k.private_key?.startsWith('ed25519:')) throw new Error(`${file} is not an ed25519 key file`);
  out[account] = { account_id: account, public_key: k.public_key, private_key: k.private_key };
};
for (const sub of ['v3', 'relayer']) {
  const dir = `${homedir()}/.contract-zero/keys/${sub}`;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) add(`${dir}/${f}`);
}
process.stdout.write(JSON.stringify(out));
console.error(`CZ_KEYS_JSON: ${Object.keys(out).length} accounts (${Object.keys(out).join(', ')})`);
