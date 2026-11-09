// WCAG 2 A/AA checks (axe-core) on every page, signed in.
//   node probe-a11y.mjs [web] [api] [out.json]
import { chromium } from 'playwright';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { loadKey, signIn } from '../../scripts/lib/cz-auth.mjs';
const require = createRequire(import.meta.url);
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const WEB = process.argv[2] ?? 'http://127.0.0.1:3000';
const API = process.argv[3] ?? 'http://127.0.0.1:8080';
const OUT = process.argv[4];
const key = loadKey(`${homedir()}/.contract-zero/keys/players-full/player.contract-zero.testnet.json`);
const login = await signIn(API, key.accountId, key.keyPair);
const [name, value] = login.cookie.split('=');
const b = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addCookies([{ name, value, domain: new URL(API).hostname, path: '/' }]);
const report = {};
for (const path of ['/', '/contracts', '/exchange', '/war-room', '/training', '/settings', '/operator', '/signin', '/deploy?target=vanguard&resource=ammo&kind=raid']) {
  const p = await ctx.newPage();
  await p.goto(WEB + path, { waitUntil: 'networkidle', timeout: 120_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  await p.addScriptTag({ content: AXE });
  const r = await p.evaluate(async () => {
    const res = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, sample: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
  });
  report[path] = r;
  console.log(path, r.length ? r.map((v) => `${v.id}(${v.impact}) ×${v.nodes}`).join(', ') : 'clean');
  await p.close();
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
await b.close();
