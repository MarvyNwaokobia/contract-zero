// Browser probe for Milestone 1: the Operations Hub, operator creation and the
// restyled screens, in real Chrome against the live API.
//
//  - signed out: hub renders the hangar, shows the sign-in call to action, world status
//  - signed in (real NEP-413 session): no callsign → Kestrel prompts → /operator →
//    callsign saved → hub shows the operator card with the on-chain stash
//  - FPS of the hangar at each graphics preset (window.__czFps, after warm-up)
//  - screenshots of hub, operator, contracts, exchange, settings
//
// Usage: node probe-hub.mjs [webUrl] [apiUrl] [outDir]
import { homedir } from 'node:os'
import { chromium } from 'playwright'
import { loadKey, signIn } from '../../scripts/lib/cz-auth.mjs'

const WEB = process.argv[2] ?? 'http://localhost:3000'
const API = process.argv[3] ?? 'http://localhost:8080'
const OUT = process.argv[4] ?? '.'
const out = { fps: {}, checks: {}, errors: [] }
const VIEW = { width: 1440, height: 900 }

const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-gpu', '--ignore-gpu-blocklist'] })

async function fpsAt(ctx, quality) {
  const page = await ctx.newPage()
  page.on('pageerror', (e) => out.errors.push(`${quality}: ${e.message}`))
  await page.addInitScript((q) => localStorage.setItem('cz_settings', JSON.stringify({ quality: q })), quality)
  await page.goto(`${WEB}/`, { waitUntil: 'networkidle', timeout: 180_000 })
  await page.waitForFunction(() => (window).__czFps > 0, null, { timeout: 60_000 })
  await page.waitForTimeout(6000)
  const samples = []
  for (let i = 0; i < 5; i++) { samples.push(await page.evaluate(() => (window).__czFps)); await page.waitForTimeout(1000) }
  out.fps[quality] = { median: samples.sort((a, b) => a - b)[2], samples }
  return page
}

// ── signed out ──────────────────────────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: VIEW })
  for (const q of ['low', 'medium', 'high']) {
    const page = await fpsAt(ctx, q)
    if (q === 'high') {
      const t = await page.$eval('body', (b) => b.innerText)
      out.checks.signed_out = { cta: /sign in/i.test(t), world_status: /world status/i.test(t), next_op_or_reason: /raid|no depot/i.test(t) }
      await page.screenshot({ path: `${OUT}/m1-hub-signed-out.png` })
    }
    await page.close()
  }
  await ctx.close()
}

// ── signed in: operator creation, then the hub ─────────────────────────────
const full = loadKey(`${homedir()}/.contract-zero/keys/players-full/player.contract-zero.testnet.json`)
const login = await signIn(API, full.accountId, full.keyPair)
if (login.status !== 200) throw new Error('sign-in failed')
{
  const ctx = await browser.newContext({ viewport: VIEW })
  const [name, value] = login.cookie.split('=')
  await ctx.addCookies([{ name, value, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }])
  await ctx.addInitScript(() => localStorage.setItem('cz_settings', JSON.stringify({ quality: 'high' })))
  const page = await ctx.newPage()
  page.on('pageerror', (e) => out.errors.push(`signed-in: ${e.message}`))
  await page.goto(`${WEB}/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)
  const before = await page.$eval('body', (b) => b.innerText)
  out.checks.prompted_for_callsign = /create operator/i.test(before)
  if (/create operator/i.test(before)) {
    await page.click('text=Create operator')
    await page.waitForURL('**/operator')
    await page.waitForSelector('#callsign')
    await page.screenshot({ path: `${OUT}/m1-operator.png` })
    await page.fill('#callsign', 'WRAITH-6')
    await page.click('button:has-text("Report for duty")')
    await page.waitForURL(`${WEB}/`, { timeout: 30_000 })
  }
  await page.waitForSelector('text=WRAITH-6', { timeout: 30_000 })
  await page.waitForTimeout(5000)
  const t = await page.$eval('body', (b) => b.innerText)
  out.checks.signed_in = { callsign_on_hub: t.includes('WRAITH-6'), stash: /CREDITS[\s\S]*AMMO/i.test(t), deploy_cta: /brief & deploy|no depot/i.test(t) }
  out.fps.signed_in_high = await page.evaluate(() => (window).__czFps)
  await page.screenshot({ path: `${OUT}/m1-hub-signed-in.png` })
  for (const [path, file] of [['/contracts', 'm1-contracts'], ['/exchange', 'm1-exchange'], ['/settings', 'm1-settings']]) {
    await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)
    await page.screenshot({ path: `${OUT}/${file}.png`, fullPage: true })
  }
  await ctx.close()
}
out.gpu = await (async () => {
  const ctx = await browser.newContext(); const p = await ctx.newPage()
  const r = await p.evaluate(() => { const c = document.createElement('canvas'); const g = c.getContext('webgl2'); const d = g?.getExtension('WEBGL_debug_renderer_info'); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown' })
  await ctx.close(); return r
})()
console.log(JSON.stringify(out, null, 1))
await browser.close()
