// Settings: set by keyboard and mouse on /settings, then checked inside a fight, then
// changed live mid-fight.
//   node probe-settings.mjs [web] [outdir]
import { chromium } from 'playwright';
import fs from 'node:fs';
const WEB = process.argv[2] ?? 'http://127.0.0.1:3000';
const OUT = process.argv[3] ?? './settings-out';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-gpu-blocklist'] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`${WEB}/settings`);
await page.waitForSelector('[data-testid=fov]');
// Keyboard: the FOV slider from 55 to 70 with the arrow key.
await page.focus('[data-testid=fov]');
for (let i = 0; i < 15; i++) await page.keyboard.press('ArrowRight');
// Keyboard: effects volume to 0 with Home.
await page.focus('[data-testid=vol-effects]');
await page.keyboard.press('Home');
// Keyboard: tick a checkbox with Space.
await page.focus('[data-testid=toggle-interact]');
await page.keyboard.press('Space');
await page.check('[data-testid=reduce-motion]');
await page.check('[data-testid=subsize-l]', { force: true });
await page.check('[data-testid=quality-low]', { force: true });
await sleep(300);
out.saved = await page.evaluate(() => JSON.parse(localStorage.getItem('cz_settings')));
await page.screenshot({ path: `${OUT}/settings.png`, fullPage: true });

await page.goto(`${WEB}/dev/level?site=dustline-depot&kind=raid&phase=day&defense=1&seed=3`);
await page.waitForSelector('canvas', { timeout: 120_000 });
for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__czField)); i++) await sleep(500);
await page.mouse.click(640, 400); // unlocks audio
await page.evaluate(() => { window.__czSkipBriefing(); window.__czKillAll(); });
await sleep(1500);
out.in_fight = await page.evaluate(() => ({ cam: window.__czCam(), render: window.__czRender(), mix: window.__czAudio().mix }));
out.subtitle_px = await page.evaluate(() => { const el = [...document.querySelectorAll('div')].find((d) => d.style.fontSize === '21px'); return el ? el.style.fontSize : null; });

// One press of E (toggle mode) takes a crate without holding.
const crate = await page.evaluate(() => window.__czField().items.find((i) => i.kind === 'ammo_crate'));
await page.evaluate(([x, z]) => { window.__czWarp(x, z + 0.5); window.__czLook(0, -1.2); }, crate.pos);
await sleep(400);
await page.keyboard.press('KeyE');
await sleep(2500);
out.toggle_interact_took_crate = await page.evaluate((id) => window.__czField().record.looted.includes(id), crate.id);

// Reduced motion: no camera roll from sway or shake.
await page.evaluate(() => window.__czLook(0, 0));
const rolls = [];
for (let i = 0; i < 8; i++) { rolls.push(await page.evaluate(() => window.__czCam().roll)); await sleep(150); }
out.reduce_motion_roll = Math.max(...rolls.map(Math.abs));

// Live: change settings mid-fight (as the pause menu or another tab would).
await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('cz_settings'));
  s.fov = 62; s.access.reduceMotion = false; s.audio.effects = 0.5;
  localStorage.setItem('cz_settings', JSON.stringify(s));
  window.dispatchEvent(new CustomEvent('cz-settings', { detail: s }));
});
await sleep(800);
const rolls2 = [];
for (let i = 0; i < 8; i++) { rolls2.push(await page.evaluate(() => window.__czCam().roll)); await sleep(150); }
out.live = { fov: await page.evaluate(() => window.__czCam().fov), effects: await page.evaluate(() => window.__czAudio().mix.effects), roll_with_motion: Math.max(...rolls2.map(Math.abs)) };

// Background mute.
await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
await sleep(300);
out.background_muted = await page.evaluate(() => window.__czAudio().backgroundMuted);
out.errors = errors;
console.log(JSON.stringify(out, null, 1));
await b.close();
