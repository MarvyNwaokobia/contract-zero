# CONTRACT ZERO

A tactical extraction shooter in which autonomous NPC factions run real economies, settled on NEAR. Built for the NEAR Hackathon (November 2026), track **Games With Real Economies**.

> **Status:** early. This commit contains the inherited FPS engine only. The economy, agents, NEAR contracts and new screens are being built in the commits that follow.

## Inherited code

CONTRACT ZERO is built on the FPS engine of **Valor** ([MarvyNwaokobia/Valor](https://github.com/MarvyNwaokobia/Valor)), a first-person shooter that runs on Celo and GoodDollar. Valor was built by Marvy Nwaokobia, who is building CONTRACT ZERO with Samuel Dahunsi.

- **The first commit, tagged `pre-hackathon`,** is Valor at upstream commit `b118eac`. It has been trimmed to the FPS engine: all Celo, GoodDollar and EVM wallet code, the Solidity contracts, the legacy melee game, PvP, social features and the mobile shells were removed. A minimal app shell and API skeleton were added so it builds. Valor's full development history (757 commits) stays public in the upstream repository.
- **Everything after `pre-hackathon`** is CONTRACT ZERO work written during the hackathon. To see it, run `git diff pre-hackathon..HEAD`.

What was kept, changed and removed is listed file by file in [docs/contract-zero/AUDIT.md](docs/contract-zero/AUDIT.md).

## Run the current build

Requires Node 22+.

```bash
npm install
npm run dev --workspace=apps/web     # http://localhost:3000 → redirects to the FPS sandbox
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

## Tests

```bash
cd apps/web && npx vitest run && npx tsc --noEmit
cd apps/api && cargo test        # API skeleton; needs Rust stable
```

## License

MIT, see [LICENSE](LICENSE). Third-party assets are credited in [apps/web/CREDITS.md](apps/web/CREDITS.md).
