// Story in the browser: briefing card → the contract's own radio line in the fight
// → debrief on the results screen. The run ends by death (nothing settles on NEAR).
// Usage: node probe-story.mjs [webUrl] [apiUrl] [outDir]
import { chromium } from 'playwright'
import { homedir } from 'node:os'
import { loadKey, signIn } from '../../scripts/lib/cz-auth.mjs'

const WEB = process.argv[2] ?? 'http://127.0.0.1:3000'
const API = process.argv[3] ?? 'http://127.0.0.1:8080'
const OUT = process.argv[4] ?? '.'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const key = loadKey(`${homedir()}/.contract-zero/keys/players-full/player.contract-zero.testnet.json`)
const login = await signIn(API, key.accountId, key.keyPair)
if (login.status !== 200) throw new Error('sign-in failed')
const [name, value] = login.cookie.split(';')[0].split('=')

const board = (await (await fetch(`${API}/board`)).json()).board
const e = board.find((b) => b.kind === 'raid' && b.bounty) ?? board[0]
const b = await chromium.launch({ channel: 'chrome', args: ['--enable-gpu', '--ignore-gpu-blocklist'] })
const ctx = await b.newContext({ viewport: { width: 1280, height: 760 } })
await ctx.addCookies([{ name, value, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }])
const p = await ctx.newPage()
const errors = []
p.on('pageerror', (x) => errors.push(x.message))
let story = null
p.on('response', async (r) => { if (r.url().endsWith('/missions/start') && r.ok()) story = (await r.json()).story })

await p.goto(`${WEB}/deploy?target=${e.target}&resource=${e.resource}&kind=${e.kind}`, { waitUntil: 'networkidle' })
await p.getByRole('button', { name: 'Deploy' }).click()
await p.waitForSelector('[data-testid=briefing]')
await wait(2500)
await p.screenshot({ path: `${OUT}/story-briefing-typing.png` })
await p.waitForFunction(() => !/skip ▸/i.test(document.body.innerText), null, { timeout: 60000 })
const briefText = await p.innerText('[data-testid=briefing]')
await p.screenshot({ path: `${OUT}/story-briefing.png` })
const norm = (t) => t.replace(/\s+/g, ' ')
const missing = story.briefing.filter((l) => !norm(briefText).includes(norm(l.text))).map((l) => l.text)
const check = { codename: norm(briefText).toUpperCase().includes(story.codename), briefingLines: story.briefing.length, missing }

await p.keyboard.press('Enter')
await p.waitForSelector('canvas', { timeout: 120000 })
await p.waitForFunction(() => typeof window.__czMission === 'function', null, { timeout: 120000 })
await p.mouse.click(640, 380)
await p.evaluate(() => window.__czSkipBriefing())
const opening = story.radio.opStart[0].text
const heard = await p.waitForFunction((t) => document.body.innerText.includes(t), opening, { timeout: 90000 }).then(() => true).catch(() => false)
check.contractRadioHeard = heard
await p.screenshot({ path: `${OUT}/story-radio.png` })
check.fired = (await p.evaluate(() => window.__czStory())).fired

// Second wind revives once: keep killing until the run ends.
for (let i = 0; i < 6 && !(await p.$('[data-testid=debrief]')); i++) { await p.evaluate(() => window.__czKillPlayer?.()); await wait(8000) }
try {
  await p.waitForSelector('[data-testid=debrief]', { timeout: 120000 })
} catch (x) {
  await p.screenshot({ path: `${OUT}/story-stuck.png` })
  console.log('STUCK', JSON.stringify({ ...check, mission: await p.evaluate(() => window.__czMission?.()), text: (await p.innerText('body')).slice(0, 400), errors }))
  throw x
}
const debrief = await p.innerText('[data-testid=debrief]')
check.debrief = debrief.replace(/\s+/g, ' ').slice(0, 200)
await p.screenshot({ path: `${OUT}/story-debrief.png`, fullPage: true })
console.log(JSON.stringify({ contract: `${e.kind} ${e.target} ${e.resource} (${e.bounty?.sponsor_name ?? 'no sponsor'})`, ...check, errors }, null, 1))
await b.close()
