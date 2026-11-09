// Documentation screenshots, from the running game, plus the help system's checks:
// How to Play opens from the Hub, Training, contract intel, Settings and the pause
// menu; the first-time tip appears in a fight, once, and replays after a reset.
//   node probe-docs.mjs [web] [api] [outdir]   (outdir default: ../../docs/media)
import { chromium } from 'playwright';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadKey, signIn } from '../../scripts/lib/cz-auth.mjs';

const WEB = process.argv[2] ?? 'http://127.0.0.1:3000';
const API = process.argv[3] ?? 'http://127.0.0.1:8080';
const OUT = process.argv[4] ?? '../../docs/media';
const RAW = '/tmp/cz-docs-raw';
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(RAW, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name, detail === '' ? '' : JSON.stringify(detail)); };
const errors = [];
const key = loadKey(`${homedir()}/.contract-zero/keys/players-full/player.contract-zero.testnet.json`);
const login = await signIn(API, key.accountId, key.keyPair);
const eq = login.cookie.indexOf('=');
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-gpu-blocklist'] });

/** Save a screenshot as an optimized JPEG (1280 wide max, quality 72). */
async function shot(page, name, opts = {}) {
  const raw = `${RAW}/${name}.png`;
  // Headless browsers can't lock the pointer, so the desktop "move the mouse to aim"
  // hint never clears there; a player sees it only until their first click.
  await page.evaluate(() => { for (const d of document.querySelectorAll('div')) if (/^AIM UP\/DOWN/.test(d.textContent ?? '')) d.style.display = 'none'; });
  await page.screenshot({ path: raw, ...opts });
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '72', '--resampleWidth', String(Math.min(1280, opts.width ?? 1280)), raw, '--out', `${OUT}/${name}.jpg`], { stdio: 'ignore' });
}

async function context(vp = { width: 1280, height: 720 }, mobile = false) {
  const ctx = await b.newContext({ viewport: vp, ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  await ctx.addCookies([{ name: login.cookie.slice(0, eq), value: login.cookie.slice(eq + 1), domain: new URL(API).hostname, path: '/' }]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  return { ctx, p };
}

async function openHelp(p, where) {
  await p.click('[data-testid=how-to-play]');
  const ok = !!(await p.waitForSelector('[data-testid=how-to-play-dialog]', { timeout: 15000 }).catch(() => null));
  check(`How to play opens from ${where}`, ok);
  return ok;
}

async function fight(p, site, kind, phase) {
  await p.goto(`${WEB}/dev/level?site=${site}&kind=${kind}&phase=${phase}&defense=2&seed=4`, { timeout: 180000 });
  await p.waitForSelector('canvas', { timeout: 180000 });
  for (let i = 0; i < 60; i++) {
    if (await p.evaluate(() => !!window.__czField && !!window.__czSkipBriefing)) break;
    await sleep(500);
  }
  await p.mouse.click(640, 360);
  await p.evaluate(() => { window.__czSkipBriefing(); });
  await sleep(1500);
}

// ── Pages ───────────────────────────────────────────────────────────────────
{
  const { ctx, p } = await context();
  await p.goto(`${WEB}/`, { waitUntil: 'networkidle', timeout: 120000 }).catch(() => {});
  const welcome = await p.waitForSelector('[data-testid=welcome]', { timeout: 20000 }).catch(() => null);
  check('first launch shows the welcome with Start training', !!welcome && !!(await p.$('[data-testid=welcome-start]')));
  await sleep(2000);
  await shot(p, 'welcome');
  await p.click('[data-testid=welcome-dismiss]');
  await p.reload({ waitUntil: 'networkidle' }).catch(() => {});
  await sleep(2500);
  check('it stays dismissed', !(await p.$('[data-testid=welcome]')));
  await shot(p, 'hub');
  if (await openHelp(p, 'the Hub')) {
    await shot(p, 'how-to-play-basics');
    await p.click('[data-testid=htp-desktop]');
    await sleep(300);
    const txt = await p.textContent('[data-testid=how-to-play-dialog]');
    check('the help shows the real interact and lean keys', /Use \/ interact\s*E/.test(txt) && /Lean right\s*G/.test(txt));
    check('the manual draws the keyboard', !!(await p.$('[data-testid=keyboard-diagram]')));
    await shot(p, 'controls-desktop');
    await p.click('[data-testid=htp-touch]');
    await sleep(300);
    check('and the touch layout', !!(await p.$('[data-testid=touch-diagram]')));
    await shot(p, 'controls-touch');
    await p.keyboard.press('Escape');
    check('Esc closes it', !(await p.$('[data-testid=how-to-play-dialog]')));
  }
  await p.goto(`${WEB}/contracts`, { waitUntil: 'networkidle' }).catch(() => {});
  await sleep(1500);
  await shot(p, 'contracts');
  const board = await (await fetch(`${API}/board`)).json();
  const raid = board.board.find((x) => x.kind === 'raid') ?? board.board[0];
  await p.goto(`${WEB}/deploy?target=${raid.target}&resource=${raid.resource}&kind=${raid.kind}`, { waitUntil: 'networkidle' }).catch(() => {});
  await p.waitForSelector('[data-testid=intel-objectives]', { timeout: 60000 });
  await shot(p, 'intel', { fullPage: true });
  await openHelp(p, 'contract intel');
  await p.keyboard.press('Escape');
  await p.goto(`${WEB}/training`, { waitUntil: 'networkidle' }).catch(() => {});
  await openHelp(p, 'Training');
  await p.keyboard.press('Escape');
  await p.click('[data-testid=mode-practice]');
  await sleep(800);
  await shot(p, 'training-practice', { fullPage: true });
  await p.goto(`${WEB}/settings`, { waitUntil: 'networkidle' }).catch(() => {});
  await openHelp(p, 'Settings');
  await p.keyboard.press('Escape');
  await p.goto(`${WEB}/exchange`, { waitUntil: 'networkidle' }).catch(() => {});
  await p.waitForSelector('[data-testid=trading-partners]', { timeout: 60000 });
  await p.locator('[data-testid=trading-partners]').scrollIntoViewIfNeeded();
  await sleep(600);
  await shot(p, 'exchange-partners');
  await p.locator('[data-testid=market-orders]').scrollIntoViewIfNeeded();
  await sleep(400);
  await shot(p, 'exchange-orders');
  await p.goto(`${WEB}/war-room`, { waitUntil: 'networkidle' }).catch(() => {});
  await p.waitForSelector('[data-testid^=proc-]', { timeout: 60000 });
  for (const el of await p.$$('[data-testid^=proc-]')) {
    if (/filled/i.test(await el.textContent())) { await el.evaluate((d) => { d.open = true; }); await el.scrollIntoViewIfNeeded(); break; }
  }
  await sleep(800);
  await shot(p, 'warroom-procurement');
  await p.locator('[data-testid=causal-chain]').first().scrollIntoViewIfNeeded().catch(() => {});
  await sleep(400);
  await shot(p, 'warroom-causal');
  await ctx.close();
}

// ── The fight ───────────────────────────────────────────────────────────────
{
  const { ctx, p } = await context();
  await p.goto(`${WEB}/settings`);
  await p.evaluate(() => localStorage.removeItem('cz_tips_seen'));
  await fight(p, 'dustline-depot', 'raid', 'day');
  await p.waitForFunction(() => getComputedStyle(document.querySelector('[data-testid=tip]')).opacity === '1', null, { timeout: 15000 }).catch(() => {});
  const tip = await p.textContent('[data-testid=tip]');
  check('the first fight shows the controls tip', /move/.test(tip ?? '') && /hold E to use/.test(tip ?? ''), tip);
  await shot(p, 'fight-dustline-tip');
  // Walk to a crate (loot tip), take a cargo case (cargo tip), extract (extraction tip).
  const f = await p.evaluate(() => window.__czField());
  const crate = f.items.find((i) => i.kind === 'ammo_crate');
  await p.evaluate(([x, z]) => { window.__czWarp(x, z + 1.6); window.__czLook(0, -0.5); }, crate.pos);
  await sleep(9000); // let the controls tip fade so the loot tip can show
  await p.evaluate(([x, z]) => { window.__czWarp(x, z + 1.0); window.__czLook(0, -0.9); }, crate.pos);
  await sleep(900);
  check('the first pickup shows the loot tip', /Hold E until the bar fills/.test(await p.textContent('[data-testid=tip]')), await p.textContent('[data-testid=tip]'));
  await shot(p, 'fight-loot-prompt');
  await p.keyboard.down('KeyE'); await sleep(1300); await p.keyboard.up('KeyE');
  const med = f.items.find((i) => i.kind === 'med_case');
  if (med) {
    await sleep(7500);
    await p.evaluate(([x, z]) => { window.__czWarp(x, z + 1.0); window.__czLook(0, -0.9); }, med.pos);
    await sleep(600);
    await p.keyboard.down('KeyE'); await sleep(1300); await p.keyboard.up('KeyE');
    await sleep(600);
    check('the first medical supplies show the healing tip', /Field dressing: press H/.test(await p.textContent('[data-testid=tip]')), await p.textContent('[data-testid=tip]'));
  }
  const kase = f.items.find((i) => i.kind === 'cargo_case');
  await p.evaluate(() => window.__czKillAll());
  await sleep(7500);
  await p.evaluate(([x, z]) => { window.__czWarp(x, z + 1.0); window.__czLook(0, -0.9); }, kase.pos);
  await sleep(500);
  await p.keyboard.down('KeyE'); await sleep(2600); await p.keyboard.up('KeyE');
  await sleep(500);
  check('carrying cargo shows the cargo tip', /Cargo: carry up to 3/.test(await p.textContent('[data-testid=tip]')));
  await shot(p, 'fight-cargo');
  const exfil = f.items.find((i) => i.kind === 'exfil');
  // Extraction opens only once the earlier objectives are done: play them in order.
  const objs = await p.evaluate(() => window.__czObjectives());
  for (let i = 0; i < 40; i++) {
    const m = await p.evaluate(() => window.__czMission());
    const o = objs[m.objective];
    if (!o || o.kind === 'extract') break;
    await p.evaluate(([x, z]) => { window.__czKillAll(); window.__czWarp(x, z); }, o.pos);
    await sleep(o.kind === 'defend' ? (o.holdSecs ?? 20) * 1000 + 1500 : 1200);
  }
  await sleep(7500);
  await p.evaluate(([x, z]) => { window.__czWarp(x, z + 1.5); window.__czLook(0, -0.25); }, exfil.pos);
  await sleep(300);
  await sleep(500);
  await p.keyboard.down('KeyE'); await sleep(1300); await p.keyboard.up('KeyE');
  await sleep(2500);
  check('extraction shows the extraction tip', /Extraction: stay in the zone/.test(await p.textContent('[data-testid=tip]')));
  await p.evaluate(() => window.__czLook(Math.PI, -0.05)); // face the yard, not the wall
  await sleep(500);
  await shot(p, 'fight-extraction');
  // The same tips don't show twice.
  await fight(p, 'dustline-depot', 'raid', 'day');
  await sleep(2500);
  check('a tip shows only once', (await p.$eval('[data-testid=tip]', (e) => getComputedStyle(e).opacity)) === '0');
  // The pause menu has How to play.
  await p.keyboard.press('Escape');
  await p.waitForSelector('[data-testid=pause-settings]', { timeout: 15000 });
  await openHelp(p, 'the pause menu');
  await p.keyboard.press('Escape');
  for (const [site, kind, phase, name] of [['blacksite', 'recovery', 'night', 'fight-blacksite-night'], ['cinder-yard', 'sabotage', 'dusk', 'fight-cinder-yard']]) {
    await fight(p, site, kind, phase);
    await p.evaluate(() => window.__czLook(0.6, -0.05));
    await sleep(1800);
    await shot(p, name);
  }
  await ctx.close();
}

// ── Touch ───────────────────────────────────────────────────────────────────
{
  const { ctx, p } = await context({ width: 844, height: 390 }, true);
  await fight(p, 'dustline-depot', 'raid', 'day');
  await sleep(1500);
  const labels = await p.evaluate(() => [...document.querySelectorAll('div')].map((d) => d.textContent?.trim()).filter((t) => ['ADS', 'CROUCH', 'USE', 'MED'].includes(t)));
  check('the touch HUD has ADS, CROUCH, USE and MED', ['ADS', 'CROUCH', 'USE', 'MED'].every((l) => labels.includes(l)), [...new Set(labels)]);
  await shot(p, 'touch-hud', { width: 1280 });
  await ctx.close();
}

check('no page errors', errors.length === 0, errors.slice(0, 4));
fs.writeFileSync(`${RAW}/results.json`, JSON.stringify(results, null, 1));
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
await b.close();
