// The Configuration Center end to end: every category at desktop and phone width,
// keyboard navigation, key rebinding (conflicts, reserved keys, undo), staged graphics
// (apply / revert), full screen (allowed and unsupported), the account section
// (signed out, signed in, account sync, a revocation the chain won't confirm, no secret
// on the page), then the settings inside a real fight.
//   node probe-config.mjs [web] [api] [outdir]
// Signs in as the test player with its key from ~/.contract-zero (outside the repo) and
// deletes the preferences row it writes.
import { chromium } from 'playwright';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { KeyPair } from 'near-api-js';
import { loadKey, signIn } from '../../scripts/lib/cz-auth.mjs';

const WEB = process.argv[2] ?? 'http://127.0.0.1:3000';
const API = process.argv[3] ?? 'http://127.0.0.1:8080';
const OUT = process.argv[4] ?? './config-out';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name, detail === '' ? '' : JSON.stringify(detail)); };
const dbUrl = () => fs.readFileSync(new URL('../api/.env', import.meta.url), 'utf8').split('\n').find((l) => l.startsWith('DATABASE_URL='))?.slice(13);
const psql = (sql) => execFileSync('psql', [dbUrl(), '-tAc', sql], { encoding: 'utf8' }).trim();

const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-gpu-blocklist'] });
const errors = [];
const watch = (p) => p.on('pageerror', (e) => errors.push(String(e)));
const CATS = ['display', 'audio', 'controls', 'keys', 'interface', 'access', 'account'];

// ── 1. Every category, desktop and phone: renders, no sideways scroll ──
for (const [name, vp] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 375, height: 740 }]]) {
  const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: name === 'phone' ? 2 : 1 });
  const page = await ctx.newPage(); watch(page);
  await page.goto(`${WEB}/settings`);
  await page.waitForSelector('[data-testid=panel-display]');
  const overflow = [];
  for (const c of CATS) {
    await page.click(`[data-testid=cat-${c}]`);
    await page.waitForSelector(`[data-testid=panel-${c}]`);
    await sleep(250);
    const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
    if (w.sw > w.iw + 1) overflow.push(`${c}:${w.sw}`);
    await page.screenshot({ path: `${OUT}/${name}-${c}.png`, fullPage: true });
  }
  check(`${name}: every category renders without sideways scroll`, overflow.length === 0, overflow);
  await ctx.close();
}

const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage(); watch(page);
await page.goto(`${WEB}/settings#keys`);
await page.waitForSelector('[data-testid=panel-keys]');
check('a #hash deep-links a category', true);

// ── 2. Keyboard: the category rail is a tab list ──
await page.focus('[data-testid=cat-keys]');
await page.keyboard.press('ArrowDown');
check('arrow keys move between categories', await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'cat-interface' && !!document.querySelector('[data-testid=panel-interface]')));
await page.keyboard.press('Home');
check('Home jumps to the first category', await page.evaluate(() => !!document.querySelector('[data-testid=panel-display]')));

// ── 3. Key bindings ──
await page.click('[data-testid=cat-keys]');
const binds = () => page.evaluate(() => JSON.parse(localStorage.getItem('cz_settings')).controls.binds);
await page.click('[data-testid=bind-reload-0]');
await page.keyboard.press('KeyK');
await sleep(150);
check('rebinding saves the new key', (await binds()).reload[0] === 'KeyK');
await page.click('[data-testid=bind-reload-0]');
await page.keyboard.press('F5');
await sleep(150);
const refused = await page.textContent('[data-testid=bind-notice]').catch(() => null) ?? await page.textContent('[data-testid=bind-capturing]');
check('a reserved key is refused with the reason', (await binds()).reload[0] === 'KeyK' && /Function keys|can’t be bound/.test(refused ?? ''), refused);
await page.keyboard.press('Escape');
await sleep(150);
check('Esc cancels capture', /Cancelled/.test(await page.textContent('[data-testid=bind-notice]')));
await page.click('[data-testid=bind-reload-0]');
await page.keyboard.press('KeyE');
await sleep(150);
const b2 = await binds();
const moved = await page.textContent('[data-testid=bind-notice]');
check('a key in use moves and the loser is named', b2.reload[0] === 'KeyE' && b2.interact[0] === null && /Use \/ interact lost it/.test(moved), moved);
check('a required action with no key is flagged', /Use \/ interact/.test(await page.textContent('[data-testid=bind-missing]')));
await page.screenshot({ path: `${OUT}/keys-conflict.png`, fullPage: true });
await page.click('[data-testid=bind-undo]');
await sleep(150);
const b3 = await binds();
check('undo restores both actions', b3.reload[0] === 'KeyK' && b3.interact[0] === 'KeyE');
await page.click('[data-testid=binds-reset]');
await sleep(150);
check('reset keys restores the defaults', (await binds()).reload[0] === 'KeyR');

// ── 4. Display: staged, applied, reverted ──
await page.click('[data-testid=cat-display]');
const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('cz_settings')));
await page.check('[data-testid=shadows-off]', { force: true });
await page.check('[data-testid=fps-30]', { force: true });
await sleep(150);
check('graphics changes are staged, not saved', (await saved()).graphics.shadows === 'preset' && /2 pending changes/.test(await page.textContent('[data-testid=display-pending]')));
await page.click('[data-testid=display-discard]');
check('discard drops the staged changes', /as applied/.test(await page.textContent('[data-testid=display-pending]')));
await page.check('[data-testid=shadows-off]', { force: true });
await page.click('[data-testid=display-apply]');
await sleep(150);
check('apply saves them', (await saved()).graphics.shadows === 'off');
await page.click('[data-testid=display-revert]');
await sleep(150);
check('revert goes back to what was applied before', (await saved()).graphics.shadows === 'preset');
check('the performance panels render', !!(await page.$('[data-testid=perf-last]')) && /Renders ~/.test(await page.textContent('[data-testid=perf-device]')));

// ── 5. Full screen: allowed, and a browser without it ──
await page.click('[data-testid=fullscreen]');
await sleep(500);
const fs1 = await page.evaluate(() => ({ on: !!document.fullscreenElement, label: document.querySelector('[data-testid=fullscreen-state]').textContent, err: document.querySelector('[data-testid=fullscreen-error]')?.textContent ?? null }));
check('full screen enters, or reports why the browser refused', fs1.on ? fs1.label === 'On' : !!fs1.err, fs1);
if (fs1.on) await page.evaluate(() => document.exitFullscreen());
{
  const p2 = await ctx.newPage(); watch(p2);
  await p2.addInitScript(() => { Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false, configurable: true }); });
  await p2.goto(`${WEB}/settings#display`);
  await p2.waitForSelector('[data-testid=fullscreen-unsupported]');
  check('without full-screen support the control is disabled and explained', await p2.isDisabled('[data-testid=fullscreen]'));
  await p2.close();
}

// ── 6. Account: signed out, then signed in ──
await page.click('[data-testid=cat-account]');
await page.waitForSelector('[data-testid=account-signed-out]');
check('signed out: settings are local only', /this device only/.test(await page.textContent('[data-testid=account-signed-out]')));

const key = loadKey(`${homedir()}/.contract-zero/keys/players-full/player.contract-zero.testnet.json`);
const login = await signIn(API, key.accountId, key.keyPair);
const eq = login.cookie.indexOf('=');
const [cname, cval] = [login.cookie.slice(0, eq), login.cookie.slice(eq + 1)];
const host = new URL(API).hostname;
await ctx.addCookies([{ name: cname, value: cval, domain: host, path: '/', httpOnly: true, sameSite: 'Lax' }]);
// A quick-trade key in this browser, a chain that still reports it active, and a relay
// that's down: revocation can't be confirmed, and the page must say so.
const qt = KeyPair.fromRandom('ed25519');
const SECRET = qt.toString();
await page.evaluate(([account, secret]) => localStorage.setItem('cz_session_key', JSON.stringify({ account, secret, expires: Date.now() + 3600_000 })), [key.accountId, SECRET]);
const fakeChain = async (route) => {
  const r = route.request();
  if (r.method() === 'POST' && (r.postData() ?? '').includes('get_session')) {
    const val = { credit_budget: '500', unit_budget: '25', expires_at_ns: (Date.now() + 3600_000) * 1e6, revoked: false };
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'cz', result: { result: [...new TextEncoder().encode(JSON.stringify(val))], logs: [] } }) });
  }
  return route.continue();
};
await ctx.route('https://rpc.testnet.fastnear.com/**', fakeChain);
await ctx.route('**/relay/delegate', (route) => route.fulfill({ status: 502, contentType: 'application/json', headers: { 'access-control-allow-origin': new URL(WEB).origin, 'access-control-allow-credentials': 'true' }, body: JSON.stringify({ error: 'relayer unavailable (probe)' }) }));
await page.goto(`${WEB}/settings?signed=1#account`);
await page.waitForSelector('[data-testid=account-signed-in]', { timeout: 20000 });
check('signed in: the method is shown', /NEAR wallet/.test(await page.textContent('[data-testid=account-method]')));
await page.waitForSelector('[data-testid=qt-budget]', { timeout: 20000 });
check('quick-trade budget is read from the chain record', /500 credits · 25 units/.test(await page.textContent('[data-testid=qt-budget]')));
await page.click('[data-testid=near-details] summary');
await page.screenshot({ path: `${OUT}/account.png`, fullPage: true });
const text = await page.evaluate(() => document.body.innerText + document.documentElement.outerHTML);
check('no secret key on the page', !text.includes(SECRET) && !text.includes(SECRET.slice(8, 40)));
await page.click('[data-testid=qt-revoke]');
await page.click('[data-testid=qt-revoke-confirm]');
await page.waitForSelector('[data-testid=qt-result]', { timeout: 40000 });
const rv = await page.textContent('[data-testid=qt-result]');
check('an unconfirmed revocation is reported as unconfirmed, with the expiry', /hasn’t confirmed|hasn't confirmed/.test(rv) && /stops working at/.test(rv), rv);
check('the local key is wiped either way', await page.evaluate(() => localStorage.getItem('cz_session_key') === null));
await page.screenshot({ path: `${OUT}/account-revoke-failed.png`, fullPage: true });

// Account sync: a change here reaches the account; a newer account copy comes back.
await page.waitForFunction(() => /Saved to your account/.test(document.querySelector('[data-testid=sync-state]')?.textContent ?? ''), null, { timeout: 15000 });
check('signed in: preferences sync to the account', true);
await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('cz_settings')); s.controls.invertY = true; localStorage.setItem('cz_settings', JSON.stringify(s)); window.dispatchEvent(new CustomEvent('cz-settings', { detail: s })); });
await sleep(2600);
const row = psql(`SELECT prefs->'controls'->>'invertY' || ',' || (prefs ? 'graphics')::text FROM player_preferences WHERE account = '${key.accountId}'`);
check('a portable change is pushed, graphics is not', row === 'true,false', row);
psql(`UPDATE player_preferences SET prefs = jsonb_set(prefs, '{interface,hudScale}', '1.3'), updated_at = now() + interval '1 minute' WHERE account = '${key.accountId}'`);
await page.click('[data-testid=sync-now]');
await sleep(1500);
check('a newer account copy is pulled in', (await saved()).interface.hudScale === 1.3 && /loaded from another device/.test(await page.textContent('[data-testid=sync-state]')));
await ctx.unrouteAll();

// ── 7. In a fight ──
await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('cz_settings'));
  s.quality = 'high';
  s.graphics = { ...s.graphics, shadows: 'off', fpsCap: 30, renderScale: 0.75 };
  s.controls.binds.moveForward = ['KeyU', null];
  s.controls.binds.reload = ['KeyK', null];
  s.controls.invertY = true;
  s.interface = { ...s.interface, hudScale: 1.3, crosshair: { ...s.interface.crosshair, style: 'dot', color: '#f0e442' } };
  s.access = { ...s.access, palette: 'redgreen', highContrastPrompts: true };
  s.audio.music = 0.8;
  localStorage.setItem('cz_settings', JSON.stringify(s));
});
await page.goto(`${WEB}/dev/level?site=dustline-depot&kind=raid&phase=day&defense=1&seed=3`);
await page.waitForSelector('canvas', { timeout: 120_000 });
for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__czField)); i++) await sleep(500);
await page.mouse.click(640, 400);
await page.evaluate(() => { window.__czSkipBriefing(); window.__czKillAll(); });
await sleep(4500);
const r = await page.evaluate(() => ({ render: window.__czRender(), audio: window.__czAudio(), perf: JSON.parse(localStorage.getItem('cz_perf_last') ?? 'null') }));
check('shadows forced off at High', r.render.shadowCasters === 0 && r.render.plan.post === 'full', r.render);
check('resolution scale lowers the pixel-ratio cap (High 2× × 75%)', r.render.plan.dprMax === 1.5 && r.render.pixelRatio <= 1.5, { cap: r.render.plan.dprMax, actual: r.render.pixelRatio });
check('the frame-rate cap holds', r.perf && r.perf.cap === 30 && r.perf.fps <= 33, r.perf);
check('music plays on its own channel', r.audio.music.playing && r.audio.mix.music === 0.8, r.audio.music);

const pos = () => page.evaluate(() => window.__czPlayer());
await page.evaluate(() => window.__czLook(Math.PI, 0));
let p0 = await pos();
await page.keyboard.down('KeyW'); await sleep(900); await page.keyboard.up('KeyW');
let p1 = await pos();
const wMoved = Math.hypot(p1.x - p0.x, p1.z - p0.z);
await page.keyboard.down('KeyU'); await sleep(900); await page.keyboard.up('KeyU');
const p2 = await pos();
const uMoved = Math.hypot(p2.x - p1.x, p2.z - p1.z);
check('a rebound key moves the operator; the old key does not', uMoved > 0.5 && wMoved < 0.05, { wMoved, uMoved });

const pitch0 = (await page.evaluate(() => window.__czCam())).pitch;
await page.keyboard.down('ArrowUp'); await sleep(500); await page.keyboard.up('ArrowUp');
const pitch1 = (await page.evaluate(() => window.__czCam())).pitch;
check('invert Y: look-up lowers the view', pitch1 < pitch0, { pitch0, pitch1 });

const ammoText = () => page.evaluate(() => [...document.querySelectorAll('div')].find((d) => d.style.fontSize === '30px')?.textContent);
await page.evaluate(() => window.__czFire(true)); await sleep(700); await page.evaluate(() => window.__czFire(false));
const fired = await ammoText();
await page.keyboard.press('KeyR'); await sleep(3500);
const afterR = await ammoText();
await page.keyboard.press('KeyK'); await sleep(3500);
const afterK = await ammoText();
check('the rebound reload key reloads; the old one does not', fired === afterR && afterK !== fired, { fired, afterR, afterK });

const hud = await page.evaluate(() => {
  const dot = [...document.querySelectorAll('div')].find((d) => d.style.borderRadius === '50%' && d.style.background.includes('240, 228, 66'));
  const prompt = document.querySelector('[data-testid=field-prompt]');
  const arrowColors = [...document.querySelectorAll('div')].filter((d) => d.textContent === '▲').map((d) => d.style.color);
  return { dot: !!dot, promptTransform: prompt?.style.transform, arrowColors };
});
check('crosshair style and colour apply', hud.dot);
check('HUD scale applies', /scale\(1\.3\)/.test(hud.promptTransform ?? ''), hud.promptTransform);
check('the red–green palette colours the arrows', hud.arrowColors.includes('rgb(230, 159, 0)') && hud.arrowColors.includes('rgb(86, 180, 233)'), hud.arrowColors);
const crate = await page.evaluate(() => window.__czField().items.find((i) => i.kind === 'ammo_crate'));
await page.evaluate(([x, z]) => { window.__czWarp(x, z + 0.5); window.__czLook(0, -1.2); }, crate.pos);
await sleep(800);
check('high-contrast prompt shows the bound key', await page.evaluate(() => { const p = document.querySelector('[data-testid=field-prompt] [data-hc]'); return !!p && /E/.test(p.textContent); }));
await page.screenshot({ path: `${OUT}/fight.png` });

psql(`DELETE FROM player_preferences WHERE account = '${key.accountId}'`);
check('no page errors', errors.length === 0, errors.slice(0, 5));
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1));
console.log(`${results.filter((x) => x.ok).length}/${results.length} passed`);
await b.close();
