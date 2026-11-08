// Owned gear and standing in the browser: the Exchange's armory and standing, the
// loadout's owned and locked guns, the operator's service record. Read-only.
// Usage: node probe-gear.mjs [webUrl] [apiUrl] [outDir]
import { chromium } from 'playwright'
import { homedir } from 'node:os'
import { loadKey, signIn } from '../../scripts/lib/cz-auth.mjs'

const WEB = process.argv[2] ?? 'http://127.0.0.1:3000'
const API = process.argv[3] ?? 'http://127.0.0.1:8080'
const OUT = process.argv[4] ?? '.'
const key = loadKey(`${homedir()}/.contract-zero/keys/players-full/player.contract-zero.testnet.json`)
const login = await signIn(API, key.accountId, key.keyPair)
const [name, value] = login.cookie.split(';')[0].split('=')
const b = await chromium.launch({ channel: 'chrome', args: ['--enable-gpu', '--ignore-gpu-blocklist'] })
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } })
await ctx.addCookies([{ name, value, domain: new URL(WEB).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }])
const p = await ctx.newPage()
const errors = []
p.on('pageerror', (e) => errors.push(e.message))
const out = {}

await p.goto(`${WEB}/exchange`, { waitUntil: 'networkidle' })
await p.waitForSelector('[data-testid=armory-item]')
await p.waitForTimeout(3000)
out.armory = (await p.$$eval('[data-testid=armory-item]', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' '))))
out.standing = (await p.innerText('[data-testid=standing]')).replace(/\s+/g, ' ')
await p.locator('[data-testid=armory-item]').first().scrollIntoViewIfNeeded()
await p.screenshot({ path: `${OUT}/gear-exchange-armory.png` })
await p.locator('[data-testid=standing]').scrollIntoViewIfNeeded()
await p.screenshot({ path: `${OUT}/gear-exchange-standing.png` })

const board = (await (await fetch(`${API}/board`)).json()).board
const e = board.find((x) => x.kind === 'raid')
await p.goto(`${WEB}/deploy?target=${e.target}&resource=${e.resource}&kind=raid`, { waitUntil: 'networkidle' })
await p.waitForSelector('[data-testid^=gear-]')
await p.waitForTimeout(2500)
out.loadout = await p.$$eval('[data-testid^=gear-]', (els) => els.map((e) => `${e.getAttribute('data-testid')} ${e.hasAttribute('disabled') ? 'locked' : 'selectable'}: ${e.innerText.replace(/\s+/g, ' ')}`))
await p.screenshot({ path: `${OUT}/gear-loadout.png` })

await p.goto(`${WEB}/operator`, { waitUntil: 'networkidle' })
await p.waitForSelector('[data-testid=service-record]')
out.record = (await p.innerText('[data-testid=service-record]')).replace(/\s+/g, ' ').slice(0, 500)
await p.screenshot({ path: `${OUT}/gear-service-record.png`, fullPage: true })
console.log(JSON.stringify({ ...out, errors }, null, 1))
await b.close()
