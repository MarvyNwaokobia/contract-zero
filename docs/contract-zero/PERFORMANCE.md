# Performance and adaptive quality (Milestone 8)

## Tiers

| Tier | Resolution cap | Shadows | Post-processing | Set dressing |
|---|---|---|---|---|
| High | 2× | sun casts | full (bloom, AO, grain, vignette) | yes |
| Medium | 1.5× | sun casts | light | yes |
| Low | 1× | none | off | none (colliders kept, so gameplay is identical) |
| **Auto** (default) | starts High, steps down when the frame rate can't hold | | | |

**How Auto decides** (`engine/perf/autoQuality.ts`):
- It measures the real frame rate once a second, after a 3-second warm-up so loading hitches don't count.
- 3 consecutive seconds under 45 fps step one tier down: high → medium → low.
- It never steps back up mid-session, because oscillating is worse than either tier.
- Where it settled is remembered for the next launch. Choosing a tier, or choosing Auto again, resets it.
- Touch devices always skip the heavy post-processing.

**The previous auto-quality never triggered.** It used drei's `PerformanceMonitor`, which declines only when more than 75% of samples fall under 40 fps, and then jumped straight from full quality to minimal. A machine at 30–38 fps never reached it: measured on Blacksite at 2×, it stayed at full quality for 15 s+ at about 30 fps. Now, on the same scene, Auto stepped to Medium after about 6 s, recovered to 60 fps, remembered it, and a reload started at Medium.

## Player overrides

Settings → Display can override any part of a tier (see `SETTINGS.md`):
- **Shadows, set dressing and particles:** each follows the preset, or is forced on or off.
- **Post-processing:** follows the preset, or is set to Full, Light or Off.
- **Resolution scale:** multiplies the tier's pixel-ratio cap.
- **Frame-rate cap (30, 60 or 120):** drives the render loop at that rate. Measured at 30 fps under the 30 cap.

The overrides combine with the tier in `renderPlan` (`lib/settings.ts`). Auto still moves the tier, and the overrides apply on top of whatever tier it's on.

## Measurements

`node apps/web/probe-perf.mjs <web> gpu|throttle <out.json> [sites]` runs a night raid with every guard awake, from the breach point. It records:
- the average frame rate and the 95th-percentile frame time over 4 s;
- draw calls and triangles per frame, counted across every render pass.

The machine is the development Mac (Apple Silicon). Headless Chrome runs at a 1280×720 viewport with a 2× device pixel ratio, and is capped at 60 fps by vsync.

**GPU (normal):**

| Map | Tier | fps | p95 frame | Draw calls | Triangles |
|---|---|---|---|---|---|
| Dustline Depot | High | 35 | 33 ms | 254 | 345k |
| | Medium | 53 | 33 ms | 234 | 325k |
| | Low | 60 | 17 ms | 119 | 157k |
| Blacksite | High | 28 | 50 ms | 248 | 305k |
| | Medium | 55 | 33 ms | 231 | 305k |
| | Low | 60 | 17 ms | 120 | 127k |
| Cinder Yard | High | 51 | 33 ms | 289 | 325k |
| | Medium | 60 | 17 ms | 271 | 325k |
| | Low | 60 | 17 ms | 140 | 145k |

**CPU throttled 4×** (a weak laptop's CPU budget):

| Map | High | Medium | Low |
|---|---|---|---|
| Cinder Yard | 19 fps | 59 fps | 60 fps |
| Blacksite | 50 fps | 51 fps | 59 fps |

**Reading it:**
- **High is fill-rate bound.** At a 2× pixel ratio, post-processing is the cost, which is why Medium (1.5× and light effects) recovers most of the frame rate.
- **Low halves draw calls and triangles.**
- **Typical fight frame rates:** in the earlier gameplay probes (Milestone 7 and the physical-operations work), every operation type on all three maps ran at 57–60 fps at a 1× pixel ratio.

## Budgets

- **Draw calls.** High and Medium run 230–290 per frame; Low runs 120–140. Instancing is used for level geometry, which is one call per material.
- **Triangles.** About 330k on High and Medium, about 150k on Low.
- **GPU memory.** `window.__czPerf()` and `__czDrawStats()` in development builds report geometries, textures and programs. These were stable across mission restarts in the earlier soak checks.
- **Asset weight.** The largest shipped files:
  - Poly Haven textures at 1K: about 12 MB in total;
  - `operator.glb`: 1.9 MB;
  - the two remaining weapon GLBs: 224 KB together.
  - The raw Mixamo FBX files (12 MB) are no longer under `public/`.

## Not measured

- Real phones. Touch already uses the light tier plus Auto.
- Firefox and Safari. All measurements are Chrome or Chromium.
- Long-session memory beyond the existing soak probe.
