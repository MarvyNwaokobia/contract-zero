# Inherited code

The first commit, tagged `pre-hackathon`, is the team's own earlier FPS project, written before the hackathon and trimmed to its engine. Everything after that tag was built during the hackathon:

```bash
git diff pre-hackathon..HEAD
```

## What was inherited

The first-person shooter engine in `apps/web/src/engine`:

| Folder | Contents |
|---|---|
| `fps/` | headless simulation (movement, gunplay, enemy AI), mission data format, XP |
| `scene/` | the React Three Fiber scene, viewmodel, weapons, set dressing |
| `combat/`, `audio/`, `vfx/`, `animation/`, `camera/`, `input/`, `world/` | gun stats, sound, impacts, rigs, input |

It also carried over:
- 3D models, textures and sounds in `apps/web/public` (credited in `apps/web/CREDITS.md`)
- Rust API scaffolding: the Actix setup, migration runner and rate limiter

## What the import removed

The earlier project's blockchain, wallet and payment integrations, its smart contracts, a separate melee game mode, PvP, social features, mobile app shells and its API endpoints. Only the FPS engine and the API scaffolding remain.

## What was added for the import

Only what the trimmed tree needed to build: a minimal app shell, an API skeleton with a health check, a LICENSE and a README.

## Baseline at import

| Check | Result |
|---|---|
| Web unit tests | 451 passed |
| Typecheck | clean |
| Production build | passes |
| API tests | 2 passed |
| Headless browser run | the scene loads, moves and fires with no page errors |
