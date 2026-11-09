// Pause-menu quick settings: change settings mid-fight from the pause menu and see them
// apply; the "All settings" link opens a new tab (the fight isn't abandoned); the menu
// fits a phone held landscape. Also reports the HUD's bottom-left bar layout.
//   node probe-pause.mjs [web] [outdir]
import { chromium } from 'playwright';
import fs from 'node:fs';
const WEB = process.argv[2] ?? 'http://127.0.0.1:3000';
const OUT = process.argv[3] ?? './pause-out';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name, detail === '' ? '' : JSON.stringify(detail)); };
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-gpu-blocklist'] });
const errors = [];
async function fight(vp) {
  const ctx = await b.newContext({ viewport: vp });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${WEB}/dev/level?site=dustline-depot&kind=raid&phase=day&defense=1&seed=3`, { timeout: 180_000 });
  await page.waitForSelector('canvas', { timeout: 120_000 });
  for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__czField && !!window.__czSkipBriefing)); i++) await sleep(500);
  await page.mouse.click(vp.width / 2, vp.height / 2);
  // The hooks re-register if the scene re-renders (Auto quality stepping down), so retry.
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(() => { if (!window.__czSkipBriefing) return false; window.__czSkipBriefing(); window.__czKillAll(); return true; })) break;
    await sleep(500);
  }
  await sleep(1500);
  return { ctx, page };
}

const { ctx, page } = await fight({ width: 1280, height: 800 });
// HUD layout: the XP bar and the health bar shouldn't sit on top of each other.
const bars = await page.evaluate(() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
  const xpText = [...document.querySelectorAll('div')].find((d) => /XP$/.test(d.textContent ?? '') && d.children.length === 0);
  const xpBar = xpText?.nextElementSibling;
  const health = [...document.querySelectorAll('div')].find((d) => d.style.height === '9px' && d.style.border.includes('255, 255, 255'));
  const kills = [...document.querySelectorAll('div')].find((d) => /^KILLS/.test(d.textContent ?? ''));
  const refills = health?.nextElementSibling;
  return { xpText: xpText && rect(xpText), xpBar: xpBar && rect(xpBar), health: health && rect(health), refills: refills && rect(refills), kills: kills && rect(kills) };
});
const stack = [bars.xpText, bars.xpBar, bars.health, bars.refills, bars.kills];
check('the bottom-left HUD stack has no overlaps', stack.every(Boolean) && stack.every((r, i) => i === 0 || stack[i - 1].bottom <= r.top), bars);

await page.keyboard.press('Escape');
await page.waitForSelector('[data-testid=pause-settings]');
check('the pause menu carries quick settings', true);
await page.fill('[data-testid=p-fov]', '72');
// The paused fight doesn't render; the new FOV shows the moment play resumes.
await page.keyboard.press('Escape');
await sleep(600);
check('FOV from the pause menu applies in the fight', (await page.evaluate(() => window.__czCam().fov)) === 72);
await page.keyboard.press('Escape');
await page.waitForSelector('[data-testid=pause-settings]');
await page.click('[data-testid=pause-tab-audio]');
await page.fill('[data-testid=p-vol-music]', '0');
await sleep(300);
const a = await page.evaluate(() => window.__czAudio());
check('music volume from the pause menu applies (zero stops the score)', a.mix.music === 0 && !a.music.playing, a.music);
await page.click('[data-testid=pause-tab-controls]');
await page.check('[data-testid=p-invert]');
check('invert Y from the pause menu is saved', await page.evaluate(() => JSON.parse(localStorage.getItem('cz_settings')).controls.invertY === true));
const link = await page.$eval('[data-testid=pause-all-settings]', (l) => ({ href: l.getAttribute('href'), target: l.target }));
check('"All settings" opens a new tab, so the fight survives', link.href === '/settings' && link.target === '_blank', link);
// A change made in that other tab reaches this fight (the storage event).
const other = await ctx.newPage();
await other.goto(`${WEB}/settings#interface`);
await other.waitForSelector('[data-testid=hud-scale]');
await other.fill('[data-testid=hud-scale]', '1.2');
await sleep(800);
check('a change in the Settings tab reaches the paused fight', await page.evaluate(() => /scale\(1\.2\)/.test(document.querySelector('[data-testid=field-prompt]').style.transform)));
await other.close();
await page.screenshot({ path: `${OUT}/pause-desktop.png` });
await ctx.close();

const ph = await fight({ width: 740, height: 360 });
await ph.page.keyboard.press('Escape');
await ph.page.waitForSelector('[data-testid=pause-settings]');
const fit = await ph.page.evaluate(() => {
  const resume = [...document.querySelectorAll('button')].find((x) => /RESUME/.test(x.textContent));
  const box = document.querySelector('[data-testid=pause-settings]');
  const overlay = box.parentElement;
  overlay.scrollTop = overlay.scrollHeight;
  const link = document.querySelector('[data-testid=pause-all-settings]').getBoundingClientRect();
  overlay.scrollTop = 0;
  return { resumeTop: Math.round(resume.getBoundingClientRect().top), linkBottomAfterScroll: Math.round(link.bottom), h: innerHeight };
});
check('phone landscape: RESUME is on screen and the panel scrolls into reach', fit.resumeTop >= 0 && fit.linkBottomAfterScroll <= fit.h, fit);
await ph.page.screenshot({ path: `${OUT}/pause-phone.png` });
await ph.ctx.close();

check('no page errors', errors.length === 0, errors.slice(0, 5));
console.log(`${results.filter((x) => x.ok).length}/${results.length} passed`);
await b.close();
