# CONTRACT ZERO: setting, cast and how the story is written

## The setting

The Dustline basin is a dry valley where fuel, ammunition and medicine are worth more than the people carrying them. No government reaches it. Two factions hold its industry, and one merchant holds its market.

- **Vanguard** runs the **Dustline Depot**: a fortified motor pool and warehouse yard by day, and the **Blacksite** facility at night. It makes ammunition, burns fuel, and keeps meticulous records.
- **The Ashen Compact** refines fuel at its own site. It needs ammunition and resents Vanguard for having it. It is louder, angrier and quicker to pay for someone else's violence.
- **Vex Exchange** buys whatever is carried out, sells whatever is short, and runs caravans in from the outer markets. Vex isn't anyone's friend, but is everyone's counterparty.

The player is a **contractor**: no flag, a callsign, and a handler. Contracts are real.
- A faction or Vex posts a contract because its own position calls for it: a rival is getting rich, a shelf is overstocked, or a caravan was taken.
- The board shows only what someone is actually paying for, or what is actually sitting in a depot.

## The cast

| Voice | Who | How they talk | Radio signature |
|---|---|---|---|
| **Kestrel** | The player's handler | Calm, dry, transactional. On your side while the contract is. Never cheers. | Close, warm band |
| **Vanguard Command** | Vanguard's operations desk | Cold, disciplined, bureaucratic menace. Counts everything: "We keep count." | Low, heavy band |
| **Ashen Compact** | The refinery's voice | Zealous, short sentences, fire and ash. Threatens rather than warns. | Harsh, overdriven double band |
| **Vex** | The merchant | Warm the way a business is warm. "Lovely." Pays as agreed, and not a credit more. | Mid band |

## Where the story comes from

Every mission's lines are written by the server from facts it can vouch for (`apps/api/src/services/story.rs`).

**At deployment, the server captures:**
- The contract: kind, target, resource, the units at stake, the defense level and the number of armed guards.
- Who is paying, and how much.
- **Why they posted it.** This is the sponsor's own logged rationale from the decision record that the War Room shows.
- What the target already remembers about this player: raids, sabotage and recoveries against it.
- Which rival has been paying for raids on the target.
- The player's callsign, and the time of day.

**From those facts it writes:**
- **The briefing:** a codename, location and time, then Kestrel's terms, the sponsor's reason in the sponsor's voice, and Kestrel's intel.
- **The radio:** a line for each beat of the fight, fired by objectives. The target faction speaks in its own voice, and mentions your record if it has one.
  - Raid: breach → room cleared → target comes on the channel → push in → extraction.
  - Sabotage: breach → first charge (target reacts) → second charge → clear.
  - Recovery: breach → inside (target reacts) → secure → handover.
- **The debrief** at completion, from the stored result:
  - what was taken or destroyed;
  - what was paid;
  - for a sabotage, the hour the line comes back;
  - how many operations the target now remembers against you.

These authored templates always produce a complete story, so the game never needs a model to have a story.

### Model voicing (optional, checked)

With `NEAR_AI_API_KEY` set, the first request for a mission's story asks NEAR AI Cloud to rewrite the authored lines in each speaker's voice. Each rewritten line is accepted only if it:
- has exactly the same numbers as the authored line (none added, changed or dropped);
- adds no capitalised name that neither the line nor the cast list contains;
- uses no out-of-world words: no blockchains, tokens, wallets, AI, models or transactions;
- stays between 8 and 170 characters.

A line that fails keeps its authored text. The call has a 10 second limit, and the briefing waits for it for at most 12 seconds before using the authored story. Every proposal and verdict is logged (`story_call` in `world_events`), and the briefing card is marked "voiced" when any rewrite was accepted.

The model never decides what happened. It only says it differently.

## Defaults

`apps/web/src/engine/story/presence.ts` keeps the default lines. They voice training and any beat the server leaves out. The server's lines have ids starting with `dyn-`, and the audio layer never looks for a recording of them: they play as radio static with a subtitle.

## Not built

- Recorded voice for the per-mission lines. The defaults can take recordings at `public/vo/{id}.mp3`.
- Branching dialogue or choices.
- A second merchant (Halcyon).
- In-engine camera cinematics. The insertion is a letterboxed briefing card, not a camera flyover.
