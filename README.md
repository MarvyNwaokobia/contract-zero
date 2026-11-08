# CONTRACT ZERO

A first-person extraction shooter where the missions come from an economy, not a script. Two NPCs run it: a faction commander and an independent merchant. Both hold real inventories and treasuries, post bounties on each other's supply convoys, and react to every raid you pull off.

Built for the NEAR Hackathon (November 2026), track **Games With Real Economies**.

## The loop

**Deploy → raid a convoy → extract → the economy shifts → the agents replan → new contracts appear.**

1. **The convoys.** Ironveil Directorate runs fuel convoys, and Vex Exchange runs medical-supply caravans.
2. **The contract.** When one side wants the other's cargo, it escrows a bounty on that convoy. That bounty is the contract you take.
3. **The raid.** You fight through the escort, load the cargo under fire, and walk it out.
4. **The settlement.** The bounty pays you, and the cargo goes to whoever posted the contract. The convoy's owner never receives it.
5. **The fallout.** Ironveil falls short of fuel and has to buy it from Vex, whose prices respond to the shift in supply and demand. It also hires heavier escorts, so the next convoy fields more guards and they hit harder.

## Status

This is being built during the hackathon. What exists today:

| Part | State |
|---|---|
| FPS engine: movement, gunplay, enemy AI, weapons, attachments, audio | **Working.** Playable at `/training` |
| Convoy raid mission generated from a contract (`apps/web/src/engine/fps/convoy.ts`) | **Built and tested.** Not yet reachable from a page |
| Deterministic economy: ledger, pricing, convoys, contracts, settlement (`apps/api/crates/economy`) | **Built and tested** |
| Fallback agent policies for the commander and merchant | **Built and tested** |
| Contract Board, Armory, Deployment, Extraction Results, War Room, Exchange | In progress |
| NEAR contracts (NEP-245 items, treasury, settlement) on testnet | In progress |
| Social login (FastAuth) | In progress |
| LLM strategic planner (NEAR AI Cloud) with validated tool calls | In progress |

## Architecture

```text
apps/web    Next.js 15 + React Three Fiber
            └─ engine/fps    headless FPS sim, missions, convoy builder
            └─ engine/scene  the 3D scene (ContractZeroScene)
apps/api    Rust / Actix-web + Postgres
            └─ crates/economy  the deterministic world (no I/O)
```

Combat AI is deterministic and runs in the client sim; no LLM is involved in a gunfight. The economy runs on the server, which is the only place mission outcomes are settled.

The economy's formulas, sources and sinks are in [docs/contract-zero/ECONOMY.md](docs/contract-zero/ECONOMY.md).

## Run it

Requires Node 22+.

```bash
npm install
npm run dev --workspace=apps/web    # open http://localhost:3000, which goes to /training
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
- conservation of every asset over a simulated week
- ledger replay and determinism
- atomic batches
- insufficient stock and credits
- stale-quote races
- escrow, refunds and bounty bounds
- replayed settlements
- authorization
- the raid → replan loop

## Prior work

The FPS engine predates the hackathon. It is the team's own earlier work, imported as the first commit and tagged `pre-hackathon`. Everything after that tag was built during the hackathon: `git diff pre-hackathon..HEAD`.

## License

MIT, see [LICENSE](LICENSE). Third-party assets are credited in [apps/web/CREDITS.md](apps/web/CREDITS.md).
