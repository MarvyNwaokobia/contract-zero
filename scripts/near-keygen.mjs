#!/usr/bin/env node
// Generate an ed25519 keypair for a NEAR account and write it straight to disk in the
// CLI's credentials format. Only the PUBLIC key is printed, so private keys never
// appear in a terminal, log or transcript.
//
// Usage: node scripts/near-keygen.mjs <account-id> <out-dir>
// Writes <out-dir>/<account-id>.json with mode 600 and refuses to overwrite.

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [account, outDir] = process.argv.slice(2);
if (!account || !outDir) {
  console.error('usage: near-keygen.mjs <account-id> <out-dir>');
  process.exit(2);
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = publicKey.export({ format: 'jwk' });
const priv = privateKey.export({ format: 'jwk' });
const pk = Buffer.from(pub.x, 'base64url');
const seed = Buffer.from(priv.d, 'base64url');
const publicKeyStr = `ed25519:${base58(pk)}`;
// NEAR's secret key format is the 64-byte seed‖public key.
const secretKeyStr = `ed25519:${base58(Buffer.concat([seed, pk]))}`;

mkdirSync(outDir, { recursive: true, mode: 0o700 });
const file = join(outDir, `${account}.json`);
if (existsSync(file)) {
  console.error(`refusing to overwrite ${file}`);
  process.exit(1);
}
writeFileSync(file, JSON.stringify({ account_id: account, public_key: publicKeyStr, private_key: secretKeyStr }, null, 2) + '\n', { mode: 0o600 });
console.log(publicKeyStr);
