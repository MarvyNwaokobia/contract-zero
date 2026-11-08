// End-to-end browser probe of the playable loop:
// Main Menu → set operator → Contract Board → Deploy (ammo depot) → fight → extract →
// Extraction Results → (one world tick) → Contract Board shows the changed next raid.
//
// Navigation and deployment use the real UI. Inside the fight, software GL runs at a
// few FPS, so the probe moves through objectives with the scene's debug hooks (warp,
// clear room) instead of aiming by hand; the session, timing check and settlement are
// the real server path.
//
// Usage: node probe-loop.mjs <outDir> [webUrl] [apiUrl]
import { chromium } from '@playwright/test';

const out = process.argv[2] ?? '.';
const WEB = process.argv[3] ?? 'http://localhost:3100';
const API = process.argv[4] ?? 'http://127.0.0.1:8089';
const PLAYER = 'raider.testnet';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const api = async (p) => (await fetch(API + p)).json();
const vanguard = async () => (await api('/world')).actors.find((a) => a.id === 'vanguard');
const report = { errors: [] };

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
page.on('pageerror', (e) => report.errors.push('pageerror: ' + String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) report.errors.push('console: ' + m.text().slice(0, 200)); });

// 1. Main Menu: set the operator.
await page.goto(WEB + '/', { waitUntil: 'networkidle', timeout: 180_000 });
await page.fill('input[placeholder="yourname.testnet"]', PLAYER);
await page.click('button:has-text("Set")');
await page.waitForSelector(`text=${PLAYER}`);
await page.screenshot({ path: `${out}/1-menu.png` });
report.vanguard_before = (await vanguard()).holdings;
log('menu ok, vanguard', JSON.stringify(report.vanguard_before));

// 2. Contract Board: pick the ammunition depot.
await page.click('text=Contract Board');
await page.waitForSelector('text=Ammunition depot', { timeout: 60_000 });
report.board_before = await page.locator('section', { hasText: 'Ammunition depot' }).first().innerText();
await page.screenshot({ path: `${out}/2-board.png` });
await page.click('a[href*="resource=ammo"]');

// 3. Armory → Deploy.
await page.waitForSelector('text=Armory · Loadout');
await page.click('button:has-text("Assault Rifle")');
await page.screenshot({ path: `${out}/3-loadout.png` });
await page.click('button:has-text("Deploy")');
await page.waitForSelector('canvas', { timeout: 180_000 });
await page.waitForFunction(() => typeof window.__czMission === 'function', null, { timeout: 120_000 });
const deployedAt = Date.now();
log('deployed; mission', JSON.stringify(await page.evaluate(() => window.__czMission())));
await page.evaluate(() => window.__czSkipBriefing());
await page.waitForTimeout(4000);
await page.screenshot({ path: `${out}/4-fight.png` });

// 4. Drive the objectives: intercept → clear escort → push → load cargo → extract.
const POS = { breach: [-4, 6.5], push: [5, -5.5], cargo: [0, -11.5], extract: [0, 14] };
const objective = () => page.evaluate(() => window.__czMission());
const until = async (pred, step, timeoutMs, label) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const m = await objective();
    if (pred(m)) return m;
    await step(m);
    await page.waitForTimeout(800);
  }
  throw new Error(`timed out: ${label}`);
};
await until((m) => m.objective >= 1, () => page.evaluate(([x, z]) => window.__czWarp(x, z), POS.breach), 120_000, 'intercept');
await until((m) => m.objective >= 2, () => page.evaluate(() => window.__czKillAll()), 120_000, 'clear escort');
await until((m) => m.objective >= 3, () => page.evaluate(([x, z]) => window.__czWarp(x, z), POS.push), 120_000, 'push');
log('loading cargo…');
await until((m) => m.objective >= 4, () => page.evaluate(([x, z]) => { window.__czWarp(x, z); window.__czKillAll(); }, POS.cargo), 600_000, 'load cargo');
await page.screenshot({ path: `${out}/5-loaded.png` });
// The server rejects anything faster than the mission physically takes; walk out no sooner.
while (Date.now() - deployedAt < 40_000) await page.waitForTimeout(1000);
await until((m) => m.complete, () => page.evaluate(([x, z]) => window.__czWarp(x, z), POS.extract), 120_000, 'extract');
report.mission_wall_secs = Math.round((Date.now() - deployedAt) / 1000);
log('extracted after', report.mission_wall_secs, 's');

// 5. Extraction Results.
await page.waitForSelector('text=Extraction Results', { timeout: 60_000 });
await page.waitForTimeout(1000);
report.results_page = (await page.locator('main').innerText()).replace(/\n+/g, ' | ').slice(0, 900);
await page.screenshot({ path: `${out}/6-results.png`, fullPage: true });
report.vanguard_after_raid = (await vanguard()).holdings;
report.player = (await api(`/players/${PLAYER}`)).holdings;

// 6. Let one world tick pass so the agents respond, then reload the board.
await page.waitForTimeout(25_000);
await page.goto(WEB + '/contracts', { waitUntil: 'networkidle' });
await page.waitForSelector('text=depot', { timeout: 60_000 });
report.board_after = await page.locator('section', { hasText: 'Ammunition depot' }).first().innerText().catch(() => 'no ammunition depot on the board');
await page.screenshot({ path: `${out}/7-board-after.png`, fullPage: true });
report.vanguard_after_agents = (await vanguard()).holdings;
report.decisions = (await api('/events?kind=agent_decision&limit=8')).events.map((e) => `${e.source} [${e.payload.validation}] ${e.payload.rationale}`);

console.log(JSON.stringify(report, null, 1));
await browser.close();
