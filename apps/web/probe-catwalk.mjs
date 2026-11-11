// Walk the Cinder Yard catwalk for real: start at the foot of the stair, hold forward, and check
// the floor rises to the deck height, that you can walk the deck, and that stepping off drops you.
//   node probe-catwalk.mjs [web]   (default http://localhost:3000)
import { chromium } from 'playwright'

const WEB = process.argv[2] ?? 'http://localhost:3000'
const b = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
await page.addInitScript(() => { try { localStorage.setItem('cz_welcome_seen', '1'); localStorage.setItem('cz_tips_seen', JSON.stringify(['controls', 'loot', 'heal', 'cargo', 'extract'])); localStorage.setItem('cz_settings', JSON.stringify({ quality: 'low' })) } catch {} })
await page.goto(`${WEB}/dev/level?site=cinder-yard&kind=raid&phase=day&defense=1&seed=4`, { timeout: 180000, waitUntil: 'domcontentloaded' })
await page.waitForSelector('canvas', { timeout: 180000 })
for (let i = 0; i < 80 && !(await page.evaluate(() => !!window.__czFloor && !!window.__czSkipBriefing)); i++) await page.waitForTimeout(500)
await page.mouse.click(640, 360); await page.evaluate(() => window.__czSkipBriefing()); await page.waitForTimeout(1500)
const floor = () => page.evaluate(() => window.__czFloor())
// A software renderer is slow and movement is frame-timed, so wait for a condition, not a fixed time.
const until = async (cond, ms = 45000) => { const t = Date.now(); let f = await floor(); while (!cond(f) && Date.now() - t < ms) { await page.waitForTimeout(200); f = await floor() } return f }
let fail = 0
const check = (name, ok, detail) => { if (!ok) fail++; console.log(ok ? 'PASS' : 'FAIL', name, JSON.stringify(detail)) }

await page.evaluate(() => { window.__czWarp(3, -19.5); window.__czLook(0, 0) }); await page.waitForTimeout(500)
const start = await floor()
check('on the ground at the foot of the stair', start.floor === 0, start)
await page.keyboard.down('w')
const up = await until((f) => f.floor >= 4.79)
await page.keyboard.up('w')
check('walking forward up the stair raises the floor to the deck', up.floor >= 4.79, up)
check('the eye rises with it (floor + standing eye)', Math.abs(up.eye - (up.floor + 1.6)) < 0.1, up)
await page.screenshot({ path: process.env.OUT_UP ?? '/tmp/catwalk-up.png' })

// On the deck, walk along it (turn east) and stay up; then step off its edge and drop.
await page.evaluate(() => window.__czLook(-1.5708, 0)); await page.waitForTimeout(300)
await page.keyboard.down('w')
const along = await until((f) => f.x > up.x + 1.5, 30000)
await page.keyboard.up('w')
check('walking along the deck keeps you up', along.floor >= 4.79 && along.x > up.x + 1, along)
await page.evaluate(() => window.__czLook(0, 0)); await page.waitForTimeout(300)
await page.keyboard.down('w'); await page.waitForTimeout(3000); await page.keyboard.up('w')
const off = await floor()
check('walking off the deck\'s side is stopped by the railing: you stay up, inside the deck', off.floor >= 4.79 && off.z >= -29.1 && off.z <= -27.9, off)
await page.evaluate(() => window.__czWarp(3, -22.5))
const mid = await until((f) => Math.abs(f.floor - 1.33) < 0.1, 20000)
check('half way up the stair the floor is half way up (z -22.5 is 28% of the 7.6 m climb)', Math.abs(mid.floor - 1.33) < 0.12, mid)
await page.evaluate(() => window.__czWarp(12, -10))
const ground = await until((f) => f.floor === 0, 30000)
check('away from the walkway you are back on the ground', ground.floor === 0, ground)
console.log('page errors', errs.slice(0, 3))
await b.close()
process.exit(fail || errs.length ? 1 : 0)
