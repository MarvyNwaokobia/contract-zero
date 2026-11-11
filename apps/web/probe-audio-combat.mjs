// Combat audio on each real site, measured with the channel meters (FpsAudio.levels() and peaks(),
// which accumulate in the audio thread, so a short sound cannot fall between two reads):
//   - walking under a roof switches the reverb from open ground to a room;
//   - a round that misses but passes close registers on Combat (and a wide one does not);
//   - alarm level 3 is louder than level 1;
//   - the extraction engine raises the Environment level while it runs, and falls away after.
// It measures levels and graph state. It cannot tell you how any of it sounds.
// Usage: node probe-audio-combat.mjs [webUrl]
import { chromium } from 'playwright'
const WEB = process.argv[2] ?? 'http://localhost:3000'
// A point under a roof on each site (from the level's own `art` roofs), and its gate (the start).
const SITES = { 'dustline-depot': [-16, -36], blacksite: [0, -20], 'cinder-yard': [0, -46.5] }
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
const report = {}
for (const [site, inside] of Object.entries(SITES)) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 760 } })).newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${WEB}/dev/level?site=${site}&phase=day&defense=1&seed=4`, { waitUntil: 'domcontentloaded', timeout: 180_000 })
  await page.waitForFunction(() => !!window.__czAudio && typeof window.__czWarp === 'function', null, { timeout: 120_000 })
  await page.evaluate(() => window.__czSkipBriefing?.())
  await page.mouse.click(640, 380)
  await page.waitForTimeout(2500)
  const r = { errors }
  // The loudest sample on a channel in the `ms` after `act()`. peaks() resets on read, so read once first.
  const peakOnce = async (key, act, ms, arg) => { await page.evaluate(() => window.__czAudio.peaks()); await page.evaluate(act, arg); await page.waitForTimeout(ms); return page.evaluate((key) => window.__czAudio.peaks()[key], key) }
  // Median of three, a second apart: one stray guard or a scheduler hiccup cannot decide the answer.
  const peakAfter = async (key, act, ms = 500, arg) => { const v = []; for (let i = 0; i < 3; i++) { v.push(await peakOnce(key, act, ms, arg)); await page.waitForTimeout(900) } return v.sort((x, y) => x - y)[1] }
  // Mean level of a channel over a window.
  const rms = async (key, ms = 700) => { await page.evaluate(() => window.__czAudio.levels()); await page.waitForTimeout(ms); return page.evaluate((key) => window.__czAudio.levels()[key], key) }
  await page.evaluate(() => window.__czAudio.levels()); await page.waitForTimeout(300)   // build the meters

  // near miss: a shooter 60 m away (too far to hear); the round passes 1 m wide of the head (heard) or 9 m wide (not).
  // The decoded rifle samples are the real ones; nothing is replaced.
  r.samples = await page.evaluate(() => window.__czAudio.stats().samples)
  const shoot = (offset) => { const a = window.__czAudio; a.enemyShot([a.lx + offset, 1.6, a.lz - 60], { impact: [a.lx + offset, 1.6, a.lz + 20], hit: false }) }
  r.baselineCombat = await peakAfter('combat', () => {})
  r.nearMissPeak = await peakAfter('combat', shoot, 500, 1)
  r.wideMissPeak = await peakAfter('combat', shoot, 500, 9)

  // a shot from 34 m: audible, late and dull
  r.farShotPeak = await peakAfter('combat', () => { const a = window.__czAudio; a.enemyShot([a.lx, 1.6, a.lz - 34]) }, 900)
  r.nearShotPeak = await peakAfter('combat', () => { const a = window.__czAudio; a.enemyShot([a.lx, 1.6, a.lz - 6]) }, 900)

  // alarm escalation
  r.alarm1Peak = await peakAfter('combat', () => window.__czAudio.alarm(1.2, 1), 1500)
  r.alarm3Peak = await peakAfter('combat', () => window.__czAudio.alarm(1.2, 3), 1500)

  // the ride-in engine on Environment
  r.envBefore = await rms('environment')
  await page.evaluate(() => window.__czAudio.setExtraction(true)); await page.waitForTimeout(5000)
  r.envWithEngine = await rms('environment')
  await page.evaluate(() => window.__czAudio.setExtraction(false)); await page.waitForTimeout(3500)
  r.envAfter = await rms('environment')
  // Last, because walking into a building wakes its guards, whose gunfire would pollute the rest.
  // indoors / outdoors
  const space = () => page.evaluate(() => { const a = window.__czAudio; return { indoors: a.isIndoors(), room: +a.roomWet.gain.value.toFixed(2), open: +a.openWet.gain.value.toFixed(2) } })
  await page.waitForTimeout(500)
  r.atGate = await space()
  await page.evaluate(([x, z]) => window.__czWarp(x, z), inside)
  await page.waitForTimeout(900)
  r.underRoof = await space()

  report[site] = r
  await page.close()
}
console.log(JSON.stringify(report, null, 1))
await browser.close()
