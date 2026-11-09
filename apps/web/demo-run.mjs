// CONTRACT ZERO acceptance run (brief §17), end to end in a real browser, recorded.
//
// Walks the thirteen steps against the live API, the live world and NEAR testnet,
// checks each one, screenshots it and writes a video of the whole run.
//
// What is scripted, stated plainly:
//   • Sign-in uses the player's own key (a NEP-413 signed challenge, the same path a
//     wallet takes) instead of a Google pop-up a script cannot drive.
//   • Quick trade is opened with the player's own key (AddKey + register_session),
//     the same two transactions the Exchange asks a wallet to approve.
//   • The fight is flown by the scene's dev hooks (warp to each objective, clear the
//     rooms). The server still measures the mission time and rejects a run faster
//     than the mission physically takes, so the run waits that out.
// Nothing else is faked: the contract, the settlement, the trade and the factions'
// response are the live system's.
//
// Usage: node demo-run.mjs [webUrl] [apiUrl] [outDir]
import { mkdirSync, writeFileSync, readdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { chromium } from 'playwright'
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from 'near-api-js'
import { loadKey, signIn } from '../../scripts/lib/cz-auth.mjs'

const WEB = process.argv[2] ?? 'http://127.0.0.1:3000'
const API = process.argv[3] ?? 'http://127.0.0.1:8080'
const OUT = process.argv[4] ?? 'demo-out'
const RPC = 'https://rpc.testnet.fastnear.com'
const ASSETS = 'assets.contract-zero.testnet'
const WORLD = 'world2.contract-zero.testnet'
const CALLSIGN = process.env.DEMO_CALLSIGN ?? 'WRAITH-6'
mkdirSync(OUT, { recursive: true })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const report = []
let shot = 0
const must = (c, m) => { if (!c) throw new Error(m) }
const api = async (path) => (await fetch(`${API}${path}`)).json()

async function chainBalance(account, token, tries = 5) {
  try { return await chainBalanceOnce(account, token) } catch (e) { if (tries <= 1) throw e; await wait(3000); return chainBalance(account, token, tries - 1) }
}
async function chainBalanceOnce(account, token) {
  const args = Buffer.from(JSON.stringify({ account_id: account, token_ids: [token] })).toString('base64')
  const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: ASSETS, method_name: 'mt_batch_balance_of', args_base64: args } }) })).json()
  return +JSON.parse(Buffer.from(r.result.result).toString())[0]
}

// ── setup: the player's own authority ──
const key = loadKey(`${homedir()}/.contract-zero/keys/players-full/player.contract-zero.testnet.json`)
const PLAYER = key.accountId
const login = await signIn(API, PLAYER, key.keyPair)
must(login.status === 200, 'sign-in failed')
const [cookieName, cookieValue] = login.cookie.split(';')[0].split('=')

const quickKey = KeyPair.fromRandom('ed25519')
const wallet = new Account(PLAYER, new JsonRpcProvider({ url: RPC }), new KeyPairSigner(key.keyPair))
const retry = async (f) => { for (let i = 0; ; i++) { try { return await f() } catch (e) { if (i >= 4) throw e; await wait(3000 * (i + 1)) } } }
await retry(() => wallet.signAndSendTransaction({ receiverId: PLAYER, actions: [actions.addFunctionCallAccessKey(quickKey.getPublicKey(), WORLD, ['accept_offer', 'accept_bid', 'place_order', 'accept_proposal', 'cancel_order', 'revoke_session'], 1_000_000_000_000_000_000_000_000n)], waitUntil: 'FINAL' }))
await retry(() => wallet.signAndSendTransaction({ receiverId: WORLD, actions: [actions.functionCall('register_session', { public_key: quickKey.getPublicKey().toString(), credit_budget: '600', unit_budget: '500', ttl_secs: 7200 }, 30_000_000_000_000n, 1_000_000_000_000_000_000_000n)], waitUntil: 'FINAL' }))

const browser = await chromium.launch({ channel: 'chrome', args: ['--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: OUT, size: { width: 1280, height: 720 } } })
await ctx.addInitScript(([account, secret]) => {
  try { localStorage.setItem('cz_session_key', JSON.stringify({ account, secret, expires: Date.now() + 7_000_000 })) } catch { /* ignore */ }
}, [PLAYER, quickKey.toString()])
const p = await ctx.newPage()
const errors = []
p.on('pageerror', (e) => errors.push(e.message))

async function step(n, title, data, opts = {}) {
  shot++
  const file = `${String(shot).padStart(2, '0')}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}.png`
  await p.screenshot({ path: `${OUT}/${file}`, fullPage: !!opts.full })
  const entry = { step: n, title, secs: Math.round((Date.now() - t0) / 1000), screenshot: file, ...data }
  report.push(entry)
  console.log(`§17.${n} ${title}`, JSON.stringify(data))
}
const text = () => p.innerText('body')

// 1. Sign in with a familiar method.
await p.goto(`${WEB}/signin`, { waitUntil: 'networkidle' })
await step(1, 'Sign in', { offered: (await text()).match(/google|wallet/gi)?.map((s) => s.toLowerCase()).filter((v, i, a) => a.indexOf(v) === i), used: 'wallet-style signed challenge (scripted)' })
await ctx.addCookies([{ name: cookieName, value: cookieValue, domain: new URL(WEB).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }])

// 2. Create an operator; enter the Operations Hub.
await p.goto(`${WEB}/operator`, { waitUntil: 'networkidle' })
const input = p.locator('input[placeholder="WRAITH-6"]')
if (await input.count()) {
  const current = await input.inputValue()
  if (!current) {
    await input.fill(CALLSIGN)
    await p.getByRole('button', { name: /report for duty|save callsign/i }).click()
    await wait(1500)
  }
}
const profile = await (await fetch(`${API}/me/profile`, { headers: { cookie: login.cookie } })).json()
await p.goto(`${WEB}/`, { waitUntil: 'networkidle' })
await wait(4000) // the hangar scene
await step(2, 'Operations Hub', { callsign: profile.callsign })

// 4. Several genuinely distinct missions (the board).
const board0 = (await api('/board')).board
await p.goto(`${WEB}/contracts`, { waitUntil: 'networkidle' })
await wait(1500)
const kinds = [...new Set(board0.map((b) => b.kind))]
const pick = board0.find((b) => b.kind === 'raid' && b.bounty) ?? board0.find((b) => b.kind === 'raid')
must(pick, 'no raid on the board')
await step(4, 'Contract board', { contracts: board0.length, kinds, chosen: `${pick.kind} on ${pick.target_name}'s ${pick.resource}: ${pick.manifest} units, ${pick.guards.planned} guards, bounty ${pick.bounty?.amount ?? 0} from ${pick.bounty?.sponsor_name ?? 'nobody'}` })

// Contract intel: the site, the hour's conditions, the map, objectives, resistance, rewards.
const cargoBefore = await chainBalance(PLAYER, pick.resource)
const targetBefore = (await api('/world')).actors.find((a) => a.id === pick.target)
await p.goto(`${WEB}/deploy?target=${pick.target}&resource=${pick.resource}&kind=${pick.kind}`, { waitUntil: 'networkidle' })
await p.waitForSelector('[data-testid=operation-intel]', { timeout: 60000 })
await wait(1500)
report[report.length - 1].intel = { site: await p.innerText('[data-testid=intel-site]'), phase: await p.innerText('[data-testid=intel-phase]'), objectives: (await p.locator('[data-testid=intel-objectives] li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')) }
await p.screenshot({ path: `${OUT}/04b-intel.png`, fullPage: true })
let start = null
const tick0 = (await api('/world')).tick // orders placed after this answer the raid
p.on('response', async (r) => { if (r.url().endsWith('/missions/start') && r.ok()) start = await r.json() })
const deployedAt = Date.now()
await p.click('[data-testid=accept-contract]')

// 3. The briefing.
await p.waitForSelector('[data-testid=briefing]')
// The story may take up to 12 s (optional model voicing); wait for it, then for the lines to finish typing.
await p.waitForFunction(() => !/decrypting channel/i.test(document.body.innerText), null, { timeout: 30000 })
await p.waitForFunction(() => !/skip ▸/i.test(document.body.innerText), null, { timeout: 90000 })
await step(3, 'Briefing', { codename: start?.story?.codename, location: start?.story?.location, lines: start?.story?.briefing.map((l) => `${l.speaker}: ${l.text}`), source: start?.story?.source })
await p.keyboard.press('Enter')

// 5. Equip owned items and deploy: an owned gun if the player has one.
await p.waitForSelector('[data-testid=deploy]', { timeout: 30000 })
const owned = p.locator('[data-testid^=gear-]:not([disabled])')
let weapon = 'Assault Rifle'
if (await owned.count()) { await owned.first().click(); weapon = (await owned.first().innerText()).split('\n')[0] } else await p.getByText('Assault Rifle', { exact: true }).click()
await wait(2500)
await step(5, 'Loadout', { weapon, owned_items: weapon === 'Assault Rifle' ? 'standard issue (no owned gear)' : 'an owned gun token, checked against the ledger' })
await p.click('[data-testid=deploy]')

// 6. Combat, dialogue, dynamic objectives (autopilot).
await p.waitForSelector('canvas', { timeout: 120000 })
await p.waitForFunction(() => typeof window.__czObjectives === 'function', null, { timeout: 120000 })
await p.mouse.click(640, 400)
await p.evaluate(() => window.__czSkipBriefing())
const objectives = await p.evaluate(() => window.__czObjectives())
const heard = new Set()
const subtitle = async () => p.evaluate(() => [...document.querySelectorAll('div')].find((d) => /^(KESTREL|VANGUARD COMMAND|ASHEN COMPACT|VEX)$/.test(d.textContent ?? '') && d.nextElementSibling)?.nextElementSibling?.textContent ?? null)
let midShot = false
// Move the operator at walking pace (2.8 m/s): the server checks every position
// against the player's top speed, so the autopilot walks rather than teleports.
const walkTo = (x, z) => p.evaluate(([x, z]) => new Promise((done) => {
  // Follow the level's own navigation route, one straight, clear leg at a time.
  const route = window.__czPath?.(x, z) ?? [[x, z]]
  if (!route.length || Math.hypot(route[route.length - 1][0] - x, route[route.length - 1][1] - z) > 0.01) route.push([x, z])
  const step = () => {
    if (!route.length) return done(true)
    const [tx, tz] = route[0]
    const at = window.__czPlayer()
    const d = Math.hypot(tx - at.x, tz - at.z)
    if (d < 0.05) { route.shift(); return step() }
    const k = Math.min(1, 0.28 / d)
    window.__czWarp(at.x + (tx - at.x) * k, at.z + (tz - at.z) * k)
    setTimeout(step, 100)
  }
  step()
}), [x, z])
// Hold E on a field object until `done` says it has happened.
const holdOn = async (pos, done, arg) => {
  await walkTo(pos[0], pos[1] + 0.5)
  await p.evaluate(() => window.__czLook(0, -1.2))
  await wait(300)
  await p.keyboard.down('KeyE')
  for (let i = 0; i < 120 && !(await p.evaluate(done, arg)); i++) await wait(250)
  await p.keyboard.up('KeyE')
}
for (let guard = 0; guard < 400; guard++) {
  const m = await p.evaluate(() => window.__czMission())
  if (m.complete) break
  const o = objectives[m.objective]
  const f = await p.evaluate(() => window.__czField())
  if (o.kind === 'secure') {
    // Physically take the cases, up to what one operator can carry.
    for (const c of f.items.filter((i) => i.kind === 'cargo_case').slice(0, 3)) await holdOn(c.pos, (id) => window.__czField().carried.includes(id), c.id)
    report[report.length - 1].carried = (await p.evaluate(() => window.__czField())).carried
  } else if (o.kind === 'plant' || o.kind === 'retrieve') {
    const it = f.items.find((i) => i.id === o.item)
    await holdOn(it.pos, (id) => window.__czField().planted.includes(id) || window.__czField().carried.includes(id), o.item)
  }
  if (o.kind === 'extract' || (o.kind === 'secure' && (await p.evaluate(() => window.__czField().carried.length)) > 0)) {
    // The server rejects a run faster than its interactions physically take.
    const carried = (await p.evaluate(() => window.__czField().carried.length))
    const need = ((start?.min_secs ?? 40) + 2 * carried + 3) * 1000 - (Date.now() - deployedAt)
    if (need > 0) await wait(need)
    await p.evaluate(() => window.__czKillAll())
    const z = f.exfil
    await walkTo(z.pos[0], z.pos[1])
    await p.evaluate(() => window.__czLook(0, -0.3))
    await p.keyboard.down('KeyE')
    for (let i = 0; i < 60 && (await p.evaluate(() => window.__czField().phase)) !== 'counting'; i++) await wait(250)
    await p.keyboard.up('KeyE')
    await wait(3000)
    await p.screenshot({ path: `${OUT}/06b-extraction.png` })
    for (let i = 0; i < 120 && !(await p.evaluate(() => window.__czMission().complete)); i++) await wait(250)
    continue
  }
  if (o.kind === 'clear') await p.evaluate(() => window.__czKillAll())
  else if (o.kind === 'reach') await walkTo(o.pos[0], o.pos[1])
  if (o.kind === 'defend') await p.evaluate(() => window.__czKillAll())
  const s = await subtitle()
  if (s) heard.add(s)
  if (!midShot && m.objective >= 2) { await step(6, 'In the fight', { objective: o.text }); midShot = true }
  await wait(700)
}
const fired = await p.evaluate(() => window.__czStory().fired)
report[report.length - 1].radio_beats = fired
report[report.length - 1].lines_heard = [...heard]

// 7–8, 11. The mission changes the economy; ownership; confirmed settlement.
await p.waitForURL(/deploy/, { timeout: 5000 }).catch(() => {})
await p.waitForSelector('[data-testid=debrief]', { timeout: 180000 })
await step(7, 'Extraction results', { outcome: (await text()).match(/CARGO EXTRACTED|LINE DESTROYED|CARGO HANDED OVER|KILLED IN ACTION[^\n]*|RUN REJECTED/)?.[0], debrief: (await p.innerText('[data-testid=debrief]')).replace(/\s+/g, ' ') })
await p.waitForFunction(() => /Settled on NEAR testnet/.test(document.body.innerText), null, { timeout: 420000 })
const settledText = (await text()).match(/Settled on NEAR testnet:[^\n]*/)?.[0]
const cargoAfter = await chainBalance(PLAYER, pick.resource)
await step(11, 'Confirmed NEAR settlement', { result: settledText, raid_op: `raid:${start.raid}` }, { full: true })
must(cargoAfter > cargoBefore, `no ${pick.resource} arrived in ${PLAYER} on chain`)
report.push({ step: 8, title: 'Genuine ownership', secs: Math.round((Date.now() - t0) / 1000), on_chain: `${PLAYER} holds ${cargoAfter} ${pick.resource} on ${ASSETS} (was ${cargoBefore})` })
console.log('§17.8 ownership', cargoBefore, '→', cargoAfter)

// 9. Trade with the autonomous merchant (sell part of the haul, quick trade, on chain).
await p.goto(`${WEB}/exchange`, { waitUntil: 'networkidle' })
const sellQty = Math.max(1, Math.min(20, cargoAfter - cargoBefore))
await p.locator(`input[aria-label="${pick.resource} quantity"]`).fill(String(sellQty))
const row = p.locator(`input[aria-label="${pick.resource} quantity"]`).locator('xpath=..')
// The server won't quote while the raid's cargo still has settlements in flight
// ("still settling on NEAR; try again in a few seconds"): retry like a player would.
const tradeBtn = p.getByRole('button', { name: /^Trade$|Confirm trade/ })
for (let i = 0; i < 24 && !(await tradeBtn.count()); i++) {
  await row.getByRole('button', { name: 'Sell' }).click()
  await tradeBtn.waitFor({ timeout: 15000 }).catch(() => {})
}
await tradeBtn.click({ timeout: 30000 })
await p.waitForFunction(() => /settled on-chain/i.test(document.body.innerText), null, { timeout: 180000 })
const quote = (await text()).match(/QUOTE[\s\S]{0,200}/)?.[0]?.replace(/\s+/g, ' ')
await step(9, 'Trade with Vex', { sold: quote?.match(/Vex buys (\d+ \w+)/)?.[1] ?? null, quote })

// 10. Competing agents respond on their own (the live clock; nothing fast-forwarded).
const baseline = Math.max(...(await api('/warroom/timeline?limit=1')).chains.map((c) => c.seq), 0)
let response = null
for (let i = 0; i < 40 && !response; i++) {
  const chains = (await api('/warroom/timeline?limit=40')).chains.filter((c) => c.seq > baseline && c.kind === 'decision')
  response = chains.find((c) => c.actor === pick.target) ?? null
  if (!response) await wait(10000)
}
must(response, `${pick.target} made no decision within the wait`)

// 12. The War Room.
await p.goto(`${WEB}/war-room`, { waitUntil: 'networkidle' })
await p.waitForSelector('[data-testid=causal-chain]')
await step(10, 'Factions respond', { actor: response.actor_name, trigger: response.trigger, observed: response.observed, rationale: response.proposal.rationale, validation: response.validation.status, world: response.world })
await p.getByRole('button', { name: 'operations' }).click()
await wait(800)
await p.locator('[data-testid=causal-chain]').first().screenshot({ path: `${OUT}/12b-war-room-operation-chain.png` })
await step(12, 'War Room', { chain: 'trigger → observed → proposal → validation → transaction → world → gameplay' }, { full: true })

// 13. Another mission, different because the world changed.
const board1 = (await api('/board')).board
const targetAfter = (await api('/world')).actors.find((a) => a.id === pick.target)
const same = board1.find((b) => b.target === pick.target && b.resource === pick.resource && b.kind === pick.kind)
await p.goto(`${WEB}/contracts`, { waitUntil: 'networkidle' })
await wait(1200)
await step(13, 'The world has changed', {
  before: { stock: targetBefore.holdings[pick.resource], defense: targetBefore.defense, manifest: pick.manifest, guards: pick.guards.planned, bounty: pick.bounty?.amount ?? 0 },
  after: { stock: targetAfter.holdings[pick.resource], defense: targetAfter.defense, manifest: same?.manifest ?? null, guards: same?.guards.planned ?? null, bounty: same?.bounty?.amount ?? 0, on_board: !!same },
  board: { before: board0.map((b) => `${b.kind}:${b.target}:${b.resource}`), after: board1.map((b) => `${b.kind}:${b.target}:${b.resource}`) },
})

// 14. The raided faction asks the market: competing merchants, a choice, NEAR.
let chain = null
for (let i = 0; i < 40 && !chain; i++) {
  const chains = (await api('/warroom/procurement?limit=20')).chains
  chain = chains.find((c) => c.requester === pick.target && c.placed_at >= tick0 && c.fills.length > 0 && c.settlement.some((s) => s.op_id.startsWith('fill:') && s.settled_on_chain)) ?? null
  if (!chain) await wait(10000)
}
await p.goto(`${WEB}/war-room`, { waitUntil: 'networkidle' })
await p.waitForSelector('[data-testid=procurement]')
if (chain) {
  const el = p.locator(`[data-testid=proc-${chain.order}]`)
  await el.evaluate((d) => { d.open = true })
  await el.scrollIntoViewIfNeeded()
  await wait(800)
  await el.screenshot({ path: `${OUT}/14b-supply-order-chain.png` })
}
await step(14, 'Supply order and competing merchants', chain ? {
  order: `#${chain.order}: ${chain.requester_name} ${chain.side}s ${chain.qty} ${chain.resource}, limit ${chain.limit_total} cr`,
  answers: chain.answers.map((a) => `${a.merchant_name}: ${a.rationale}`),
  choice: chain.choices.find((c) => c.validation === 'accepted')?.rationale,
  settlement: chain.settlement.map((s) => `${s.op_id} ${s.settled_on_chain ? 'settled' : s.status} ${s.tx_hashes[0] ?? ''}`),
  next_mission: chain.next_mission,
} : { note: 'no settled supply order from the raided faction within the wait' })

// 15. The player in the same market: a supply order, competing offers, the best one.
await p.goto(`${WEB}/exchange`, { waitUntil: 'networkidle' })
await p.waitForSelector('[data-testid=new-order]')
await p.selectOption('[data-testid=order-side]', 'buy')
await p.selectOption('[data-testid=order-resource]', 'med')
await p.fill('[data-testid=order-qty]', '3')
await p.locator('[data-testid=new-order]').scrollIntoViewIfNeeded()
await p.click('[data-testid=order-place]')
await p.waitForSelector('[data-testid=order-msg]', { timeout: 120000 })
const accept = p.locator('[data-testid^=accept-]').first()
await accept.waitFor({ timeout: 240000 })
await accept.scrollIntoViewIfNeeded()
await wait(600)
await p.screenshot({ path: `${OUT}/15a-competing-offers.png` })
await accept.click()
await p.waitForFunction(() => /Order Filled/.test(document.querySelector('[data-testid=order-msg]')?.textContent ?? ''), null, { timeout: 180000 })
await step(15, 'Your own supply order', { result: await p.textContent('[data-testid=order-msg]') })

// 16. The official NEAR Intents protocol, clearly apart: a live dry quote on mainnet.
await p.locator('[data-testid=intents-path]').scrollIntoViewIfNeeded()
await p.click('[data-testid=intents-quote-wNEAR]')
await p.waitForFunction(() => /Minimum received/.test(document.querySelector('[data-testid=intents-result]')?.textContent ?? ''), null, { timeout: 60000 })
await step(16, 'NEAR Intents (official, mainnet, dry quote)', { quote: (await p.textContent('[data-testid=intents-result]')).replace(/\s+/g, ' ') })

await ctx.close()
await browser.close()
const video = readdirSync(OUT).find((f) => f.endsWith('.webm'))
if (video) renameSync(`${OUT}/${video}`, `${OUT}/demo-run.webm`)
report.sort((a, b) => a.step - b.step)
writeFileSync(`${OUT}/report.json`, JSON.stringify({ player: PLAYER, minutes: +((Date.now() - t0) / 60000).toFixed(1), page_errors: errors, steps: report }, null, 2))
console.log(`\nDONE in ${((Date.now() - t0) / 60000).toFixed(1)} min · ${OUT}/demo-run.webm · page errors: ${errors.length}`)
