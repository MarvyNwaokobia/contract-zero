# CONTRACT ZERO: sites, conditions and physical operations

How an operation is placed in the world, what the hour does to it, what the player physically does there, and how those actions become (or don't become) economic results.

## Sites: every contract has a place

An operation is bound to a **site** when its plan is made (`crates/economy/src/site.rs`, stored on `RaidPlan.site`). The site depends on who holds the stock, what the stock is and what the operation is for, so the same contract is at the same place at every hour.

| Site | Held by | Map | Facilities |
|---|---|---|---|
| **Dustline Depot** | Vanguard | `dustline_depot` | munitions warehouse and munitions line (ammunition), motor-pool fuel depot (fuel), warehouse aid store (medicine), container yard |
| **Blacksite** | Vanguard | `blacksite` | medical vault, armoury vault, APC motor bay, server room, control room (seized cargo) |
| **Cinder Yard** | Ashen Compact | shares `dustline_depot` | refinery tanks (fuel), arms shed, aid shed, container stacks |

| Target | Operation | Site |
|---|---|---|
| Vanguard | raid or sabotage on ammunition or fuel | Dustline Depot |
| Vanguard | raid on medicine | Blacksite (the medical vault) |
| Vanguard | recovery of seized caravan cargo | Blacksite (where Vanguard keeps what it doesn't log) |
| Ashen Compact | anything | Cinder Yard |

**Cinder Yard has no map of its own yet.** It plays on the Dustline Depot layout. The briefing says so, and its objectives are worded for a yard gate and a tank farm. A refinery map is the first new environment to build.

**Compatibility.** Plans saved before sites have an empty `site`; `RaidPlan::site()` derives it. Clients that don't send a site fall back to the old zone rule (`levelForZone`).

**Consequences carry over.** A sabotage takes the site's line down for 36 game hours. `GET /world` and `GET /board` list each site with its lines and `down_until`. While a line is down there is no sabotage contract for it, and the board shows what is left.

## The clock: conditions, not places

The world clock is accelerated: one game hour is `WORLD_TICK_SECS` real seconds (60 by default), so a game day is 24 minutes. The Hub, the Contract Board and the contract intel all show the hour, the phase, what it does, and when it next changes.

| Phase | Hours | Lighting | Guard sight | Accuracy | Relief | NVG |
|---|---|---|---|---|---|---|
| Day | 06–16 | full daylight | 30 m | 100% | normal | no |
| Dusk | 17–20 | low sun | 26 m | 92% | 20% faster (shift change) | no |
| Night | 21–05 | lamps and floodlights only | 20 m | 80% | 10% slower (night watch) | issued |

`site::conditions(tick)` is the source. The server sends it with every contract, the client applies it (`FpsSim` `engageRange` and `enemyAccuracy`, the reinforcement interval, the lighting theme and the NVG issue), and the briefing prints the same numbers.

## The flow before a fight

Contract Board → **Contract intel** → accept → **briefing** → **loadout** → fight → results.

- **Intel** (before anything is locked):
  - the site and facility, and the hour's conditions;
  - a map drawn from the level's real geometry, with the objectives, supplies and extraction zone;
  - the objectives in order;
  - the guards the faction could arm, and its reinforcements;
  - the bounty or fee, and the bounty rule;
  - what you go in with, and the way out.
- **Accept** calls `POST /missions/start`. It locks the plan and stores the site and the object list with the session.
- **Loadout** comes after the briefing. `POST /missions/{session}/loadout` checks the gun against the ledger, as at start.

## Physical objects

The server fixes each operation's objects at start (`mission::field_manifest`), and the client places them on the map (`levels.ts` `field`, `fps/field.ts`). Everything is driven by one typed interaction system: each object has a kind, a reach, a hold time and its contents. The system checks proximity, the view cone and line of sight against walls and cover. It shows a contextual prompt with a hold bar, and releasing E, looking away or stepping away cancels the hold.

| Object | Hold | Notes |
|---|---|---|
| Ammunition crate | 0.8 s | 90 rounds of rifle *or* pistol ammunition (the band colour says which). Takes what fits; the rest stays. The lid opens when it's empty. Crates on site: 1 + the faction's spare ammunition / 60, up to 4. |
| Medical case | 0.8 s | 2 field dressings. Cases exist only if the faction holds medicine (none at 0, 1 below 20, 2 at 20+). |
| Dropped magazine | 0.4 s | Two in three guards drop one where they fall (rifle or pistol, matched to the player's weapons). |
| Cargo case (raid) | 2 s | The manifest is split into cases of about 25 units, at most 4 (60 units → 3 × 20). Colour-coded by resource. |
| Seized case (recovery) | 3 s | One strapped, blinking case holding the whole manifest. |
| Charge (sabotage) | 5 s | Set on a named target: the fuel depot and the munitions line at the depot, the APC motor bay and the server room at the Blacksite. |
| Extraction call | 1 s | At the zone, once there is something to extract. |

**Inventory and ammunition:**
- **Magazines.** Each weapon has a magazine and a finite reserve: 3 spare magazines on contracts and practice, 4 in the campaign and Endless, at most 6.
- **Reloading.** A reload draws from the reserve. An empty reserve says so ("NO SPARE ROUNDS · FIND AMMUNITION").
- **Pickups.** Rounds go to the weapons that take them.
- **Field dressings.** Start with one and carry up to 3. Press H to apply one: 1.4 s with the weapon lowered, then +55 HP.
- **Arena modes.** The Kill-House and Gauntlet keep an unlimited reserve.
- **Separate from the economy.** Weapon ammunition is not the economic ammunition resource. Loose supplies are consumed in the fight and are never settled; the economy's ammunition moves only as cargo.

**Carrying cargo:**
- At most 3 cases at once. Each case costs 10% movement speed, and the seized case costs 20%.
- The HUD shows cases carried, units and the speed penalty.
- With 4 cases on site, one is left behind or needs a second trip.

## Operation types

| Type | Objectives | What's distinct |
|---|---|---|
| **Raid** | breach → clear the outer zone → push in → **secure** cases → **extract** | Extraction can be called as soon as one case is in hand. Reinforcements trickle in while you work the cargo. |
| **Sabotage** | breach → **plant** charge one → push in → **plant** charge two → **extract** | No room clears. The second charge lights a 12 s fuse and wakes the whole site. The blast is a fireball, a burning glow and a scorch mark; it hurts you within 7 m. Then an alarm, the target's radio line and more guards. |
| **Recovery** | breach → push in → **retrieve** the seized case → **handover** | Ends at the owner's vehicle, not the way you came in. The case is heavy. |

## Extraction

Every applicable mission ends in a marked zone, and the method fits the place:

| Site | Raid / sabotage exit | Recovery handover |
|---|---|---|
| Dustline Depot / Cinder Yard | Vex's flatbed at the south gate | the owner's truck at the east fence |
| Blacksite | a painted landing zone with an H, outside the gate | the escort's truck at the gate |

**What marks the zone:**
- A ground ring: grey while locked, pulsing amber when ready, green while counting.
- A countdown arc that fills around the ring, and the seconds in large type.
- Three red flares with a flickering light.
- A smoke column that turns green once extraction is called.
- The waiting vehicle, or the landing-zone markings.

**How it runs:**
1. Press E at the zone to call it. The radio confirms it in the sponsor's or Vex's voice.
2. Stay inside for 8 s.
3. Leaving pauses the countdown, which bleeds back at half speed until you return. The handler tells you to get back in.
4. Going down cancels it.
5. Guards keep coming while it counts.

On completion the screen reads what you actually brought out ("EXTRACTED · 2 CASES · 40 AMMUNITION", "HANDED OVER · 60 FUEL"), and the result is reported.

The training campaign's final "extract" walk is now a real extraction zone with a 5 s hold.

## Economic integrity

What counts, and who decides:

- **Ids only.** The client reports a record of object ids: secured cases, charges set, the case delivered, containers looted. **The server owns every amount.** It counts units from the session's stored manifest, never from the client.
- **Checked before anything settles** (`mission::assess`):
  - an unknown id or a repeated id rejects the run;
  - a raid with no case rejects it;
  - a sabotage needs both charges;
  - a recovery needs the seized case delivered.
- **Time.** The server measures mission time itself. The minimum grows with what the record claims: traversal + extraction + 2 s per case, both charges, or the retrieve.
- **Partial extraction** settles exactly the cases carried out (`Action::SettleSecured`, capped at the manifest and at what the depot holds). A raid bounty pays only if at least half the manifest came out.
- **Death settles nothing.** Cargo you were carrying drops where you fell and can be picked up again by you, before the run ends.
- **One completion per session.** A replay returns the first result.
- **Debug shortcuts** (`window.__cz*`, the `/dev` routes) exist only in development builds. A production build compiles them out unless `NEXT_PUBLIC_CZ_DEV_HOOKS=1`.

**Limit:** a modified client can still claim it carried a case it didn't. What it can't do is invent a case, take one twice, move more than the manifest, finish faster than the claimed work takes, or settle twice. Server-side movement validation would be the next step.

**On chain:** the settlement is the existing raid settlement, now with the secured units. It is queued at completion and shows as "Settled on NEAR" only once confirmed.

## Training and practice (never scored)

`/training` has three modes. None of them call the economy or NEAR.

- **Campaign:** the 15 authored operations (Dustline, Redyard, Blacksite), plus the Kill-House. Gauntlet unlocks after op 15.
- **Practice:** choose the environment, time of day, operation, defense level 1–5 and cargo. The intel panel shows the result. It uses the same builder, objects and extraction as a live contract, with a locally computed object list.
- **Endless:** the procedural room chain (`fps/endless.ts`), with rooms generated ahead of you in growing waves. Finite ammunition, with magazines dropped by guards. Unscored.

## Seasonal: not built, deliberately

The Seasonal Campaign is a ranked Endless where everyone in a season gets the same seed. Its reusable parts are intact: the seeded chain (`fps/endless.ts`) and `ContractZeroScene`'s `endless` and `seasonal` props, plus wave callbacks. It needs, before it can ship:
1. A season record on the server: the seed, start and end, and who is enrolled.
2. Server-owned wave banking with a minimum time per wave. `handlers/endless.rs` from the earlier codebase is kept as a reference (see `RECOVERY_AUDIT.md`).
3. A leaderboard with anti-replay checks.
4. A decision on rewards. Anything that pays must settle through the same verified path as contracts.

## How to test every environment and mode

Start the API (`apps/api`, `cargo run`) and the web app (`apps/web`, `npx next dev -p 3000`).

**By hand:**

| What | Where |
|---|---|
| Clock and sites | Hub (`/`) and Contract Board (`/contracts`): hour, phase, next change, and each contract's site and facility |
| A live contract | `/contracts` → View intel → Accept and get briefed → Choose loadout → Deploy |
| Any site × hour × type × difficulty | `/training` → Practice |
| Endless | `/training` → Endless |
| Campaign and Kill-House | `/training` → Campaign (Esc → Operations to choose an op). To unlock every op, run `localStorage.setItem('cz_progress','15')` in the console and reload. |
| Direct, dev builds only | `/dev/level?site=dustline-depot\|blacksite&phase=day\|dusk\|night&kind=raid\|sabotage\|recovery&defense=1..5&seed=n` |

**Controls:**
- **Interaction:** E to interact (hold), H for a field dressing.
- **Movement:** C to crouch, Q / G to lean. Lean right moved from E to G.
- **Touch screens:** USE (hold) and MED buttons.

**Automated:**
- `node apps/web/probe-field.mjs [web] [outdir] [filter]`: every operation type in both maps, in day, dusk and night variants. It checks supplies, holds versus taps, cargo, the speed penalty, charges and detonation, the seized case, the extraction call, leaving the zone, completion and the record. It also runs one real fight (finite ammunition, reloads, dropped magazines), measures frame rate and takes screenshots.
- `node apps/web/probe-modes.mjs [web] [api] [outdir]`: the clock on the Hub and the board, contract intel before the loadout (signed in), and Practice, Endless and Campaign.
- `node scripts/field-e2e.mjs [api]`, against the live API and NEAR testnet:
  - sites and conditions on the board;
  - loadout ownership;
  - forged, duplicate and missing records;
  - a too-fast run, and death;
  - a partial extraction paying exactly the carried case, replay protection, and the on-chain balance change.
