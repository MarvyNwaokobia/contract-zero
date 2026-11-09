# Settings and accessibility (Milestone 8)

Every setting lives in one place, **Settings** (`/settings`), and is stored per browser (`lib/settings.ts`). Changes apply immediately, including inside a running fight. The pause menu's graphics and sensitivity controls write to the same settings.

## What you can set

| Area | Setting | Effect |
|---|---|---|
| Graphics | Quality: **Auto** (default), High, Medium, Low | See `PERFORMANCE.md`. Auto steps down by itself and remembers where it settled. |
| | Field of view, 50–80° | The hip field of view; aiming narrows from it. |
| Audio | Master, Effects, Voice and radio, Ambience, Interface | Each 0–100%, live. **Test** plays a sample through that channel. |
| | Mute in background | Silences the game when the tab is hidden. |
| Subtitles | On or off | The radio still plays with subtitles off. |
| | Size (S / M / L), background box opacity, coloured speaker names | A live preview shows the result. |
| Controls | Look sensitivity, 0.3–2.5× | Mouse, arrow keys and touch. |
| | **Press E once to interact** | The hold runs until it completes, E is pressed again, or the target changes. For players who can't hold a key. |
| Accessibility | **Reduce motion** | No camera shake, head bob or weapon sway; hit stagger at 30%. On by default if the system asks for reduced motion. |
| | **Reduce flashes** | The full-screen hit flash becomes a steady tint, there is no blast fireball, flares and fire stop flickering, and the muzzle light drops to 25%. That last one matters because automatic fire would otherwise flicker the whole scene about 10 times a second. |

Older stored settings (`cz_settings` v1, `cz_quality`, `cz_look_sens`) are migrated on first read. Stored values are clamped, so a corrupt value can't break the game.

## Accessibility work and evidence

- **WCAG 2.1 A/AA checks** (axe-core): `node apps/web/probe-a11y.mjs` covers the Hub, Contracts, Exchange, War Room, Training, Settings, Operator, Sign-in and Deploy pages.
  - **Before:** colour-contrast failures on the War Room, Training and Deploy pages. The "dim" text colour (`#5b6068`) was below 4.5:1 on dark panels.
  - **After:** the token is `#878d96`, at least 4.57:1 on every panel background. **All nine pages have no violations.**
  - The faintest in-game HUD hint grey was raised the same way.
- **Keyboard:**
  - Every Settings control is a labelled native input, with visible focus rings, including on the visually hidden radio buttons.
  - The probe changes the field of view with the arrow keys, a volume with Home and a checkbox with Space.
  - The game is fully playable on the keyboard; arrow keys aim.
  - The inspector closes with Esc or I.
- **Screen readers:**
  - Settings use fieldsets with legends, radio groups and `aria-valuetext` on sliders.
  - The save notice is an `aria-live` status.
  - Dialogs (the inspector) are `role="dialog"` with `aria-modal`.
- **Verified live** (`node apps/web/probe-settings.mjs`):
  - settings chosen on `/settings` took effect in a fight: FOV 70, the low tier (pixel ratio 1, no shadow casters), 21 px subtitles, effects at 0;
  - one E press took a crate;
  - camera roll was 0 with reduced motion;
  - changing settings mid-fight applied at once (FOV 62, effects 50%, the handheld drift back);
  - background mute engaged.

## Known gaps

- **The 3D fight isn't usable with a screen reader.** The menus, Hub, board, Exchange and Settings are.
- **Colour plus text.** Objectives, the extraction zone and the HUD use colour together with text labels, but there is no dedicated colour-blind palette.
- **No remapping.** Keys can't be remapped; a toggle replaces the one hold-only action.
- **No recorded dialogue.** Subtitles are the only channel for radio content besides the static.
