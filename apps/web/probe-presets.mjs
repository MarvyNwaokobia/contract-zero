// Graphics presets, checked in the running game:
//  1. each lower preset really lowers the work it says it does: Medium renders fewer pixels than High
//     (pixel ratio 1.5 vs 2, lighter post-processing), Low also drops shadows, set dressing and the
//     normal/roughness textures, so it has fewer draw calls and textures; and
//  2. "Auto" steps the tier down by itself when the frame rate can't hold (here: a slow software
//     renderer plus a 4x CPU slowdown stands in for a struggling device).
// This is an emulation. It shows the mechanisms work; it does not say how any real device performs.
//   node probe-presets.mjs [web]   (default http://localhost:3000)
import { chromium } from 'playwright'

const WEB = process.argv[2] ?? 'http://localhost:3000'
const b = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
let fail = 0
const check = (name, ok, detail) => { if (!ok) fail++; console.log(ok ? 'PASS' : 'FAIL', name, JSON.stringify(detail)) }
const open = async (settings, throttle = 1) => {
  const ctx = await b.newContext({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 2 }) // a high-DPI screen, so the tiers' pixel-ratio caps show
  const page = await ctx.newPage()
  if (throttle > 1) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: throttle })
  await page.addInitScript((st) => { try { localStorage.removeItem('cz_auto_level'); localStorage.setItem('cz_welcome_seen', '1'); localStorage.setItem('cz_tips_seen', JSON.stringify(['controls', 'loot', 'heal', 'cargo', 'extract'])); localStorage.setItem('cz_settings', JSON.stringify(st)) } catch {} }, settings)
  await page.goto(`${WEB}/dev/level?site=blacksite&kind=raid&phase=day&defense=2&seed=4`, { timeout: 180000, waitUntil: 'domcontentloaded' })
  await page.waitForSelector('canvas', { timeout: 180000 })
  for (let i = 0; i < 80 && !(await page.evaluate(() => !!window.__czDrawStats && !!window.__czSkipBriefing)); i++) await page.waitForTimeout(500)
  await page.mouse.click(640, 360); await page.evaluate(() => window.__czSkipBriefing())
  return { ctx, page }
}

const load = {}
for (const q of ['high', 'medium', 'low']) {
  const { ctx, page } = await open({ quality: q }); await page.waitForTimeout(3000)
  const st = await page.evaluate(async () => ({ d: await window.__czDrawStats(15), t: window.__czPerf().textures }))
  const px = await page.evaluate(() => { const c = document.querySelector('canvas'); return c.width * c.height })
  load[q] = { calls: st.d.calls, tris: st.d.triangles, textures: st.t, pixels: px }
  await ctx.close()
}
console.log(JSON.stringify(load))
check('pixels rendered fall with each preset: high > medium > low', load.high.pixels > load.medium.pixels && load.medium.pixels > load.low.pixels, load)
check('Low has fewer draw calls than High, and Medium is no heavier than High', load.low.calls < load.high.calls && load.medium.calls <= load.high.calls + 5, load)
check('Low holds fewer textures than High; Medium no more', load.low.textures < load.high.textures && load.medium.textures <= load.high.textures, load)

{
  const { ctx, page } = await open({ quality: 'auto' }, 4)
  const start = await page.evaluate(() => window.__czAutoQuality?.())
  let level = start?.level ?? 0
  for (let i = 0; i < 90 && level === 0; i++) { await page.waitForTimeout(1000); level = (await page.evaluate(() => window.__czAutoQuality?.()))?.level ?? level }
  const now = await page.evaluate(() => window.__czAutoQuality?.())
  check('Auto starts at High', start?.level === 0, start)
  check('Auto steps the tier down by itself when the frame rate cannot hold', level > 0, now)
  await ctx.close()
}
await b.close()
process.exit(fail ? 1 : 0)
