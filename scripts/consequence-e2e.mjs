#!/usr/bin/env node
// The recorded consequence of a real, extracted raid, end to end.
//
// Plays one legitimate raid through the event protocol (walk in, hold E on a case, walk
// out, extract), completes it, then checks what the server recorded: the target before and
// after, the engine's plan for the next raid, a stable replay, the commander's real
// decisions in the aftermath, and the War Room's operations list.
//
// Needs an OFF-CHAIN API with development sign-in, on a fresh database, and a fast clock:
//   AUTH_DEV_LOGIN=1 WORLD_SCENARIO=acceptance WORLD_TICK_SECS=20 cargo run   (in apps/api)
//   node scripts/consequence-e2e.mjs [apiUrl]
// It never touches NEAR. For the on-chain run see scripts/field-e2e.mjs.
import { readFileSync } from 'node:fs'

const API = process.argv[2] ?? 'http://127.0.0.1:8080'
const LAYOUTS = JSON.parse(readFileSync(new URL('../apps/api/src/services/layouts.json', import.meta.url), 'utf8'))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, detail) }

let cookie = ''
const call = async (method, path, body) => {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const c = r.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
await call('POST', '/auth/dev', { account_id: 'wraith.testnet' })

const before = (await call('GET', '/world')).body
const vgAmmo0 = before.actors.find((a) => a.id === 'vanguard').holdings.ammo
const s = (await call('POST', '/missions/start', { target: 'vanguard', resource: 'ammo', kind: 'raid' })).body
const at = Date.now()
console.log('started', s.session, s.mission.site?.name, `${s.mission.cargo.units} units, ${s.mission.field.cases.length} cases`)
const layout = LAYOUTS[s.mission.site.layout]

let seq = 0, pos = [...layout.start], last
const send = async (kind, extra = {}) => {
  const ev = { seq: ++seq, t: Date.now() - at, pos: pos.map((v) => +v.toFixed(2)), kind, ...extra }
  last = (await call('POST', `/missions/${s.session}/events`, { events: [ev] })).body
}
const walk = async (to) => {
  for (;;) {
    const d = Math.hypot(to[0] - pos[0], to[1] - pos[1]); if (d < 0.05) return
    const step = Math.min(d, 3); await wait(1000)
    pos = [pos[0] + ((to[0] - pos[0]) * step) / d, pos[1] + ((to[1] - pos[1]) * step) / d]; await send('pos')
  }
}
const case1 = s.mission.field.cases[0]
await walk(layout.entry); await send('reach', { milestone: 'entry' })
await walk(layout.push); await send('reach', { milestone: 'push' })
await walk(layout.cases[0])
await send('hold_start', { object: case1.id }); await wait(2150); await send('collect', { object: case1.id })
check('the server saw the case taken', last.carried?.includes(case1.id), JSON.stringify(last.carried))
await walk(layout.exfil.pos)
await send('extract_call'); await wait(8300); await send('extract_complete')
check('the server saw the extraction', last.phase === 'extracted')

const done = (await call('POST', `/missions/${s.session}/complete`, { outcome: 'extracted', kills: 4 })).body
const r = done.result
check('extracted and paid the carried case', r.outcome === 'extracted' && r.extracted_units === case1.units, `${r.extracted_units} of ${r.manifest} (${r.reason ?? 'ok'})`)
const c = r.consequence
check('consequence recorded and closed', !!c?.before && !!c?.after && c.settled_tick != null)
check('before is the stock the player faced', c.before.holdings.ammo === vgAmmo0, `${c.before.holdings.ammo} (world had ${vgAmmo0})`)
// The world keeps producing and consuming while the player is in the field, so the net
// change is the carried units plus whatever the clock did; the unexplained part must be small.
const hours = c.settled_tick - c.before.tick
const residual = (c.after.holdings.ammo - c.before.holdings.ammo) + r.extracted_units
check('the target stock fell by the carried units, give or take the clock', c.after.holdings.ammo < c.before.holdings.ammo && Math.abs(residual) <= 3 * Math.max(1, hours), `${c.before.holdings.ammo} -> ${c.after.holdings.ammo}, took ${r.extracted_units}, clock ${residual >= 0 ? '+' : ''}${residual} over ${hours}h`)
check('the player holds what was taken', r.player_holdings.cargo === r.extracted_units, `${r.player_holdings.cargo}`)
const g = (p) => p ? p.hall.rifles + p.hall.sidearms + p.yard.rifles + p.yard.sidearms : null
console.log('   faced guards', g(c.faced.guards), 'rifles', c.faced.guards.hall.rifles + c.faced.guards.yard.rifles, '| next guards', g(c.next.guards), 'rifles', c.next.guards ? c.next.guards.hall.rifles + c.next.guards.yard.rifles : null, '| next manifest', c.faced.manifest, '->', c.next.manifest, '| next available', c.next.available, c.next.reason ?? '')
check('the next plan is the engine\'s own and is no stronger', !c.next.available || g(c.next.guards) <= g(c.faced.guards))
const again = (await call('POST', `/missions/${s.session}/complete`, { outcome: 'extracted', kills: 4 })).body
check('replay returns the same closed record', again.replayed === true && again.result.consequence?.after?.holdings?.ammo === c.after.holdings.ammo)

// The commander reacts on its own turns: wait for real decisions after the settle tick.
let after = {}
for (let i = 0; i < 18; i++) {
  after = (await call('GET', `/missions/${s.session}/aftermath`)).body
  if (after.decisions?.length) break
  await wait(10_000)
}
check('the commander\'s real decisions appear in the aftermath', after.settled === true && after.decisions.length > 0, `${after.decisions?.length} decisions`)
for (const d of (after.decisions ?? []).slice(0, 4)) console.log('   ', 'tick', d.tick, d.payload.validation, '-', (d.payload.rationale ?? '').slice(0, 110))
const ops = (await call('GET', '/warroom/operations?limit=5')).body.operations
const mine = ops.find((o) => o.extracted_units === r.extracted_units && o.outcome === 'extracted')
check('the War Room lists the operation with its snapshots and decisions', !!mine && mine.consequence.after && mine.decisions.length > 0, `${ops.length} operation(s)`)
console.log(JSON.stringify({ settlement: mine?.settlement ?? null, kind: mine?.kind, bounty: mine?.bounty }))
const ok = results.every(Boolean)
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(ok ? 0 : 1)
