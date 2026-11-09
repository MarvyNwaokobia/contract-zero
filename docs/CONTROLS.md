# Controls

<!-- Generated from apps/web/src/lib/controls.ts by `npx tsx scripts/export-controls.ts` (in apps/web). Do not edit by hand: a test fails when this file and the game disagree. -->

These are the default keys. Every keyboard action can be rebound in **Settings → Key bindings**, and the game shows your own keys in prompts, hints and the in-game **How to play**. Aim, crouch and interact can each be **hold** or **toggle** (Settings → Controls).

## Keyboard and mouse

### Mouse and system

| Action | Control | Notes |
|---|---|---|
| Look and aim | Mouse | Click the game to capture the mouse |
| Fire | Left mouse |  |
| Aim down sights | Right mouse |  |
| Pause, release the mouse | Esc | Reserved: not rebindable |

### Movement

| Action | Control | Notes |
|---|---|---|
| Move forward | W |  |
| Move back | S |  |
| Strafe left | A |  |
| Strafe right | D |  |
| Crouch | C | Hold by default (Settings can make it a toggle) |
| Lean left | Q |  |
| Lean right | G |  |

### Look

| Action | Control | Notes |
|---|---|---|
| Look up | ↑ |  |
| Look down | ↓ |  |
| Look left | ← |  |
| Look right | → |  |

### Combat

| Action | Control | Notes |
|---|---|---|
| Fire | Space | Left mouse also fires |
| Aim down sights | L-Shift / R-Shift | Right mouse also aims; hold by default (Settings can make it a toggle) |
| Reload | R |  |
| Fire mode | B |  |
| Primary weapon | 1 |  |
| Sidearm | 2 |  |
| Swap weapon | X | Also 1 / 2 to pick a slot |
| Target lock | T | Snaps to the nearest visible enemy; press again to cycle |

### Field

| Action | Control | Notes |
|---|---|---|
| Use / interact | E | Hold until the bar fills (Settings can make it press-once) |
| Inspect item | I | What you are looking at: stats, condition, what it is for |
| Field dressing | H | Takes a moment and lowers your weapon |

### Equipment

| Action | Control | Notes |
|---|---|---|
| Night vision | N | When equipped (issued for night operations) |
| Weapon light | F | When the weapon has a light |
| Laser sight | L | When the weapon has a laser |
| Optic | O | When the weapon has an optic |

### Interface

| Action | Control | Notes |
|---|---|---|
| Operations board | M | Training campaign only |
| Performance readout | P |  |

## Touch

One thumb moves, the other aims and fires. Aim down sights and crouch are toggles on touch. Play in landscape.

| Action | Control | Notes |
|---|---|---|
| Move | Stick (bottom left) | How far you drag sets the speed |
| Look | Drag anywhere on screen | Below the top strip, outside the buttons; tap an enemy to lock onto it |
| Fire | Fire pad (bottom right) | Hold to shoot; slide on it to steer your aim |
| Aim down sights | ADS | A toggle: tap on, tap off (stays lit while on) |
| Crouch | CROUCH | A toggle |
| Use / interact | USE (hold) | Hold until the bar fills |
| Field dressing | MED |  |
| Target lock | Lock button (above fire) | Tap again to cycle targets |
| Reload | Reload button (right edge) |  |
| Swap weapon | Swap button (right edge) |  |
| Fire mode | Fire-mode button (right edge) |  |
| Night vision, light, laser, optic | Attachment chips (top left) | Only what your weapon carries |
| Pause / exit | Pause and EXIT (top left) |  |

## Field rules

- Hold the use key on ammunition crates and medical cases to take them; magazines dropped by guards and their weapons can be taken too.
- Cargo cases are physical: carry up to 3, each slows you about 10% (a seized recovery case, 20%).
- At the extraction zone, hold the use key to call it in, then stay inside for 8 seconds. Leaving the zone bleeds the countdown; going down drops what you carry.
- Only cargo carried through a completed extraction counts. A raid bounty needs at least half the manifest.
- Practice and Training are unscored and never touch NEAR. Live contracts settle on NEAR testnet; "Settled on NEAR" appears only once the transaction is confirmed.
