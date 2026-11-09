// Frame rate, draw calls and triangles per map and quality tier.
//   node probe-perf.mjs [web] [gpu|software|throttle] [out.json] [sites,comma]
// throttle: GPU rendering with the CPU slowed 4× (a weak laptop's CPU budget).
import { chromium } from 'playwright';
import fs from 'node:fs';
const WEB = process.argv[2] ?? 'http://127.0.0.1:3000';
const MODE = process.argv[3] ?? 'gpu';
const OUT = process.argv[4];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = MODE === 'software' ? ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] : ['--ignore-gpu-blocklist'];
const b = await chromium.launch({ channel: 'chrome', headless: true, args });
const rows = [];
for (const site of (process.argv[5] ?? 'dustline-depot,blacksite,cinder-yard').split(',')) {
  for (const quality of ['high', 'medium', 'low']) {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
    await ctx.addInitScript((q) => { localStorage.setItem('cz_settings', JSON.stringify({ version: 2, quality: q })); localStorage.removeItem('cz_degraded'); }, quality);
    const p = await ctx.newPage();
    if (MODE === 'throttle') { const cdp = await ctx.newCDPSession(p); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }); }
    await p.goto(`${WEB}/dev/level?site=${site}&kind=raid&phase=night&defense=3&seed=3`, { timeout: 240_000 });
    await p.waitForSelector('canvas', { timeout: 120_000 });
    for (let i = 0; i < 80 && !(await p.evaluate(() => !!window.__czField)); i++) await sleep(500);
    await p.mouse.click(640, 400);
    // Look down the site with the guards awake: a representative combat view.
    await p.evaluate(() => { window.__czSkipBriefing(); window.__czWakeAll(); const o = window.__czObjectives()[0]; window.__czWarp(o.pos[0], o.pos[1]); window.__czLook(0, 0.02); });
    await sleep(2500);
    const m = await p.evaluate(() => new Promise((res) => {
      const t = []; let last = performance.now(); const t0 = last;
      const f = (now) => { t.push(now - last); last = now; if (now - t0 < 4000) requestAnimationFrame(f); else res(t); };
      requestAnimationFrame(f);
    }).then((t) => { const s = t.slice(5).sort((a, b) => a - b); const avg = s.reduce((a, b) => a + b, 0) / s.length; return { fps: Math.round(1000 / avg), p95ms: +s[Math.floor(s.length * 0.95)].toFixed(1) }; }).catch(() => null));
    const perf = await p.evaluate(() => window.__czDrawStats?.(30));
    const render = await p.evaluate(() => window.__czRender?.());
    rows.push({ site, quality, ...m, calls: perf?.calls, triangles: perf?.triangles, pixelRatio: render?.pixelRatio, shadowCasters: render?.shadowCasters });
    console.log(JSON.stringify(rows[rows.length - 1]));
    await ctx.close();
  }
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ mode: MODE, rows }, null, 2));
await b.close();
