// Accessibility and input standards on the redesigned screens, with the dev sign-in:
//   axe (WCAG 2.1 A/AA) · keyboard (every tab stop shows focus; no trap) · reduced motion
//   (nothing keeps animating) · touch (targets at least 24x24 CSS px, WCAG 2.2 AA 2.5.8; and no
//   sideways scroll at phone width).
//   node probe-standards.mjs [web] [api]   (defaults http://localhost:3000, http://localhost:8080)
// Exits non-zero on any failure. It needs an API that allows dev sign-in (AUTH_DEV_LOGIN=1).
import { chromium } from 'playwright'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')
const WEB = process.argv[2] ?? 'http://localhost:3000'
const API = process.argv[3] ?? 'http://localhost:8080'
const PAGES = ['/', '/contracts', '/exchange', '/exchange#orders', '/exchange#partners', '/war-room', '/war-room#powers', '/war-room#supply', '/war-room#decisions', '/operator', '/settings#interface', '/dev/results', '/dev/identity']
const b = await chromium.launch()
let fail = 0
const bad = (kind, page, msg) => { fail++; console.log('FAIL', kind.padEnd(8), page.padEnd(20), msg) }
const ok = (kind, page, msg = '') => console.log('PASS', kind.padEnd(8), page.padEnd(20), msg)

async function ctxFor({ reduced = false, touch = false } = {}) {
  const ctx = await b.newContext({
    viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    ...(touch ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    reducedMotion: reduced ? 'reduce' : 'no-preference',
  })
  await ctx.addInitScript(() => { try { localStorage.setItem('cz_welcome_seen', '1'); localStorage.setItem('cz_tips_seen', JSON.stringify(['intel', 'exchange', 'table'])); localStorage.setItem('cz_settings', JSON.stringify({ quality: 'low' })) } catch {} })
  const p = await ctx.newPage()
  await p.request.post(`${API}/auth/dev`, { data: { account_id: 'standards.testnet' } })
  await p.request.post(`${API}/me/profile`, { data: { callsign: 'STANDARDS-1' } }).catch(() => {})
  await p.close()
  return ctx
}
const load = async (ctx, path) => { const p = await ctx.newPage(); await p.goto(WEB + path, { waitUntil: 'domcontentloaded', timeout: 120000 }); await p.waitForTimeout(6000); return p }

// 1. axe
{
  const ctx = await ctxFor()
  for (const path of PAGES) {
    const p = await load(ctx, path)
    await p.addScriptTag({ content: AXE })
    const v = await p.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.map((x) => ({ id: x.id, impact: x.impact, nodes: x.nodes.length, sample: x.nodes[0].target.join(' ') })))
    v.length ? bad('axe', path, v.map((x) => `${x.id}(${x.impact}) x${x.nodes} e.g. ${x.sample}`).join('; ')) : ok('axe', path)
    await p.close()
  }
  await ctx.close()
}

// 2. keyboard: tab through; every stop shows a focus indicator; focus never gets stuck
{
  const ctx = await ctxFor()
  for (const path of PAGES.filter((x) => !x.startsWith('/dev'))) {
    const p = await load(ctx, path)
    await p.evaluate(() => document.activeElement?.blur?.())
    const seen = new Set(); let noRing = []; let stuck = 0, prev = ''
    for (let i = 0; i < 70; i++) {
      await p.keyboard.press('Tab')
      const f = await p.evaluate(() => {
        const e = document.activeElement
        if (!e || e === document.body) return null
        const cs = getComputedStyle(e)
        const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none')
        const r = e.getBoundingClientRect()
        // A unique id per element (many cards share the same text), by its position in the document.
        const idx = [...document.querySelectorAll('*')].indexOf(e)
        return { id: e.tagName + '#' + idx + '|' + (e.getAttribute('data-testid') ?? (e.textContent || '').trim().slice(0, 24)), ring, visible: r.width > 0 && r.height > 0 }
      })
      if (!f) continue
      if (f.id === prev) stuck++; else stuck = 0
      prev = f.id; seen.add(f.id)
      if (f.visible && !f.ring) noRing.push(f.id)
      if (stuck > 3) break
    }
    noRing = [...new Set(noRing)]
    if (stuck > 3) bad('keyboard', path, `focus stuck on ${prev}`)
    else if (noRing.length) bad('keyboard', path, `no visible focus on: ${noRing.slice(0, 4).join(', ')}`)
    else ok('keyboard', path, `${seen.size} tab stops, all show focus`)
    await p.close()
  }
  await ctx.close()
}

// 3. reduced motion: nothing is left animating (except the 3D canvas, which is not a CSS animation)
{
  const ctx = await ctxFor({ reduced: true })
  for (const path of ['/', '/contracts', '/exchange', '/war-room', '/operator']) {
    const p = await load(ctx, path)
    const running = await p.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getComputedTiming?.().iterations === Infinity).map((a) => (a.effect?.target?.className?.toString?.() ?? a.effect?.target?.tagName ?? '?').slice(0, 40)))
    running.length ? bad('motion', path, `infinite animations still running: ${[...new Set(running)].slice(0, 4).join(' | ')}`) : ok('motion', path, 'no infinite animation runs')
    await p.close()
  }
  await ctx.close()
}

// 4. touch: target size and no sideways scroll
{
  const ctx = await ctxFor({ touch: true })
  for (const path of PAGES.filter((x) => !x.startsWith('/dev'))) {
    const p = await load(ctx, path)
    const r = await p.evaluate(() => {
      const small = []
      for (const e of document.querySelectorAll('a[href], button, input, select, textarea, [role=tab], [role=button], summary')) {
        const cs = getComputedStyle(e)
        let r = e.getBoundingClientRect()
        // A visually hidden radio or checkbox is operated through its label: measure that.
        if ((e.type === 'radio' || e.type === 'checkbox') && r.width <= 2 && e.closest('label')) r = e.closest('label').getBoundingClientRect()
        if (cs.visibility === 'hidden' || cs.display === 'none' || r.width === 0 || r.height === 0) continue
        if (e.closest('[hidden]') || e.hasAttribute('disabled')) continue
        // Inline links inside a sentence are exempt (WCAG 2.5.8); so are targets with enough spacing, which we do not count here.
        const inline = e.tagName === 'A' && getComputedStyle(e.parentElement).display !== 'flex' && e.parentElement.textContent.trim().length > e.textContent.trim().length + 12
        if (inline) continue
        if (r.width < 24 || r.height < 24) small.push(`${e.tagName.toLowerCase()}:${(e.getAttribute('aria-label') || e.getAttribute('data-testid') || e.textContent || e.id || '').trim().slice(0, 22)} ${Math.round(r.width)}x${Math.round(r.height)}`)
      }
      return { small: [...new Set(small)], over: document.documentElement.scrollWidth - document.documentElement.clientWidth }
    })
    r.over > 0 ? bad('touch', path, `scrolls sideways by ${r.over}px`) : r.small.length ? bad('touch', path, `${r.small.length} targets under 24x24: ${r.small.slice(0, 4).join(', ')}`) : ok('touch', path, 'targets >= 24x24, no sideways scroll')
    await p.close()
  }
  await ctx.close()
}
await b.close()
process.exit(fail ? 1 : 0)
