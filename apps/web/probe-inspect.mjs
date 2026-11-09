// Item inspection in the Armory, the loadout and the field.
//   node probe-inspect.mjs [web] [api] [outdir]
import { chromium } from 'playwright';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { loadKey, signIn } from '../../scripts/lib/cz-auth.mjs';
const WEB = process.argv[2] ?? 'http://127.0.0.1:3000';
const API = process.argv[3] ?? 'http://127.0.0.1:8080';
const OUT = process.argv[4] ?? './inspect-out';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
const key = loadKey(`${homedir()}/.contract-zero/keys/players-full/player.contract-zero.testnet.json`);
const login = await signIn(API, key.accountId, key.keyPair);
const [name, value] = login.cookie.split('=');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addCookies([{ name, value, domain: new URL(API).hostname, path: '/' }]);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

// Armory
await page.goto(`${WEB}/exchange`);
await page.waitForSelector('[data-testid=inspect-marksman]', { timeout: 120_000 });
await page.click('[data-testid=inspect-marksman]');
await page.waitForSelector('[data-testid=inspector]');
await sleep(2500);
out.armory = { status: await page.innerText('[data-testid=inspect-status]'), stats: (await page.innerText('[data-testid=inspect-stats]')).split('\n').slice(0, 8) };
// drag to rotate, wheel to zoom
const c = await page.locator('[data-testid=inspector] canvas').boundingBox();
await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2); await page.mouse.down(); await page.mouse.move(c.x + c.width / 2 + 160, c.y + c.height / 2 + 20, { steps: 8 }); await page.mouse.up();
await page.mouse.wheel(0, -300); await sleep(600);
await page.screenshot({ path: `${OUT}/armory-inspect.png` });
await page.keyboard.press('Escape');
out.armory_closed = (await page.locator('[data-testid=inspector]').count()) === 0;

// In the field: look at a crate, press I; then at nothing (your own weapon).
await page.goto(`${WEB}/dev/level?site=blacksite&kind=raid&phase=night&defense=1&seed=2`);
await page.waitForSelector('canvas', { timeout: 120_000 });
for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__czField)); i++) await sleep(500);
await page.mouse.click(640, 400);
await page.evaluate(() => { window.__czSkipBriefing(); window.__czKillAll(); });
await sleep(1500);
const crate = await page.evaluate(() => window.__czField().items.find((i) => i.kind === 'ammo_crate'));
await page.evaluate(([x, z]) => { window.__czWarp(x, z + 0.5); window.__czLook(0, -1.2); }, crate.pos);
await sleep(500);
await page.keyboard.press('KeyI');
await page.waitForSelector('[data-testid=inspector]', { timeout: 10_000 });
const t0 = await page.evaluate(() => ({ sim: window.__czMission().simTime, at: window.__czPlayer() }));
await page.keyboard.down('KeyW'); await sleep(1500); await page.keyboard.up('KeyW');
const t1 = await page.evaluate(() => ({ sim: window.__czMission().simTime, at: window.__czPlayer() }));
out.field_crate = { title: await page.innerText('[data-testid=inspector] h2'), status: await page.innerText('[data-testid=inspect-status]'), fight_continues: t1.sim > t0.sim, player_held: Math.hypot(t1.at.x - t0.at.x, t1.at.z - t0.at.z) < 0.01, warning: await page.locator('text=The fight doesn’t stop').count() };
await sleep(1200);
await page.screenshot({ path: `${OUT}/field-inspect-crate.png` });
await page.keyboard.press('Escape');
await sleep(300);
await page.evaluate(([x, z]) => { window.__czWarp(x + 4, z + 4); window.__czLook(1.5, 0.3); }, crate.pos);
await sleep(300);
await page.keyboard.press('KeyI');
await page.waitForSelector('[data-testid=inspector]', { timeout: 10_000 });
await sleep(1500);
out.field_own_weapon = { title: await page.innerText('[data-testid=inspector] h2'), status: await page.innerText('[data-testid=inspect-status]'), loaded: (await page.innerText('[data-testid=inspect-stats]')).match(/Loaded\s+([^\n]+)/)?.[1] };
await page.screenshot({ path: `${OUT}/field-inspect-weapon.png` });
out.errors = errors;
console.log(JSON.stringify(out, null, 1));
await browser.close();
