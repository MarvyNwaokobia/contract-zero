# Impact VFX sprites

Source: **Kenney Particle Pack** ([kenney.nl](https://kenney.nl/assets/particle-pack),
also on [kenney.itch.io](https://kenney.itch.io)), license **CC0** (public domain,
no attribution required — credited here anyway). Fetched from the
[Calinou/kenney-particle-pack](https://github.com/Calinou/kenney-particle-pack)
mirror and downscaled from 512px with `sips`:

- `spark.png` (128px, from `trace_01`) — the hot streak thrown off an impact.
  Elongated on purpose: ImpactFX rotates each one to face its own velocity.
- `smoke.png` (128px, from `smoke_04`) — the dust/smoke puff that lingers.
- `debris.png` (128px, from `dirt_02`) — a gravel spray, one sprite = many chunks.
- `flash.png` (64px, from `light_01`) — the single-frame hot flash at the point
  of contact.
- `droplet.png` (64px, from `circle_05`) — a round blob. Does double duty: the
  blood thrown out of a body, and the ambient ash drifting through the compound.
  Round and dense on purpose — the smoke sprite is too diffuse to read as liquid
  and the debris sprite is visibly gravel.

All five are white/greyscale by design; ImpactFX tints them per surface
(concrete grey, dirt brown, wood tan, blood red, ash warm), so one sprite serves
every material. Drop-in replacements just need to keep that convention.

Note that a sprite is used by SEVERAL layers at different scales and lifetimes —
`spark` is both the fast shower and the slow embers, `smoke` is the puff, the
ejecta ring and the hanging wisp, `droplet` is blood and ash. That is deliberate:
the difference between them is emission and simulation, not art, so the sprite
set stays small and every layer stays one draw call.

The **decals** are NOT here — the bullet hole and the blood splat are both drawn
procedurally on a canvas at runtime (`vfx/impactDecalTexture.ts`). A hole wants a
scorch halo, a hard dark core and crisp cracks; a splat wants a ragged edge with
satellite droplets. Soft particle sprites cannot give either, and a canvas can
put the light and dark parts in the same texture, which a tinted white sprite
never can.

Note on itch.io: most of the free "bullet impact" packs there are pixel-art
sprite sheets (16x16/32x32, e.g. BDragon1727's Retro Impact packs) meant for 2D
games — they read as cartoon next to Valor's PBR bodycam look. Kenney's pack is
the CC0 set that suits a 3D billboard, and it is on itch.io too. Anything richer
than these (an animated impact flipbook, a real smoke sim sheet) would be a
sprite-SHEET with frames, which the billboard shader would need a frame uniform
to sample — worth doing if a pack that good turns up, not worth faking with what
is free.
