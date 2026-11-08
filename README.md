# CONTRACT ZERO

A first-person extraction shooter where the missions come from an economy, not a script. A faction commander and an independent merchant hold real inventories and treasuries. They react to every raid you pull off, and their decisions shape the next fight.

Built for the NEAR Hackathon (November 2026), track **Games With Real Economies**.

## The loop

**Raid a depot → extract → the economy shifts → the agents replan → the next mission changes.**

1. **The depot.** Vanguard keeps 60% of each resource staged at a forward depot, guarded by however many soldiers its ammunition can arm.
2. **The raid.** You fight through the guards, load the cargo under fire, and walk it out. The server checks the run against how long the mission physically takes.
3. **The settlement.** The cargo moves from Vanguard to you, plus any bounty a sponsor escrowed on that depot.
4. **The response.** Vanguard's commander sees the shortage, quotes the merchant, and buys what its spending policy allows. It also raises its escorts after raids. The merchant reprices from its stock and demand, and may sponsor a raid on whatever it's short of.
5. **The consequences.** Vanguard's ammunition decides how many guards it can arm and with what. Its medicine decides the reinforcements. Its fuel decides whether a depot can be staged at all.

## Status

| Part | State |
|---|---|
| FPS engine, playable at `/training` | **Working** |
| Raid mission built from the server's guard plan (`apps/web/src/engine/fps/convoy.ts`) | **Built and tested.** Not yet reachable from a page |
| Economy: ledger, pricing, raids, bounties, insolvency, economy-to-battlefield rules (`apps/api/crates/economy`) | **Built and tested.** Includes the acceptance scenario |
| Fallback policies for both agents, with logged decisions | **Built and tested** |
| API: raid board, mission sessions with server-side validation, world clock, decision feed, Observer Mode | **Built.** Verified end to end against a local Postgres |
| Main Menu, Contract Board, Armory, Deployment, Extraction, War Room, Exchange | In progress |
| NEAR testnet contract (NEP-245 assets, settlement, receipt verification) | In progress |
| Social login (FastAuth) | In progress |
| LLM strategic planner (NEAR AI Cloud) with validated tool calls | In progress |

## Architecture

```text
apps/web    Next.js 15 + React Three Fiber
            └─ engine/fps    headless FPS sim, missions, raid mission builder
            └─ engine/scene  the 3D scene (ContractZeroScene)
apps/api    Rust / Actix-web + Postgres
            └─ crates/economy  the deterministic world (no I/O)
            └─ src             world service, mission sessions, scheduler, API
```

Combat AI is deterministic and runs in the client sim; no LLM is involved in a gunfight. The economy runs on the server, which is the only place a mission outcome turns into goods.

### API

| Endpoint | Purpose |
|---|---|
| `GET /board` | raidable depots, each with its guard plan, bounty and market value |
| `GET /world` | War Room state: actors, prices with their factors, shipments, bounties, raids, issuance and destruction totals |
| `GET /events?kind=agent_decision` | each agent decision: trigger, figures, action, rationale, validation |
| `POST /missions/start` | `{player, target, resource}`: locks the raid plan and issues a session |
| `POST /missions/{session}/complete` | `{player, outcome, kills}`: validated against server time, then settled or failed. Idempotent |
| `GET /players/{account}` | a player's holdings and raids |
| `POST /observer/simulate` | `{ticks, seed?}`: Observer Mode on a copy of the world, marked simulated |

The economy's formulas, sources and sinks are in [docs/contract-zero/ECONOMY.md](docs/contract-zero/ECONOMY.md).

## Run it

Requires Node 22+, Rust stable and Postgres 15+.

```bash
npm install
npm run dev --workspace=apps/web    # open http://localhost:3000, which goes to /training

createdb contract_zero
cd apps/api && cp .env.example .env && cargo run    # API on :8080; migrates and seeds the world on first boot
curl localhost:8080/board                           # the raid board
```

| Control | Action |
|---|---|
| Click | Capture the mouse |
| WASD | Move |
| Left mouse or Space | Fire |
| Right mouse or Shift | Aim down sights |
| R | Reload |
| C | Crouch |
| Q / E | Lean |
| M | Mission menu |

To try it: open `/training`, then press **M** to pick a practice operation. You should see a briefing, then the objective text at the top of the screen as you move through the compound.

## Tests

```bash
cd apps/web && npx vitest run && npx tsc --noEmit    # FPS engine, missions, convoy builder
cd apps/api && cargo test --workspace                # economy engine + API (Rust stable)
```

The economy tests cover:
- conservation of every asset, and issuance and destruction accounting, over a simulated week
- ledger replay, determinism and JSON round-trips
- atomic batches
- insufficient stock and credits, stale-quote races and merchant insolvency
- raids that settle once and pay only what the depot holds
- bounties, escrow and refunds
- authorization
- every economy-to-battlefield rule
- the acceptance scenario in `tests/acceptance.rs`. Vanguard 100 → 40 ammo, then the commander quotes, buys within policy and reconciles, and the next mission is better armed. It also covers no stock, partial stock, over budget and rejected proposals

## Prior work

The FPS engine predates the hackathon. It is the team's own earlier work, imported as the first commit and tagged `pre-hackathon`. Everything after that tag was built during the hackathon: `git diff pre-hackathon..HEAD`.

## License

MIT, see [LICENSE](LICENSE). Third-party assets are credited in [apps/web/CREDITS.md](apps/web/CREDITS.md).
