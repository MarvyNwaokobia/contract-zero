// A page that is not on screen stops rendering: the Hub's hangar stops asking for animation
// frames, and a fight pauses. The tab is "hidden" the way the browser reports it (document.hidden
// and a visibilitychange event), because a headless browser has no tab to switch away from.
//   node probe-hidden.mjs [web]   (default http://localhost:3000)
import { chromium } from 'playwright'

const WEB = process.argv[2] ?? 'http://localhost:3000'
const b = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
let fail = 0
const check = (name, ok, detail) => { if (!ok) fail++; console.log(ok ? 'PASS' : 'FAIL', name, JSON.stringify(detail)) }
const hide = (page, v) => page.evaluate((v) => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => v }); document.dispatchEvent(new Event('visibilitychange')) }, v)
const rafCount = (page, ms = 1500) => page.evaluate((ms) => new Promise((res) => { let n = 0; const orig = window.requestAnimationFrame; window.requestAnimationFrame = (cb) => { n++; return orig.call(window, cb) }; setTimeout(() => { window.requestAnimationFrame = orig; res(n) }, ms) }), ms)

{
  const page = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  await page.addInitScript(() => { try { localStorage.setItem('cz_welcome_seen', '1'); localStorage.setItem('cz_settings', JSON.stringify({ quality: 'low' })) } catch {} })
  await page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded', timeout: 120000 }); await page.waitForSelector('canvas', { timeout: 120000 }); await page.waitForTimeout(8000)
  // A software renderer is slow, so count over a longer window; "visible" only needs to be clearly above zero.
  const on = await rafCount(page, 4000)
  await hide(page, true); await page.waitForTimeout(500)
  const off = await rafCount(page, 4000)
  await hide(page, false); await page.waitForTimeout(500)
  const back = await rafCount(page, 4000)
  check('Hub: the hangar asks for frames while visible', on > 3, { on })
  check('Hub: it stops asking while hidden', off === 0, { off })
  check('Hub: and resumes when visible again', back > 3, { back })
}
{
  const page = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
  await page.addInitScript(() => { try { localStorage.setItem('cz_welcome_seen', '1'); localStorage.setItem('cz_tips_seen', JSON.stringify(['controls', 'loot', 'heal', 'cargo', 'extract'])); localStorage.setItem('cz_settings', JSON.stringify({ quality: 'low' })) } catch {} })
  await page.goto(`${WEB}/dev/level?site=dustline-depot&kind=raid&phase=day&defense=2&seed=4`, { timeout: 180000, waitUntil: 'domcontentloaded' })
  await page.waitForSelector('canvas', { timeout: 180000 })
  for (let i = 0; i < 80 && !(await page.evaluate(() => !!window.__czField && !!window.__czSkipBriefing)); i++) await page.waitForTimeout(500)
  await page.mouse.click(640, 360); await page.evaluate(() => window.__czSkipBriefing()); await page.waitForTimeout(2000)
  const before = await page.getByRole('button', { name: /resume/i }).count()
  await hide(page, true); await page.waitForTimeout(800)
  const after = await page.getByRole('button', { name: /resume/i }).count()
  check('Fight: no pause menu while playing', before === 0, { before })
  check('Fight: leaving the tab opens the pause menu', after > 0, { after })
}
await b.close()
process.exit(fail ? 1 : 0)
