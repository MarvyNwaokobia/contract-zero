# Settings: the Operator Configuration Center

All settings live at `/settings`. Seven categories sit in a rail on the left; on a phone the rail becomes a scrolling strip.
- **The rail is a tab list.** Arrow keys, Home and End move between categories.
- **Deep links work.** `/settings#keys` opens Key bindings directly.

## How changes apply

- **Graphics is staged.** Changes are held until you press **Apply**.
  - **Discard** drops staged changes.
  - **Revert** returns to what you had before the last Apply.
  - **Defaults** stages the defaults.
- **Everything else applies at once,** including inside a running fight.

## Where settings are stored

- **Every setting is stored in this browser.** Code: `lib/settings.ts`.
  - The format is a versioned schema, now v3.
  - Older stores (v2, v1, `cz_quality`, `cz_look_sens`) are migrated on first read.
  - Every stored value is clamped or checked against an allow-list, so a corrupt store can't break the game.
- **Signed in, the portable part also follows your account.** Code: `lib/preferencesSync.ts`, API `GET` and `PUT /me/preferences`, migration `0014`.
  - **What syncs:** controls, key bindings, interface, accessibility, audio and subtitles.
  - **Who wins:** whichever side changed last.
  - **Graphics never syncs,** because what suits a desktop GPU is wrong for a laptop.
- **What the server accepts:**
  - only those five sections;
  - plain numbers, booleans and short ASCII strings;
  - a bounded depth and at most 8 KB;
  - stored against the account the session proved, never one the client names.

## What's operational

| Category | Setting | What it does in the game |
|---|---|---|
| **Display** | Preset: Auto, High, Medium, Low | Unchanged from Milestone 8 (see `PERFORMANCE.md`). |
| | Resolution scale, 50–100% | Multiplies the preset's pixel-ratio cap. |
| | Frame-rate cap: off, 30, 60, 120 | The render loop is driven at the cap (`frameloop="never"` plus a paced `advance`). Measured: 30 fps under a 30 cap. |
| | Shadows, post-processing, set dressing, particles | Each follows the preset, or is forced on or off. Post-processing also has Full and Light. |
| | Field of view | Applies at once. |
| | Full screen | Uses the Fullscreen API and stays on across screens. If the browser refuses, the error is shown. Where it's unsupported (iPhone Safari), the control is disabled with an explanation. |
| | Frame-rate readout | Shows the in-fight meter. |
| | Performance panels | The last fight's measured fps, worst frame, tier and pixel ratio, recorded every 3 s in play. Also what these settings will render on this screen, and the GPU. |
| **Audio** | Master, **Music**, Effects, Voice and radio, Ambience, Interface | Six real channels. **Music is new:** the adaptive score (`MusicLayers`), previously unused, is now on its own channel. It follows the fight: a drone when calm, a pulse once you're spotted, the theme under fire, and full intensity for a boss. At zero volume the score is stopped, not just silenced. |
| | Mute in the background | Unchanged. |
| **Controls** | Look sensitivity | Unchanged. |
| | Aiming sensitivity, 0.3–1.5× | Multiplies the built-in slow-down while aiming. |
| | Invert vertical look | Applies to mouse, arrow keys and touch drag. |
| | Aim: hold or toggle | Covers the bound keys and the right mouse button. |
| | Crouch: hold or toggle | Desktop only. Touch keeps its toggle button. |
| | Interact: hold or toggle | The Milestone 8 option, now here. |
| **Key bindings** | 28 actions, two keys each | Every keyboard action in the game reads these. The bound keys are shown everywhere keys are named: interaction prompts, the reload hint, the help line, attachment chips, the extraction line, Training's controls line, and the operation briefing ("Hold V on a case…"). Details below. |
| **Interface** | Crosshair: style, colour, size, opacity, spread | Styles are cross, cross with dot, dot and circle. Six colours. A live preview is on the page. |
| | HUD scale, 75–140% | Scales each corner group from its corner. Subtitles keep their own size. |
| | Objective arrow, interaction hints | Each can be turned off. |
| | Hit markers, damage direction, threat arrows | Each can be turned off. |
| **Accessibility** | Subtitles | Unchanged: size, background and speaker colours. |
| | Reduce motion, reduce flashes | Unchanged. |
| | **Colour palette** | Standard, red–green safe or blue–yellow safe, built on the Okabe–Ito set. Recolours hostile (threat arrows, damage direction, kill marker), objective (line and arrow), success (extraction countdown, hold bar) and health. Every one also carries a text label. |
| | **High-contrast prompts** | A solid black panel, a white key cap and heavier text. |
| | **Aim assist** | Touch only (the default), always, or off. |
| | **Target lock** | Can be disabled; this also stops tap-to-target. |
| **Account & security** | Account | Callsign, sign-in method and session expiry. NEAR details are collapsed: account, network, the public sign-in key and an explorer link. |
| | Quick trade | Its status, remaining budget and expiry, read from the controller **on chain**, not from local state. |
| | Revoke quick trade | Asks for confirmation, then signs the revocation with the key itself. It reports success only once the chain confirms. Otherwise it says revocation is unconfirmed and when the key expires anyway. |
| | Preference sync | Status, plus a **Sync now** button. |
| | Sign out | Revokes quick trade first, then ends the session. Any unconfirmed revocation is reported. |

### Key bindings in detail

**What can be bound:**
- Each action takes a primary and a second key.
- Bindings are `KeyboardEvent.code` values, so they follow the physical key on any layout.

**Conflicts:**
- A key already in use moves to the new action, and the action that lost it is named.
- **Undo** puts it back.
- A required action left without a key (move, fire, reload, interact) is flagged until it has one.

**Reserved keys** are refused, with the reason shown:
- Esc pauses the game and releases the mouse.
- Tab moves keyboard focus.
- Ctrl is refused because Ctrl + W closes the tab.
- The system key.
- F1–F12.

**Fixed:**
- The mouse buttons: left fires, right aims.
- Pointer lock still starts from a deliberate click or keypress, as before.

**Security:** the page never shows the quick-trade secret, which stays in storage; only its public half is read. No session token is shown either, because the session cookie is `HttpOnly`. The probe checks the rendered page for the secret.

## In the pause menu

Leaving a contract mid-fight abandons it, so the pause menu carries the settings you'd tune between fights. They're in four tabs, apply at once and are saved:

| Tab | Settings |
|---|---|
| **View** | Quality, field of view, HUD scale, crosshair style, frame-rate readout |
| **Audio** | Master, music, effects, voice and radio, ambience |
| **Controls** | Look and aiming speed, invert Y, hold or toggle for aim, crouch and interact |
| **Comfort** | Subtitles, reduce motion, reduce flashes, high-contrast prompts, colour palette |

- **All settings** opens the full page in a **new tab**, so the fight survives, and changes made there reach the paused fight.
- **On a phone held landscape,** the menu scrolls, so the panel is always in reach.

## Deliberately not offered

These aren't in the game, so the page doesn't offer them as working controls:
- **Sprint.** Movement speed comes from stance and the cargo you carry. The Controls page says so.
- **Controller support.**
- **A separate lighting switch.** Practical lights and shader detail follow the preset, as the Display page says.
- **Mouse-button remapping.**
- **Recorded voice.** Voice controls the radio static and cues.

## Deferred

- **Sync conflicts.** Sync is last-writer-wins for all five sections together, not per field.
- **Browser coverage.** Firefox and Safari were not run; every check here is Chrome.

## Evidence

- **`node apps/web/probe-config.mjs` passes 40 of 40 checks.** Results: `evidence/settings-config.json`; screenshots: `evidence/settings/`.
  - **Layout:** all seven categories at 1280×800 and 375×740, with no sideways scroll.
  - **Keyboard and binding:**
    - tab-list keyboard navigation;
    - rebinding, a refused reserved key, Esc to cancel, a conflict that names the loser, the missing-key warning, undo and reset.
  - **Staged graphics:** stage, discard, apply and revert.
  - **Full screen:** entered, and also disabled with an explanation when unsupported.
  - **Account:**
    - signed-out and signed-in views; the quick-trade budget read from a chain record;
    - no secret on the page;
    - a revocation the chain won't confirm, with the relay down, reported as unconfirmed with the expiry, and the local key wiped;
    - a change pushed to the account without graphics, and a newer account copy pulled in.
  - **In a fight:**
    - shadows forced off at High; the resolution-scale cap; 30 fps under a 30 cap; music on its channel;
    - a rebound move key moves the operator while the old one doesn't; invert Y; a rebound reload key reloads while the old one doesn't;
    - crosshair style and colour; HUD scale; palette colours; the high-contrast prompt with the bound key;
    - no page errors.
- **`node apps/web/probe-pause.mjs` passes 9 of 9 checks:**
  - FOV, music volume and invert Y set from the pause menu apply in the fight (music at zero stops the score);
  - "All settings" opens a new tab, and a change made there reaches the paused fight;
  - the menu fits a 740×360 phone held landscape;
  - the bottom-left HUD stack (rank and XP, health, second winds, kills) has no overlaps. **Fixed:** the XP bar used to sit inside the health bar, and the second-wind pips over the kill counter.
- **`node apps/web/probe-settings.mjs`** (the Milestone 8 checks, updated for the new page) still passes.
- **`node apps/web/probe-a11y.mjs`** now checks each settings category separately. All seven have no WCAG A or AA violations, signed in.
- **Unit tests:**
  - `lib/__tests__/settings.test.ts`: v2 migration, invalid values, render plan, portable merge and corrupt remote data.
  - `lib/__tests__/keybinds.test.ts`: defaults, reserved keys, conflicts, normalisation and labels.
  - The API's `preferences` tests: the allow-list and shape limits.
