# Asset credits

Every file the web app ships under `public/`, where it came from, and its licence. The full audit (including code dependencies) is in `docs/contract-zero/LICENSING.md`.

## Textures

- **Zone PBR textures** (`public/textures/dustline/`): [Poly Haven](https://polyhaven.com), **CC0**. Per-map sources are in that folder's README.
- **Hangar PBR textures** (`public/textures/hangar/`): `concrete_floor_worn_001`, `corrugated_iron_02` and `metal_plate` from [Poly Haven](https://polyhaven.com), **CC0**.
- **Impact VFX sprites** (`public/textures/vfx/`): [Kenney Particle Pack](https://kenney.nl/assets/particle-pack), **CC0**. Sources are in that folder's README.

## Weapons

- **Rifle** (`public/models/guns/rifle.glb`) and **sci-fi blaster** (`blaster.glb`): [Poly Pizza](https://poly.pizza), **CC0**.
- **Sidearm, SMG and Marksman rifle**: original procedural models, built in code (`src/engine/scene/proceduralGuns.ts`). They replaced three GLB files whose source could not be confirmed.
- **The five seasonal weapons**: original procedural models, same file.

## Characters

- **Operator rig** (`public/characters/glb/operator.glb`): a skinned body with rifle animation clips from Adobe [Mixamo](https://www.mixamo.com), assembled by `scripts/build_operator_glb.py`.
  - Mixamo characters and animations may be used in games under Adobe's terms.
  - The raw `.fbx` downloads are not redistributed: they live in the git-ignored `apps/web/assets-src/` and are never served.

## Sound

- **Gunshots and the wall impact** (`public/sounds/fps/*.mp3`): original, synthesised by `scripts/generate-sfx.mjs` (deterministic; rerun it to rebuild them). They replaced samples whose source could not be confirmed.
- **Everything else** (reloads, hit markers, footsteps, radio static, ambience, alarms, explosions, refinery machinery): synthesised at runtime with the Web Audio API in `src/engine/audio/FpsAudio.ts`. No files.
- **Voice:** the game ships no recorded voice. Radio lines are subtitles over synthesised static.

## Fonts

- **Rajdhani**, **Barlow** and **Cinzel**: Google Fonts, **SIL Open Font License 1.1**. Self-hosted at build time by `next/font`.

## Removed

- `public/sounds/combat/*.mp3` (melee sounds from the earlier codebase, source unknown, unused) were deleted.
