// Frame cost per site and tier, in a browser with a SOFTWARE renderer. Read this carefully: no
// GPU is involved, so the absolute frame times say nothing about a real phone or laptop. What it
// does show is the relative cost of the tiers and of each site on the same machine, the draw
// calls and triangles behind it, and how many long main-thread tasks the page produced.
// Real-device numbers need a real device (see docs/contract-zero/LIVING_WORLD.md).
//   node probe-site-perf.mjs [web] [seconds]
import { chromium } from 'playwright'

const WEB = process.argv[2] ?? 'http://localhost:3000'
const SECS = Number(process.argv[3] ?? 6)
const b = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const rows = []
for (const site of ['dustline-depot', 'blacksite', 'cinder-yard']) {
  for (const [tier, settings, mobile] of [['desktop high', { quality: 'high' }, false], ['desktop low', { quality: 'low' }, false], ['mobile touch', { quality: 'high' }, true]]) {
    const ctx = await b.newContext(mobile ? { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 720 } })
    const page = await ctx.newPage()
    await page.addInitScript((st) => { try { localStorage.setItem('cz_welcome_seen', '1'); localStorage.setItem('cz_settings', JSON.stringify(st)) } catch {} }, settings)
    await page.goto(`${WEB}/dev/level?site=${site}&kind=raid&phase=day&defense=2&seed=4`, { timeout: 180000, waitUntil: 'domcontentloaded' })
    await page.waitForSelector('canvas', { timeout: 180000 })
    for (let i = 0; i < 80 && !(await page.evaluate(() => !!window.__czDrawStats && !!window.__czSkipBriefing)); i++) await page.waitForTimeout(500)
    await page.evaluate(() => window.__czSkipBriefing()); await page.waitForTimeout(2500)
    const m = await page.evaluate(async (secs) => {
      const times = []; let long = 0
      try { new PerformanceObserver((l) => { long += l.getEntries().length }).observe({ entryTypes: ['longtask'] }) } catch {}
      let last = performance.now(); const end = last + secs * 1000
      await new Promise((res) => { const f = (t) => { times.push(t - last); last = t; t < end ? requestAnimationFrame(f) : res() }; requestAnimationFrame(f) })
      times.shift(); times.sort((a, b) => a - b)
      const q = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))]
      return { frames: times.length, medianMs: +q(0.5).toFixed(1), p95Ms: +q(0.95).toFixed(1), longTasks: long, draw: await window.__czDrawStats(15), textures: window.__czPerf().textures }
    }, SECS)
    rows.push({ site, tier, ...m })
    console.log(`${site.padEnd(15)} ${tier.padEnd(13)} median ${String(m.medianMs).padStart(6)} ms  p95 ${String(m.p95Ms).padStart(6)} ms  long tasks ${String(m.longTasks).padStart(3)}  draw calls ${m.draw.calls}  tris ${m.draw.triangles}  textures ${m.textures}`)
    await ctx.close()
  }
}
await b.close()
