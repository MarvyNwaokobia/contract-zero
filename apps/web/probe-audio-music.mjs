// The score across the game, measured. Moves between real screens by clicking the nav (client-side
// navigation, no reloads) and checks: exactly one AudioContext is ever created, it is the same one
// throughout, the score is playing and its state follows the screen. Then, on the fight bench,
// the level of every music state, and the results resolution.
// It measures levels and state. It cannot tell you how the music sounds.
// Usage: node probe-audio-music.mjs [webUrl]
import { chromium } from 'playwright'
const WEB = process.argv[2] ?? 'http://localhost:3000'
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
// count every AudioContext the page ever makes
await page.addInitScript(() => {
  try { localStorage.setItem('cz_welcome_seen', '1') } catch { /* private mode */ }   // the first-visit dialog would cover the nav
  window.__acCount = 0
  const Orig = window.AudioContext
  window.AudioContext = class extends Orig { constructor(...a) { super(...a); window.__acCount++ } }
})
const shared = (fn, arg) => page.evaluate(fn, arg)
const out = { errors, screens: [] }

await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded', timeout: 180_000 })
await page.waitForFunction(() => !!window.__czAudioShared, null, { timeout: 120_000 })
out.beforeGesture = await shared(() => ({ contexts: window.__acCount, unlocked: window.__czAudioShared.isUnlocked() }))
await page.mouse.click(640, 400)   // the first gesture unlocks sound for the whole app
await page.waitForTimeout(3500)
await shared(() => { window.__ctx0 = window.__czAudioShared.ctx })
const levelOf = async (key = 'music', ms = 1500) => { await shared(() => window.__czAudioShared.levels()); await page.waitForTimeout(ms); return shared((k) => window.__czAudioShared.levels()[k], key) }
await shared(() => window.__czAudioShared.levels()); await page.waitForTimeout(400)

const WANT = { '/ (Hub)': 'hub', '/war-room': 'table', '/contracts': 'prep', '/exchange': 'table', '/ (Hub again)': 'hub' }
const snap = async (name) => {
  // the page may still be compiling in dev: wait for its state rather than a fixed time
  await page.waitForFunction((want) => window.__czAudioShared.stats().music.state === want, WANT[name], { timeout: 45_000 }).catch(() => {})
  await page.waitForTimeout(2500)
  const s = await shared(() => { const a = window.__czAudioShared; const st = a.stats(); return { state: st.music.state, playing: st.music.playing, ctxState: a.ctx.state, sameContext: a.ctx === window.__ctx0, contexts: window.__acCount, roomTone: a.ambBus.gain.value } })
  out.screens.push({ screen: name, ...s, musicRms: await levelOf('music') })
}
await snap('/ (Hub)')
await page.click('a[href="/war-room"]'); await snap('/war-room')
await page.click('a[href="/contracts"]'); await snap('/contracts')
await page.click('a[href="/exchange"]'); await snap('/exchange')
await page.click('a[href="/"]'); await snap('/ (Hub again)')

// the fight bench: a different page, loaded fresh, so it has its own engine and gesture
const fight = await ctx.newPage()
fight.on('pageerror', (e) => errors.push(e.message))
await fight.goto(`${WEB}/dev/level?site=dustline-depot&phase=day&defense=1&seed=4`, { waitUntil: 'domcontentloaded', timeout: 180_000 })
await fight.waitForFunction(() => !!window.__czAudio, null, { timeout: 120_000 })
await fight.evaluate(() => window.__czSkipBriefing?.())
await fight.mouse.click(640, 380)
await fight.waitForTimeout(2500)
await fight.evaluate(() => window.__czAudio.levels()); await fight.waitForTimeout(300)
out.states = {}
for (const s of ['silent', 'hub', 'prep', 'infiltration', 'detection', 'combat', 'boss', 'extraction', 'results', 'table']) {
  // the fight sets its own base state every frame, so go through the override, which wins
  await fight.evaluate((s) => window.__czAudio.setMusicOverride(s === 'silent' ? 'silent' : s), s)
  await fight.waitForTimeout(3200)       // let the swell settle
  await fight.evaluate(() => window.__czAudio.levels())
  await fight.waitForTimeout(1500)
  out.states[s] = await fight.evaluate(() => ({ music: window.__czAudio.levels().music, state: window.__czAudio.stats().music.state }))
}
// the resolution on entering results, from combat
await fight.evaluate(() => window.__czAudio.setMusicOverride('combat')); await fight.waitForTimeout(3000)
await fight.evaluate(() => window.__czAudio.peaks())
await fight.evaluate(() => window.__czAudio.setMusicOverride('results')); await fight.waitForTimeout(500)
out.resolutionPeak = await fight.evaluate(() => window.__czAudio.peaks().music)
console.log(JSON.stringify(out, null, 1))
await browser.close()
