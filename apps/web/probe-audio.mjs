// The live mix, measured. Loads a real fight scene (the /dev/level bench: no account needed),
// unlocks audio with a click, and reads each channel's level from FpsAudio.levels():
//   - the baseline: environment and music are audible, combat and radio are quiet;
//   - a radio line dips the music (and leaves it audible);
//   - an explosion registers on Combat;
//   - pause holds the audio clock and a key press does not restart it.
// It measures levels only; it cannot tell you how anything sounds.
// Usage: node probe-audio.mjs [webUrl] [zone]
import { chromium } from 'playwright'
const WEB = process.argv[2] ?? 'http://localhost:3000'
const ZONE = process.argv[3] ?? 'DUSTLINE'
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await (await browser.newContext({ viewport: { width: 1280, height: 760 } })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto(`${WEB}/dev/level?zone=${ZONE}&defense=3&seed=4`, { waitUntil: 'domcontentloaded', timeout: 180_000 })
await page.waitForFunction(() => !!window.__czAudio, null, { timeout: 120_000 })
await page.evaluate(() => window.__czSkipBriefing?.())
await page.mouse.click(640, 380)
await page.waitForTimeout(4000)

const sample = (n = 8, gap = 60) => page.evaluate(async ({ n, gap }) => {
  const rows = []
  for (let i = 0; i < n; i++) { rows.push(window.__czAudio.levels()); await new Promise((r) => setTimeout(r, gap)) }
  const keys = Object.keys(rows[0] ?? {})
  return Object.fromEntries(keys.map((k) => [k, { mean: rows.reduce((s, r) => s + r[k], 0) / rows.length, peak: Math.max(...rows.map((r) => r[k])) }]))
}, { n, gap })

const out = { zone: ZONE, errors }
await page.evaluate(() => window.__czAudio.levels()) // builds the analysers; the first read is always silent
await page.waitForTimeout(300)
out.state = await page.evaluate(() => ({ ctx: window.__czAudio.ctx?.state, stats: window.__czAudio.stats() }))
out.baseline = await sample()

// A radio line over the music: read the duck gains the instant after, and the music level across
// the first half-second of the dip against the level just before it.
const musicBefore = (await sample(12)).music.mean
const duck = await page.evaluate(async () => {
  const a = window.__czAudio
  a.vo('dyn-probe', 'handler')
  await new Promise((r) => setTimeout(r, 100))
  return { music: a.musicDuck.gain.value, combat: a.combatDuck.gain.value, handling: a.interactDuck.gain.value, environment: a.ambDuck.gain.value }
})
const during = await sample(10, 40)
out.radio = { duckGains: duck, musicBefore, musicDuring: during.music.mean, ratio: during.music.mean / (musicBefore || 1), environmentDuring: during.environment.mean, radioStaticPeak: during.radio.peak }
await page.waitForTimeout(2600)
out.radio.musicRecovered = (await sample(10)).music.mean / (musicBefore || 1)

// A blast on Combat
await page.evaluate(() => { window.__czAudio.explosion([0, 1, -6]) })
await page.waitForTimeout(40)
out.explosion = (await sample(12, 25)).combat

// Pause holds
await page.evaluate(() => window.__czAudio.suspend('pause'))
await page.waitForTimeout(300)
out.pause = { stateAfterSuspend: await page.evaluate(() => window.__czAudio.ctx.state) }
await page.keyboard.press('KeyW')
await page.waitForTimeout(300)
out.pause.stateAfterKeyPress = await page.evaluate(() => window.__czAudio.ctx.state)
await page.evaluate(() => window.__czAudio.resume('pause'))
await page.waitForTimeout(400)
out.pause.stateAfterResume = await page.evaluate(() => window.__czAudio.ctx.state)
console.log(JSON.stringify(out, null, 1))
await browser.close()
