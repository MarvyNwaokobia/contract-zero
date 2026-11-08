---
name: verify
description: Build, run and visually verify the CONTRACT ZERO web app (Next.js + react-three-fiber FPS). Use when a change needs runtime verification in the real game, especially anything touching the 3D scene.
---

# Verifying CONTRACT ZERO (apps/web)

## Launch

```bash
cd apps/web
npx next dev -p 3100        # run in background; the first compile of /training takes a while
curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/training   # warm + readiness check
```

`/training` needs no login or API: it runs the practice operations and the kill-house offline.

## Drive the game with Playwright

Scripts must live in apps/web (so `@playwright/test` resolves). Launch Chrome with software GL or the canvas stays black:

```js
chromium.launch({ channel: 'chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] })
```

`apps/web/probe-verb.mjs` is a working example: it loads `/training`, skips the briefing, holds W, fires, and reports position, ammo and page errors.

- Practice ops are soft-gated on `localStorage.cz_progress`; unlock before boot with
  `page.addInitScript(() => { localStorage.setItem('cz_progress', '14'); localStorage.setItem('cz_mission', '0'); })`.
- Capture `page.on('pageerror')` and console errors; a healthy run prints none.

Debug hooks on `window`, set by ContractZeroScene:
- `__czSkipBriefing()` drops the mission title card immediately (its scrim dims every screenshot under it).
- `__czMission()` dumps objective, briefing state, kills, hp, sim time, alive/reviving.
- `__czPlayer()` returns `{x, z}`; `__czState()` is the sim snapshot (ammo etc.); `__czFire(on)` holds the trigger.

## Gotchas

- SwiftShader renders ~1-10 fps and the frame loop clamps dt at 50 ms, so game time runs 3-6x slower than wall time headlessly. Budget waits accordingly; an 800x450 viewport helps.
- Do not edit apps/web source while a probe runs: Fast Refresh remounts the scene and resets the run.
