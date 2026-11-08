// War Room: renders the map, faction cards, causal chains and a labelled simulation.
import { chromium } from 'playwright'
const BASE = process.argv[2] ?? 'http://127.0.0.1:3000'
const OUT = process.argv[3] ?? '.'
const b = await chromium.launch({ channel: 'chrome' })
const p = await b.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
p.on('pageerror', (e) => errors.push(e.message))
p.on('response', (r) => r.status() >= 400 && !r.url().endsWith('/auth/session') && !r.url().includes('favicon') && errors.push(`${r.status()} ${r.url()}`))
await p.goto(`${BASE}/war-room`, { waitUntil: 'networkidle' })
await p.waitForSelector('[data-testid=causal-chain]', { timeout: 60000 })
const text = await p.innerText('body')
const chains = await p.$$eval('[data-testid=causal-chain]', (els) => els.length)
const settled = (text.match(/on NEAR/gi) ?? []).length
const check = { map: /dustline depot/i.test(text) && /ashen refinery/i.test(text) && /vex exchange/i.test(text), factions: /treasury/i.test(text), chains, settled, seven: ['Trigger', 'Observed', 'Proposal', 'Validation', 'Transaction', 'World', 'Gameplay'].every((s) => text.toUpperCase().includes(s.toUpperCase())) }
await p.screenshot({ path: `${OUT}/warroom-top.png` })
await p.click('text=Run simulation')
await p.waitForSelector('text=Conservation', { timeout: 120000 })
const obs = await p.innerText('[data-testid=observer]')
check.simLabelled = obs.includes('SIMULATION') && obs.includes('Nothing here is live')
check.conserved = obs.includes('holds')
await p.locator('[data-testid=observer]').screenshot({ path: `${OUT}/warroom-observer.png` })
await p.screenshot({ path: `${OUT}/warroom-full.png`, fullPage: true })
await p.setViewportSize({ width: 390, height: 844 })
await p.screenshot({ path: `${OUT}/warroom-phone.png` })
check.hscroll = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
console.log(JSON.stringify({ ...check, errors }, null, 1))
await b.close()
