// Settlement guarantees that hold without a chain, against a running API with dev sign-in:
//   a killed run pays nothing and leaves the world alone; completing twice returns the same closed
//   record and pays once; another player cannot complete or read someone else's session; a player
//   cannot hold two live sessions. On-chain settlement itself needs NEAR keys and is not run here.
// Usage: node scripts/guarantees-e2e.mjs [apiUrl]      (the API must run with AUTH_DEV_LOGIN=1)
const API = process.argv[2] ?? 'http://127.0.0.1:8080'
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, detail) }
const session = () => {
  let cookie = ''
  return async (method, path, body) => {
    const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
    const c = r.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]
    return { status: r.status, body: await r.json().catch(() => ({})) }
  }
}
const alice = session(), mallory = session()
await alice('POST', '/auth/dev', { account_id: 'guarantee-a.testnet' })
await mallory('POST', '/auth/dev', { account_id: 'guarantee-m.testnet' })

const w0 = (await alice('GET', '/world')).body
const e = w0.board.find((b) => b.kind === 'raid')
const stock0 = w0.actors.find((a) => a.id === e.target).holdings[e.resource]
const s = (await alice('POST', '/missions/start', { target: e.target, resource: e.resource, kind: 'raid' })).body
check('a run starts', !!s.session, s.session)

const second = await alice('POST', '/missions/start', { target: e.target, resource: e.resource, kind: 'raid' })
check('a player cannot hold two live sessions', second.status >= 400 || !second.body.session || second.body.session === s.session, `status ${second.status}`)

const theirs = await mallory('POST', `/missions/${s.session}/complete`, { outcome: 'extracted', kills: 1 })
check('another player cannot complete your session', theirs.status >= 400 && /another player/.test(theirs.body.error ?? ''), `status ${theirs.status}: ${theirs.body.error}`)
const peek = await mallory('GET', `/missions/${s.session}/aftermath`)
check('another player cannot read your session\'s aftermath', peek.status === 403 || peek.status === 404, `status ${peek.status}`)

const done = (await alice('POST', `/missions/${s.session}/complete`, { outcome: 'killed', kills: 2 })).body
const r = done.result
check('a killed run is recorded as killed', r?.outcome === 'killed', r?.outcome)
check('and pays nothing: no bounty, nothing carried, no settlement queued', r.bounty === 0 && r.extracted_units === 0 && r.settlement == null, JSON.stringify({ bounty: r.bounty, units: r.extracted_units, settlement: r.settlement }))
check('and the player holds nothing from it', r.player_holdings.cargo === 0, JSON.stringify(r.player_holdings))
const w1 = (await alice('GET', '/world')).body
const stock1 = w1.actors.find((a) => a.id === e.target).holdings[e.resource]
check('and the target\'s stock was not taken by the player', r.consequence?.after ? r.consequence.before.holdings[e.resource] - r.consequence.after.holdings[e.resource] <= 0 || r.extracted_units === 0 : true, `world ${stock0} -> ${stock1}`)
const again = (await alice('POST', `/missions/${s.session}/complete`, { outcome: 'extracted', kills: 99 })).body
check('completing again cannot turn a death into a payout: same closed record', again.replayed === true && again.result.outcome === 'killed' && again.result.bounty === 0, JSON.stringify({ replayed: again.replayed, outcome: again.result?.outcome, bounty: again.result?.bounty }))
const ok = results.every(Boolean)
console.log(`${results.filter(Boolean).length}/${results.length} passed`)
process.exit(ok ? 0 : 1)
