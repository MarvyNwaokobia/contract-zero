// The sounds of each real site, measured on the Environment channel:
//   - standing beside a source is louder than standing at the quietest point of the map;
//   - at the same distance from a source, a wall in the way lowers the level (the model's own gain
//     is printed beside the measured one);
//   - no more than the cap of voices is ever held.
// It measures levels. It cannot tell you how a site sounds.
// Usage: node probe-audio-soundscape.mjs [webUrl]
import { chromium } from 'playwright'
const WEB = process.argv[2] ?? 'http://localhost:3000'
const SITES = ['dustline-depot', 'blacksite', 'cinder-yard']
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
const report = {}
for (const site of SITES) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 760 } })).newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${WEB}/dev/level?site=${site}&phase=day&defense=1&seed=4`, { waitUntil: 'domcontentloaded', timeout: 180_000 })
  await page.waitForFunction(() => !!window.__czAudio && typeof window.__czWarp === 'function', null, { timeout: 120_000 })
  await page.evaluate(() => window.__czSkipBriefing?.())
  await page.mouse.click(640, 380)   // the gesture that unlocks audio and builds the soundscape
  await page.waitForFunction(() => !!window.__czAudio?.soundscape, null, { timeout: 30_000 })
  await page.waitForTimeout(2500)
  await page.evaluate(() => window.__czAudio.levels()); await page.waitForTimeout(300) // build the meters
  const env = async (ms = 1400) => { await page.evaluate(() => window.__czAudio.levels()); await page.waitForTimeout(ms); return page.evaluate(() => window.__czAudio.levels().environment) }
  const warp = async (x, z) => { await page.evaluate(([x, z]) => window.__czWarp(x, z), [x, z]); await page.waitForTimeout(1600) }
  const r = { errors }
  const info = await page.evaluate(() => {
    const a = window.__czAudio, s = a.soundscape, b = a.level.bounds
    const cont = s.list.filter((e) => ['engine', 'server', 'lamp', 'stack', 'pump', 'tank'].includes(e.kind))
    const kinds = {}; for (const e of s.list) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1
    // the quietest point: the grid cell farthest from every continuous source
    let far = null
    for (let x = b.minX + 2; x <= b.maxX - 2; x += 3) for (let z = b.minZ + 2; z <= b.maxZ - 2; z += 3) {
      const d = Math.min(...cont.map((e) => Math.hypot(e.x - x, e.z - z)))
      if (!far || d > far.d) far = { x, z, d }
    }
    // the loudest-by-model source worth standing at: prefer the strongest spec we can voice
    const target = cont.find((e) => e.kind === 'pump') ?? cont.find((e) => e.kind === 'engine') ?? cont.find((e) => e.kind === 'server') ?? cont[0]
    // a wall pair: the same distance (8 m) from some source, one clear and one walled
    let pair = null
    for (const e of cont) {
      const ring = Array.from({ length: 36 }, (_, i) => { const t = (i / 36) * Math.PI * 2; const x = e.x + Math.cos(t) * 8, z = e.z + Math.sin(t) * 8; return { x, z, m: s.mixAt(e.id, x, z) } })
        .filter((p) => p.x > b.minX + 1 && p.x < b.maxX - 1 && p.z > b.minZ + 1 && p.z < b.maxZ - 1)
      const blocked = ring.filter((p) => p.m.blocked > 0), clear = ring.filter((p) => p.m.blocked === 0)
      if (blocked.length && clear.length) { pair = { id: e.id, kind: e.kind, blocked: blocked[0], clear: clear[0] }; break }
    }
    return { kinds, far, target, pair }
  })
  r.kinds = info.kinds
  // beside a source vs the quietest point
  await warp(info.far.x, info.far.z)
  r.quiet = { at: [info.far.x, info.far.z], nearestSource: +info.far.d.toFixed(1), env: await env(), voices: await page.evaluate(() => window.__czAudio.soundscape.activeCount()) }
  await warp(info.target.x + 1.5, info.target.z)
  r.besideSource = { source: info.target.id, env: await env(), voices: await page.evaluate(() => window.__czAudio.soundscape.activeCount()) }
  // the same distance, with and without a wall
  if (info.pair) {
    const p = info.pair
    // only this source, so the two positions differ by the wall and nothing else
    await page.evaluate((id) => window.__czAudio.soundscape.isolate(id), p.id)
    await warp(p.clear.x, p.clear.z); const clearEnv = await env(1600)
    await warp(p.blocked.x, p.blocked.z); const blockedEnv = await env(1600)
    r.wall = { source: p.id, kind: p.kind, clear: { env: clearEnv, modelGain: +p.clear.m.gain.toFixed(3), lowpass: Math.round(p.clear.m.lowpass) }, blocked: { env: blockedEnv, modelGain: +p.blocked.m.gain.toFixed(3), lowpass: Math.round(p.blocked.m.lowpass) } }
  }
  r.maxVoicesSeen = await page.evaluate(() => window.__czAudio.soundscape.activeCount())
  report[site] = r
  await page.close()
}
console.log(JSON.stringify(report, null, 1))
await browser.close()
