// Supply Orders and NEAR Intents in the browser: Exchange (trading partners, the order
// form, the market's orders, the official-protocol panel with a live dry quote and a
// refused game asset) and the War Room's procurement chains. Desktop and phone.
//   node probe-market.mjs [web] [api] [outdir]
import { chromium } from 'playwright';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { loadKey, signIn } from '../../scripts/lib/cz-auth.mjs';

const WEB = process.argv[2] ?? 'http://127.0.0.1:3000';
const API = process.argv[3] ?? 'http://127.0.0.1:8080';
const OUT = process.argv[4] ?? './market-out';
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(ok ? 'PASS' : 'FAIL', name, detail === '' ? '' : JSON.stringify(detail)); };
const key = loadKey(`${homedir()}/.contract-zero/keys/players-full/player.contract-zero.testnet.json`);
const login = await signIn(API, key.accountId, key.keyPair);
const eq = login.cookie.indexOf('=');
const b = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];

for (const [name, vp] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  const ctx = await b.newContext({ viewport: vp });
  await ctx.addCookies([{ name: login.cookie.slice(0, eq), value: login.cookie.slice(eq + 1), domain: new URL(API).hostname, path: '/' }]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${WEB}/exchange`, { waitUntil: 'networkidle', timeout: 120_000 }).catch(() => {});
  await page.waitForSelector('[data-testid=trading-partners]', { timeout: 60_000 });
  const partners = await page.$$eval('[data-testid^=partner-]', (els) => els.map((e) => e.getAttribute('data-testid')));
  if (name === 'desktop') {
    check('both trading partners are shown', partners.includes('partner-vex') && partners.includes('partner-halcyon'), partners);
    check('the supply order form is offered when signed in', !!(await page.$('[data-testid=new-order]')));
    const orders = await page.$$('[data-testid^=order-status-]');
    check('the market shows supply orders', orders.length > 0, `${orders.length} orders`);
    check('the official protocol is labelled apart', /Mainnet · 1Click · dry quotes only · not executed/i.test(await page.textContent('[data-testid=intents-path]')));
    await page.waitForSelector('[data-testid=intents-overview]', { timeout: 30_000 });
    check('the live asset list is shown, without CZ assets', /assets across .* chains supported/.test(await page.textContent('[data-testid=intents-overview]')) && /supported: no/.test(await page.textContent('[data-testid=intents-overview]')));
    await page.click('[data-testid=intents-quote-wNEAR]');
    await page.waitForSelector('[data-testid=intents-result]', { timeout: 30_000 });
    await page.waitForFunction(() => /Minimum received|refused|error/i.test(document.querySelector('[data-testid=intents-result]')?.textContent ?? ''), null, { timeout: 30_000 });
    const q = await page.textContent('[data-testid=intents-result]');
    check('a live dry quote shows receive, minimum, fees and expiry', /Minimum received/.test(q) && /bps/.test(q) && /expires/.test(q) && /dry quote/.test(q), q.slice(0, 160));
    await page.click('[data-testid=intents-quote-ammo]');
    await page.waitForFunction(() => /game asset/i.test(document.querySelector('[data-testid=intents-result]')?.textContent ?? ''), null, { timeout: 30_000 });
    check('a game asset is refused with the reason', true);
  }
  await page.screenshot({ path: `${OUT}/${name}-exchange.png`, fullPage: true });
  const ex = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
  check(`${name}: the Exchange has no sideways scroll`, ex.sw <= ex.iw + 1, ex);

  await page.goto(`${WEB}/war-room`, { waitUntil: 'networkidle', timeout: 120_000 }).catch(() => {});
  await page.waitForSelector('[data-testid=procurement]', { timeout: 60_000 });
  await page.waitForSelector('[data-testid^=proc-]', { timeout: 60_000 });
  if (name === 'desktop') {
    const first = await page.$('[data-testid^=proc-]');
    await first.click();
    const text = await first.textContent();
    check('a procurement chain shows proposals, the winner and settlement', /Merchant proposals/.test(text) && /Winning quote/.test(text) && /Settlement on NEAR/.test(text), text.slice(0, 200));
    check('the execution path says it is not NEAR Intents', /Not an official NEAR Intents transaction/.test(text));
    // Expand a filled one for the screenshot.
    for (const el of await page.$$('[data-testid^=proc-]')) {
      if (/filled/.test(await el.textContent())) { await el.evaluate((d) => { d.open = true; }); break; }
    }
  }
  await page.screenshot({ path: `${OUT}/${name}-warroom.png`, fullPage: true });
  const wr = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
  check(`${name}: the War Room has no sideways scroll`, wr.sw <= wr.iw + 1, wr);
  await ctx.close();
}
check('no page errors', errors.length === 0, errors.slice(0, 3));
fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1));
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
await b.close();
