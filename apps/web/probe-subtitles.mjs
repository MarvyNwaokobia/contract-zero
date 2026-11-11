// In a fight, the radio line shows as a subtitle and follows the player's subtitle settings:
// on/off, size and background. Read from the real element in the running game.
//   node probe-subtitles.mjs [web]   (default http://localhost:3000)
import { chromium } from 'playwright'

const WEB = process.argv[2] ?? 'http://localhost:3000'
const b = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
let fail = 0
const check = (name, ok, detail) => { if (!ok) fail++; console.log(ok ? 'PASS' : 'FAIL', name, JSON.stringify(detail)) }

async function subtitle(subtitles) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await ctx.newPage()
  await page.addInitScript((sub) => { try { localStorage.setItem('cz_welcome_seen', '1'); localStorage.setItem('cz_tips_seen', JSON.stringify(['controls', 'loot', 'heal', 'cargo', 'extract'])); localStorage.setItem('cz_settings', JSON.stringify({ quality: 'low', subtitles: sub })) } catch {} }, subtitles)
  await page.goto(`${WEB}/dev/level?site=dustline-depot&kind=raid&phase=day&defense=2&seed=4`, { timeout: 180000, waitUntil: 'domcontentloaded' })
  await page.waitForSelector('canvas', { timeout: 180000 })
  for (let i = 0; i < 80 && !(await page.evaluate(() => !!window.__czField && !!window.__czSkipBriefing)); i++) await page.waitForTimeout(500)
  await page.mouse.click(640, 360); await page.evaluate(() => window.__czSkipBriefing()); await page.waitForTimeout(2500)
  const r = await page.evaluate(() => {
    const el = document.querySelector('[data-speaker-colors]')
    if (!el) return null
    const cs = getComputedStyle(el), txt = (el.textContent || '').trim()
    const r = el.getBoundingClientRect()
    const inner = el.querySelector('div, span, p')
    return { text: txt.slice(0, 60), shown: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && cs.opacity !== '0', bg: cs.backgroundColor, fontPx: inner ? parseFloat(getComputedStyle(inner).fontSize) : null, aria: el.getAttribute('aria-live') ?? el.closest('[aria-live]')?.getAttribute('aria-live') ?? null }
  })
  await ctx.close()
  return r
}
const on = await subtitle({ on: true, size: 'm', background: 0.45, speakerColors: true })
check('on: the radio line is shown as text', !!on && on.shown && on.text.length > 3, on)
const big = await subtitle({ on: true, size: 'l', background: 0.8, speakerColors: true })
const small = await subtitle({ on: true, size: 's', background: 0, speakerColors: true })
check('size: large is bigger than small', big && small && big.fontPx > small.fontPx, { large: big?.fontPx, small: small?.fontPx })
check('background: 0 is transparent, 0.8 is darker than 0.45', small && big && on && /rgba\(0, 0, 0, 0\)|transparent/.test(small.bg) && parseFloat(big.bg.split(',')[3]) > parseFloat(on.bg.split(',')[3]), { off: small?.bg, mid: on?.bg, dark: big?.bg })
const off = await subtitle({ on: false, size: 'm', background: 0.45, speakerColors: true })
check('off: no visible subtitle text', !off || !off.shown || off.text.length === 0, off)
await b.close()
process.exit(fail ? 1 : 0)
