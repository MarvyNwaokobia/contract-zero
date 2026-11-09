// Licence audit of every third-party dependency that ships: the web app's production
// npm tree and the Rust crates of the API and the NEAR contracts.
//   node scripts/license-audit.mjs [out.json]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PERMISSIVE = /^(CDLA-Permissive-2\.0|MIT|ISC|BSD-2-Clause|BSD-3-Clause|0BSD|Apache-2\.0|Zlib|Unlicense|CC0-1\.0|BlueOak-1\.0\.0|Python-2\.0|Unicode-3\.0|Unicode-DFS-2016|BSL-1\.0|CC-BY-4\.0|MIT-0|OFL-1\.1)$/;
const WEAK_COPYLEFT = /^(MPL-2\.0|LGPL-2\.1|LGPL-3\.0|EPL-2\.0|CDLA-Permissive-2\.0)/;

function verdict(expr) {
  if (!expr) return 'unknown';
  const parts = expr.replace(/[()]/g, '').split(/\s+OR\s+/i);
  // An OR expression is fine if any alternative is permissive.
  for (const alt of parts) {
    const all = alt.split(/\s+AND\s+/i);
    if (all.every((l) => PERMISSIVE.test(l.trim()))) return 'permissive';
  }
  if (parts.some((p) => WEAK_COPYLEFT.test(p.trim()))) return 'weak-copyleft';
  return 'review';
}

// npm: the web app's production dependency tree.
const tree = JSON.parse(execFileSync('npm', ['ls', '--all', '--omit=dev', '--json', '--long'], { cwd: join(ROOT, 'apps/web'), encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }));
const npm = new Map();
(function walk(deps) {
  for (const [name, d] of Object.entries(deps ?? {})) {
    const key = `${name}@${d.version}`;
    if (npm.has(key) || !d.version || name.startsWith('@contract-zero/')) { walk(d.dependencies); continue; }
    let license = typeof d.license === 'string' ? d.license : d.license?.type;
    // No licence field: read the LICENSE file's first line (e.g. "MIT License").
    if (!license && d.path) {
      for (const f of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
        if (existsSync(join(d.path, f))) { const first = readFileSync(join(d.path, f), 'utf8').trim().split('\n')[0]; if (/^MIT License/i.test(first)) license = 'MIT'; break; }
      }
    }
    if (!license && d.path && existsSync(join(d.path, 'package.json'))) {
      const pj = JSON.parse(readFileSync(join(d.path, 'package.json'), 'utf8'));
      license = typeof pj.license === 'string' ? pj.license : pj.license?.type ?? pj.licenses?.map((l) => l.type).join(' OR ');
    }
    npm.set(key, { name, version: d.version, license: license ?? null, verdict: verdict(license) });
    walk(d.dependencies);
  }
})(tree.dependencies);

// Rust: crates of the API and the contracts.
const cargo = new Map();
import { readdirSync } from 'node:fs';
const crates = ['apps/api', ...readdirSync(join(ROOT, 'contracts-near')).map((d) => `contracts-near/${d}`)];
for (const dir of crates) {
  const manifest = existsSync(join(ROOT, dir, 'Cargo.toml')) ? join(ROOT, dir, 'Cargo.toml') : null;
  if (!manifest) continue;
  const meta = JSON.parse(execFileSync(`${process.env.HOME}/.cargo/bin/cargo`, ['+stable', 'metadata', '--format-version', '1', '--manifest-path', manifest], { encoding: 'utf8', maxBuffer: 1 << 28 }));
  const local = new Set(meta.workspace_members);
  for (const p of meta.packages) {
    if (local.has(p.id) || p.source == null) continue;
    cargo.set(`${p.name}@${p.version}`, { name: p.name, version: p.version, license: p.license ?? null, verdict: verdict(p.license?.replace(/\//g, ' OR ')) });
  }
}

const summary = (m) => {
  const by = {};
  for (const v of m.values()) by[v.verdict] = (by[v.verdict] ?? 0) + 1;
  return by;
};
const flagged = (m) => [...m.values()].filter((v) => v.verdict !== 'permissive');
const report = { npm: { total: npm.size, ...summary(npm), flagged: flagged(npm) }, cargo: { total: cargo.size, ...summary(cargo), flagged: flagged(cargo) } };
console.log(JSON.stringify({ npm: { total: npm.size, ...summary(npm) }, cargo: { total: cargo.size, ...summary(cargo) } }));
for (const f of [...report.npm.flagged, ...report.cargo.flagged]) console.log(`  ${f.verdict.padEnd(14)} ${f.name}@${f.version}  ${f.license}`);
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2));
