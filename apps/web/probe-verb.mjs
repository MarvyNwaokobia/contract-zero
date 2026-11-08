// Runtime probe for the FPS sandbox (/dev/verb): loads the scene in headless Chromium
// with software GL, skips the briefing, then holds W and fires, and reports what changed.
// Usage: node probe-verb.mjs [outDir]
import { chromium } from '@playwright/test';

const out = process.argv[2] ?? '.';
const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 240)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 240)); });
const missing = [];
page.on('response', (r) => { if (r.status() >= 400) missing.push(`${r.status()} ${new URL(r.url()).pathname}`); });

await page.goto('http://localhost:3100/dev/verb', { waitUntil: 'domcontentloaded', timeout: 180_000 });
await page.waitForSelector('canvas', { timeout: 180_000 });
await page.waitForFunction(() => typeof window.__valorMission === 'function', null, { timeout: 120_000 });
await page.waitForTimeout(2000);
await page.evaluate(() => window.__valorSkipBriefing?.());
await page.waitForTimeout(6000); // scene-ready + countdown
const snap = () => page.evaluate(() => {
  const s = window.__valorState?.() ?? {};
  return { pos: window.__valorPlayer(), ammo: s.ammo, simTime: window.__valorMission().simTime, objective: window.__valorMission().objective };
});
const before = await snap();
await page.screenshot({ path: `${out}/verb-start.png` });

// Movement: hold W (keyboard path, the real input).
await page.mouse.click(400, 225);
await page.keyboard.down('KeyW');
await page.waitForTimeout(20000);
await page.keyboard.up('KeyW');
const moved = await snap();

// Fire: hold the trigger through the scene's control state.
await page.evaluate(() => window.__valorFire(true));
await page.waitForTimeout(15000);
await page.evaluate(() => window.__valorFire(false));
const after = await snap();
await page.screenshot({ path: `${out}/verb-after.png` });

const fps = await page.evaluate(() => new Promise((r) => {
  let n = 0; const s = performance.now();
  const f = () => { n++; if (performance.now() - s < 2000) requestAnimationFrame(f); else r(n / 2); };
  requestAnimationFrame(f);
}));

console.log(JSON.stringify({ fps: Math.round(fps), before, moved, after, missing: [...new Set(missing)], errors }, null, 1));
await browser.close();
