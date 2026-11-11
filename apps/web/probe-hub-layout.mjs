// The Hub's way in must never be clipped: at common laptop and phone sizes the "Brief & deploy"
// button is on screen without scrolling, and nothing overflows sideways.
// Needs the web app (default http://localhost:3000) and an API with at least one open contract.
import { chromium } from 'playwright'

const WEB = process.env.WEB_URL ?? 'http://localhost:3000'
const API = process.env.API_URL ?? 'http://localhost:8080'
const SIZES = [[1280, 720], [1366, 768], [1920, 1080], [390, 844]]
const b = await chromium.launch()
let failed = 0
for (const [w, h] of SIZES) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } })
  const page = await ctx.newPage()
  await page.addInitScript(() => { try { localStorage.setItem('cz_settings', JSON.stringify({ quality: 'low' })); localStorage.setItem('cz_welcome_seen', '1') } catch {} })
  await page.request.post(`${API}/auth/dev`, { data: { account_id: 'probe.testnet' } }).catch(() => {})
  await page.goto(WEB + '/', { waitUntil: 'domcontentloaded' })
  const cta = page.getByRole('link', { name: /brief & deploy|sign in to deploy/i })
  await cta.waitFor({ timeout: 60000 })
  const box = await cta.boundingBox()
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  const ok = !!box && box.y >= 0 && box.y + box.height <= h && over <= 0
  if (!ok) failed++
  console.log(ok ? 'PASS' : 'FAIL', `${w}x${h}`, box ? `button y=${Math.round(box.y)}..${Math.round(box.y + box.height)}` : 'no button', `overflowX=${over}`)
  await ctx.close()
}
await b.close()
process.exit(failed ? 1 : 0)
