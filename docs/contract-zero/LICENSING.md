# Licensing audit (Milestone 8, 2026-11-09)

What ships, where it came from, and what it is licensed under. The project's own code is MIT (`LICENSE`).

## Assets

| What | Source | Licence | Status |
|---|---|---|---|
| Zone and hangar PBR textures | Poly Haven | CC0 | OK, sources recorded |
| Impact VFX sprites | Kenney Particle Pack | CC0 | OK, sources recorded |
| Rifle and blaster models | Poly Pizza | CC0 | OK |
| Sidearm, SMG, Marksman models | **Original** (procedural, `proceduralGuns.ts`) | Project (MIT) | **Replaced** GLBs of unknown source |
| Seasonal weapons | Original (procedural) | Project | OK |
| Operator rig and animations | Adobe Mixamo | Adobe Mixamo terms (use in games permitted; no redistribution of raw files) | OK in the game. **Raw `.fbx` moved** out of `public/` into the git-ignored `assets-src/`; they were never committed |
| Gunshots and wall impact | **Original** (`scripts/generate-sfx.mjs`) | Project | **Replaced** samples of unknown source |
| Other sound | Synthesised at runtime | Project | OK |
| Melee sounds (`sounds/combat`) | Unknown | — | **Removed** (unused) |
| Rajdhani, Barlow, Cinzel | Google Fonts | OFL 1.1 | OK |

After this audit, no shipped asset has an unknown source.

## Code dependencies

`node scripts/license-audit.mjs [report.json]` walks two sets of dependencies and classifies each licence:
- the web app's production npm tree;
- every Rust crate of the API and the three NEAR contracts.

| Tree | Packages | Permissive | Weak copyleft | Review or unknown |
|---|---|---|---|---|
| npm (web, production) | 111 | 110 | 1 | 0 |
| Cargo (API and contracts) | 643 | 640 | 3 (1 after the `wee_alloc` removal) | 0 |

**Permissive** means MIT, ISC, BSD, Apache-2.0, Zlib, CC0, Unicode, OFL, CDLA-Permissive and similar, or an OR-expression that includes one of them.

**The four weak-copyleft packages, all compliant as used:**
- **`@img/sharp-libvips` (LGPL-3.0-or-later).** Next.js's optional server-side image optimiser, loaded as a separate dynamic library and never bundled into the browser. Using it unmodified through dynamic linking meets the LGPL.
- **`progenitor-client` (MPL-2.0).** Pulled in by the official `near-api` client in the API server. It is used unmodified; MPL is file-level, so nothing in this project inherits it.
- **`wee_alloc` and `memory_units` (MPL-2.0).** The WebAssembly allocator that `near-sdk` 5 enables by default in the contracts. Used unmodified, so the licence is satisfied.
  - **Resolved 2026-11-09:** `wee_alloc` is unmaintained and has a known advisory (RUSTSEC-2022-0054, a memory leak). Both live contracts now build with `near-sdk` `default-features = false`, so `wee_alloc` is gone from both dependency trees (verified with `cargo tree`). They were redeployed on testnet with state unchanged (NEAR.md). The frozen v1 contract (`world.contract-zero.testnet`) is retired and not redeployed.

**Packages with no licence field:**
- `webgl-constants`: its `LICENSE` file is MIT (verified).
- The web app's own package.

## Not shipped

These are used only in development and never shipped, so they aren't part of the audit:
- Playwright, used by the probes;
- axe-core (MPL-2.0), used by the accessibility probe;
- the test runners.
