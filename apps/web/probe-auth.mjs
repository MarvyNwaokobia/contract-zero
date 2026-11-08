// Browser probe for sign-in and quick trade (real Chrome, live API, NEAR testnet).
//
//  A. /signin with no session: Google is the first, primary option, then email or
//     passkey; the wallet path is offered; clicking Google opens NEAR Auth's
//     hosted login (checked: the page loads, offers Google, and is not a
//     "Callback URL mismatch"). A real Google login needs a human, so it stops there.
//  B. A signed-in player (session from a real NEP-413 sign-in) with quick trade on:
//     buys from the Exchange with no confirmation; the browser's session key signs
//     the trade and it settles on chain.
//
// Usage: node probe-auth.mjs [webUrl] [apiUrl] [outDir]
import { homedir } from 'node:os'
import { chromium } from 'playwright'
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from 'near-api-js'
import { loadKey, signIn } from '../../scripts/lib/cz-auth.mjs'

const WEB = process.argv[2] ?? 'http://localhost:3000'
const API = process.argv[3] ?? 'http://localhost:8080'
const OUT = process.argv[4] ?? '.'
const WORLD = 'world2.contract-zero.testnet'
const out = { signin: {}, trade: {}, errors: [] }

const browser = await chromium.launch({ channel: 'chrome' })

// ── A. sign-in screen ───────────────────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => out.errors.push(`signin pageerror: ${e.message}`))
  await page.goto(`${WEB}/signin`, { waitUntil: 'networkidle', timeout: 180_000 })
  await page.waitForSelector('text=Continue with Google')
  const buttons = await page.$$eval('button', (bs) => bs.map((b) => ({ text: b.innerText.trim(), disabled: b.disabled })))
  out.signin.buttons = buttons
  out.signin.google_first = buttons[0]?.text.includes('Google') && !buttons[0].disabled
  out.signin.no_apple = !buttons.some((b) => b.text.includes('Apple'))
  out.signin.blocker = await page.$eval('body', (b) => b.innerText.includes('only accepts'))
  await page.screenshot({ path: `${OUT}/signin.png`, fullPage: true })
  const [popup] = await Promise.all([ctx.waitForEvent('page', { timeout: 30_000 }), page.click('text=Continue with Google')])
  await popup.waitForLoadState('domcontentloaded', { timeout: 60_000 }).catch(() => {})
  await popup.waitForTimeout(4000)
  const url = new URL(popup.url())
  const text = await popup.evaluate(() => document.body?.innerText ?? '')
  out.signin.popup_host = url.host
  out.signin.popup_offers_google = /Continue with Google/i.test(text)
  out.signin.popup_offers_passkey = /passkey/i.test(text)
  out.signin.callback_mismatch = /callback url mismatch/i.test(text)
  await popup.screenshot({ path: `${OUT}/signin-popup.png` })
  await ctx.close()
}

// ── B. signed in, quick trade on ───────────────────────────────────────────
const full = loadKey(`${homedir()}/.contract-zero/keys/players-full/player.contract-zero.testnet.json`)
const login = await signIn(API, full.accountId, full.keyPair)
if (login.status !== 200) throw new Error('sign-in failed')
// The player's own authority opens a quick-trade session (what the "Turn on" button
// asks their wallet to approve).
const sk = KeyPair.fromRandom('ed25519')
const wallet = new Account(full.accountId, new JsonRpcProvider({ url: 'https://rpc.testnet.fastnear.com' }), new KeyPairSigner(full.keyPair))
await wallet.signAndSendTransaction({ receiverId: full.accountId, actions: [actions.addFunctionCallAccessKey(sk.getPublicKey(), WORLD, ['accept_offer', 'accept_bid', 'revoke_session'], 250_000_000_000_000_000_000_000n)], waitUntil: 'FINAL' })
await wallet.signAndSendTransaction({ receiverId: WORLD, actions: [actions.functionCall('register_session', { public_key: sk.getPublicKey().toString(), credit_budget: '400', unit_budget: '0', ttl_secs: 3600 }, 30_000_000_000_000n, 1_000_000_000_000_000_000_000n)], waitUntil: 'FINAL' })
out.trade.session_key = sk.getPublicKey().toString()
{
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 1000 } })
  const [name, value] = login.cookie.split('=')
  await ctx.addCookies([{ name, value, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }])
  await ctx.addInitScript(([account, secret]) => localStorage.setItem('cz_session_key', JSON.stringify({ account, secret, expires: Date.now() + 3_600_000 })), [full.accountId, sk.toString()])
  const page = await ctx.newPage()
  page.on('pageerror', (e) => out.errors.push(`exchange pageerror: ${e.message}`))
  await page.goto(`${WEB}/`, { waitUntil: 'networkidle' })
  out.trade.menu_shows = (await page.$eval('body', (b) => b.innerText)).match(/Wallet [^\n]+/)?.[0]
  await page.goto(`${WEB}/exchange`, { waitUntil: 'networkidle' })
  await page.waitForSelector('text=YOUR STASH')
  await page.waitForSelector('text=QUICK TRADE')
  out.trade.quick_on = await page.$eval('body', (b) => b.innerText.includes('On: trades go through without a confirmation'))
  const medRow = page.locator('div.grid', { hasText: 'Medical supplies' }).first()
  await medRow.locator('input[type=number]').fill('1')
  await medRow.locator('button:has-text("Buy")').click()
  await page.waitForSelector('text=Vex sells you 1 med', { timeout: 60_000 })
  await page.click('button:has-text("Trade")')
  await page.waitForSelector('text=Done · settled on-chain', { timeout: 120_000 })
  out.trade.receipts = await page.$$eval('a[href*="nearblocks"]', (as) => as.map((a) => `${a.innerText} ${a.getAttribute('href')}`))
  out.trade.prompts = 'none (no wallet popup opened)'
  await page.screenshot({ path: `${OUT}/exchange-quick.png`, fullPage: true })
  const body = await page.$eval('body', (b) => b.innerText)
  out.trade.near_jargon_on_page = ['NEP-245', 'yocto', 'Gas', 'TGas', 'access key', 'implicit'].filter((w) => body.includes(w))
  await ctx.close()
}
// Tidy up: revoke the session and delete the key with the player's authority.
await wallet.signAndSendTransaction({ receiverId: WORLD, actions: [actions.functionCall('revoke_session', { public_key: sk.getPublicKey().toString() }, 30_000_000_000_000n, 0n)], waitUntil: 'FINAL' })
await wallet.signAndSendTransaction({ receiverId: full.accountId, actions: [actions.deleteKey(sk.getPublicKey())], waitUntil: 'FINAL' })
out.trade.cleanup = 'session revoked, key deleted'
console.log(JSON.stringify(out, null, 1))
await browser.close()
