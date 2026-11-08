// Browser probe for /exchange: renders against the live API, shows chain holdings for
// a typed (view-only) account, and opens the NEAR wallet picker on "Connect".
// Usage: node probe-exchange.mjs [baseUrl] [outDir]
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://localhost:3100'
const OUT = process.argv[3] ?? '.'
const PLAYER = 'player.contract-zero.testnet'

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
await page.addInitScript((p) => localStorage.setItem('cz_player', p), PLAYER)

await page.goto(`${BASE}/exchange`, { waitUntil: 'networkidle', timeout: 180_000 })
await page.waitForSelector('text=MARKET', { timeout: 60_000 })
await page.waitForSelector('text=YOUR HOLDINGS (ON NEAR)', { timeout: 30_000 })
const text = await page.evaluate(() => document.body.innerText)
await page.screenshot({ path: `${OUT}/exchange.png`, fullPage: true })
const out = {
  market: /Ammunition[\s\S]*Vex sells at[\s\S]*Vex buys at/.test(text),
  holdings_on_near: text.includes('YOUR HOLDINGS (ON NEAR)'),
  view_only_notice: text.includes(`Viewing as ${PLAYER}`),
  buy_disabled_without_wallet: await page.locator('button:has-text("Buy")').first().isDisabled(),
  signals: text.includes('MARKET SIGNALS'),
}
await page.click('text=Connect NEAR wallet')
await page.waitForTimeout(4000)
await page.screenshot({ path: `${OUT}/exchange-connect.png` })
const after = await page.evaluate(() => document.body.innerText)
out.wallet_picker = /HOT|Meteor|MyNearWallet|Intear|Nightly|wallet/i.test(after.replace(text, ''))
out.errors = errors
console.log(JSON.stringify(out, null, 1))
await browser.close()
