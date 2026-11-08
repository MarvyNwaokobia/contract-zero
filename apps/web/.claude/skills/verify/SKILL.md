---
name: verify
description: Build, run and visually verify the Valor web app (Next.js + react-three-fiber game). Use when a change needs runtime verification in the real game, especially anything touching the 3D fight scene.
---

# Verifying Valor (apps/web)

## Launch

```bash
cd apps/web
npx next dev -p 3100        # run in background; first compile of /fight takes ~60-90s
curl -s -o /dev/null -w "%{http_code}" 'http://localhost:3100/fight?op=0'  # warm + readiness check (quote the URL, zsh eats ?)
```

No login is required for /fight; with no player session the class defaults to Berserker and pve_level=0 (so any campaign level counts as first clear).

## Drive the game with Playwright

Playwright is a dependency of apps/web; scripts must live IN apps/web (or resolve from it) or node can't find the package. Launch chromium with software GL or the canvas stays black:

```js
chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] })
```

Routes and flow:
- `/fight` quick bot fight, straight to the 3D scene.
- **`/fight?op=N` — the param is `op`, ZERO-INDEXED, and it is NOT `level`.** `app/fight/page.tsx` reads
  `searchParams.get('op')`; an unrecognised param is ignored silently, so `?level=11` serves op 1 and you
  spend a while wondering why every zone looks like Ashfall. Ops 0-4 Ashfall, 5-9 Proving Ground,
  10-14 The Rift.
- **Ops are soft-gated on `localStorage.valor_progress`**, so a fresh browser can only reach op 0 and
  anything higher silently falls back. Unlock before the app boots:
  ```js
  await page.addInitScript(() => {
    localStorage.setItem('valor_progress', '14');  // furthest op unlocked
    localStorage.setItem('valor_mission', '0');
  });
  ```
- On first clear a zone-intro card and story dialogue precede the fight; BOTH advance on any click, so click page centre (`page.mouse.click(640,360)`) in a loop until `page.$('canvas')` is truthy.
- After canvas mounts: ~1.5s scene-ready + 3.8s countdown before combat input works.
- Inputs: WASD move, `j` fire, space dodge. Hold a key ~2s to see locomotion.
- Capture `page.on('pageerror')` and console errors; a healthy run prints none.

Debug hooks on `window`, set by ValorScene. Undocumented elsewhere and worth knowing:
- **`window.__valorSkipBriefing()`** — drops the mission title card immediately. That card lays an
  `rgba(6,10,14,.72)` scrim over the entire scene, so any screenshot taken under it is judging a dimmed
  frame. It fades on SIM time (3.5s), and sim time runs 3-6x slower than wall time headlessly, so waiting
  it out costs ~20s a run.
- **`window.__valorMission()`** — dumps objective, briefing state, kills, hp, sim time, alive/reviving.

Screenshot right after countdown for the wide framing; mid-combat for the over-the-shoulder camera. Existing example: apps/web/probe-stride.mjs.

## Missions (campaign levels with walk-to-find staging)

Levels with a mission (see engine/campaign/missions.ts) open in a ROAM phase:
an objective line + distance shows top-centre, and the fight only starts after
walking to the enemy. To drive it:

- Hold `w` CONTINUOUSLY (do not tap in bursts: the walk needs a held key to
  break into a run) and poll `document.body.innerText` until the word
  OBJECTIVE disappears; that is the standoff trigger.
- Then ~2s bark + ~3.8s countdown before combat input works.
- Chained missions print `TARGET DOWN` mid-mission; roam resumes with the next
  objective. Poll innerText for `TARGET DOWN` / `VICTORY` / `DEFEATED`.

Gotchas that will burn you:
- SwiftShader renders ~5-10fps and the frame loop clamps dt at 50ms, so GAME
  TIME runs 3-6x slower than wall time headlessly. Budget walks and fights
  accordingly (a fight can take 3+ minutes of wall time). Smaller viewports
  (800x450) help.
- Do NOT edit any apps/web source while a probe is running: Fast Refresh
  remounts the scene and resets the run.
