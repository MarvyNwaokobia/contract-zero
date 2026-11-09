// The pages around the fight: the world clock on the Hub and the board, contract
// intel before the loadout (signed in), and every Training mode: Practice (with
// its selector), Endless, and the Campaign's extraction zone.
//
//   node probe-modes.mjs [web] [api] [outdir]
import { chromium } from 'playwright';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { loadKey, signIn } from '../../scripts/lib/cz-auth.mjs';

const WEB = process.argv[2] ?? 'http://127.0.0.1:3000';
const API = process.argv[3] ?? 'http://127.0.0.1:8080';
const OUT = process.argv[4] ?? './modes-out';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { checks: {}, errors: [] };
const ok = (k, v) => { out.checks[k] = v; console.log(k, JSON.stringify(v)); };

const key = loadKey(`${homedir()}/.contract-zero/keys/players-full/player.contract-zero.testnet.json`);
const login = await signIn(API, key.accountId, key.keyPair);
const [name, value] = login.cookie.split('=');

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addCookies([{ name, value, domain: new URL(API).hostname, path: '/' }]);
const page = await ctx.newPage();
page.on('pageerror', (e) => out.errors.push(String(e)));

// Hub and board: the clock.
await page.goto(`${WEB}/`);
await page.waitForSelector('[data-testid=world-clock]', { timeout: 120_000 });
ok('hub_clock', await page.locator('[data-testid=world-clock]').first().innerText());
await page.screenshot({ path: `${OUT}/hub.png` });
await page.goto(`${WEB}/contracts`);
await page.waitForSelector('[data-testid=world-clock]', { timeout: 60_000 });
await sleep(800);
ok('board_sites', await page.locator('section.cz-panel .cz-label').allInnerTexts().then((t) => t.filter((x) => /·/.test(x)).slice(0, 6)));
await page.screenshot({ path: `${OUT}/board.png`, fullPage: true });

// Contract intel, before any loadout.
const href = await page.locator('a', { hasText: 'View intel' }).first().getAttribute('href');
await page.goto(`${WEB}${href}`);
await page.waitForSelector('[data-testid=operation-intel]', { timeout: 60_000 });
ok('intel', {
  site: await page.locator('[data-testid=intel-site]').innerText(),
  phase: await page.locator('[data-testid=intel-phase]').innerText(),
  objectives: (await page.locator('[data-testid=intel-objectives] li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')),
  resistance: await page.locator('[data-testid=intel-resistance]').innerText(),
  rewards: await page.locator('[data-testid=intel-rewards]').innerText(),
  map: await page.locator('[data-testid=site-map] svg rect').count(),
  loadout_shown_yet: await page.locator('[data-testid=deploy]').count(),
});
await page.screenshot({ path: `${OUT}/intel.png`, fullPage: true });

// Training: Practice selector.
await page.goto(`${WEB}/training`);
await page.click('[data-testid=mode-practice]');
await page.click('[data-testid=site-blacksite]');
await page.click('[data-testid=phase-dusk]');
await page.click('[data-testid=kind-recovery]');
await page.click('[data-testid=defense-4]');
await sleep(300);
ok('practice_intel', { site: await page.locator('[data-testid=intel-site]').innerText(), phase: await page.locator('[data-testid=intel-phase]').innerText(), rewards: await page.locator('[data-testid=operation-intel]').innerText().then((t) => /never scored/.test(t)) });
await page.screenshot({ path: `${OUT}/practice-select.png`, fullPage: true });
await page.click('[data-testid=start-practice]');
await page.waitForSelector('canvas', { timeout: 120_000 });
for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__czField)); i++) await sleep(500);
await page.mouse.click(640, 450);
await page.evaluate(() => window.__czSkipBriefing());
await sleep(1500);
ok('practice_run', await page.evaluate(() => ({ kind: window.__czField().kind, exfil: window.__czField().exfil?.mode, objectives: window.__czObjectives().map((o) => o.kind) })));
await page.screenshot({ path: `${OUT}/practice-run.png` });

// Endless.
await page.goto(`${WEB}/training`);
await page.click('[data-testid=mode-endless]');
await page.waitForSelector('canvas', { timeout: 120_000 });
for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__czEndless)); i++) await sleep(500);
await page.mouse.click(640, 450);
await page.evaluate(() => window.__czSkipBriefing?.());
await page.keyboard.down('KeyW'); await sleep(4000); await page.keyboard.up('KeyW');
ok('endless', await page.evaluate(() => ({ endless: window.__czEndless?.(), reserve: window.__czField().reserve })));
await page.screenshot({ path: `${OUT}/endless.png` });

// Campaign: the first op ends at a real extraction zone.
await page.goto(`${WEB}/training`);
await page.click('[data-testid=mode-campaign]');
await page.waitForSelector('canvas', { timeout: 120_000 });
for (let i = 0; i < 40; i++) {
  if (await page.evaluate(() => !!window.__czField)) break;
  await page.mouse.click(640, 450); await sleep(700);
}
await sleep(1000);
ok('campaign', await page.evaluate(() => ({ objectives: window.__czObjectives().map((o) => o.kind), exfil: window.__czField().exfil, reserve: window.__czField().reserve })));
await page.screenshot({ path: `${OUT}/campaign.png` });

ok('page_errors', out.errors);
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(out, null, 2));
await browser.close();
