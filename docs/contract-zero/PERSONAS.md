# Personas: who speaks for each power

This extends the cast in [STORY.md](STORY.md). It records the names, roles and voice direction so every screen, radio line and caption uses the same people the same way. If you add a character, add them here first.

## The rule: voice, not authority

**The economy decides what happens. A character explains it.**

- A faction's commander "decides" only in the sense that the engine validated an action and logged it (`agent_decision` in `world_events`). The persona shown beside that record is its voice.
- Dialogue never creates, changes or hides a decision. A line is written from a logged rationale, a recorded snapshot or a real event, and where there is none, there is no line.
- Names appear only as attribution in the interface ("Ilse Brandt, Quartermaster"). They are **not** put into generated radio text: the model-voicing check in `services/story.rs` only allows names from its cast list, and a name it does not know is rejected. Radio keeps speaking as "Vanguard Command", "Ashen Compact" and so on.
- Names, titles and call signs below are fixed. Do not vary them, shorten them differently, or invent relatives, histories or motives that are not recorded here.

## The cast

| Power | Voice on the radio | Named representative | Title | Call sign |
|---|---|---|---|---|
| Kestrel (the player's handler) | **KESTREL** | Kestrel | Handler | KESTREL |
| Vanguard | **VANGUARD COMMAND** | Ilse Brandt | Quartermaster | LEDGER |
| Ashen Compact | **ASHEN COMPACT** | Tavi Roake | Foreman of the Yard | SLAG |
| Vex Exchange | **VEX** | Vex | Proprietor | VEX |
| Halcyon Logistics | **HALCYON DESK** | Sena Halloran | Director of Procurement | DESK |

Kestrel and Vex are the names the game already uses; they are their own representatives. Halcyon's voice is on the radio as **HALCYON DESK**, with its own subtitle colour and a clean, narrow signature; no mission line uses it yet (see "Status").

## Voice direction

### Kestrel: the handler
- **Role:** the contractor's handler. On your side while the contract is; never cheers.
- **Cadence:** short, dry, transactional. Plain verbs. Gives the next thing to do.
- **Say:** "Contract's live." "Get behind something." "You're clear."
- **Avoid:** praise, exclamation marks, jokes at the contractor's expense, anything about systems or chains.
- **Sample:** "Forward escort's down. Someone just keyed in on the convoy channel."
- **Radio signature:** close, warm band.

### Vanguard command: Quartermaster Ilse Brandt (LEDGER)
- **Role:** runs Vanguard's logistics and escort posture. Keeps meticulous records.
- **Cadence:** cold, measured, procedural. Counts things. Complete sentences.
- **Say:** "We keep count." "Logged." "Escorts are doubled on every route out."
- **Avoid:** insults, boasting, slang, raised stakes with no number behind them.
- **Sample:** "That cargo is accounted for. You will be too."
- **Radio signature:** low, heavy band (the channel drops to make room).
- **Visual direction (portrait, not yet drawn):** worn olive-drab collar, stencilled numerals, reading glasses pushed up, a ledger instead of a weapon.

### Ashen Compact: Foreman Tavi Roake (SLAG)
- **Role:** speaks for the refinery. Quick to pay for someone else's violence.
- **Cadence:** short, loud, blunt. Threatens rather than warns. Fire and ash.
- **Say:** "Burn it." "We pay for the fire." "Ash remembers."
- **Avoid:** polish, corporate words, long explanations.
- **Sample:** "Vanguard took our fuel. Take their depot."
- **Radio signature:** harsh, overdriven double band (a refinery set).
- **Visual direction:** soot-streaked welder's mask pushed back, scorched sleeves, a hand-painted unit mark.

### Vex Exchange: Vex
- **Role:** wholesaler; everyone's counterparty and no one's friend.
- **Cadence:** warm the way a business is warm. Easy, informal, a little amused. Pays as agreed and not a credit more.
- **Say:** "Lovely." "As agreed." "Bring it round."
- **Avoid:** sentiment, loyalty, promises about the future.
- **Sample:** "Bring it round to the exchange. I'll have the credits ready, as agreed."
- **Radio signature:** mid band.
- **Visual direction:** chalk-marked crates, a tarp awning, an amber lamp, handwritten tags.

### Halcyon Logistics: Director Sena Halloran (DESK)
- **Role:** speaks for Halcyon's procurement desk. A lean supplier that competes with Vex for every order.
- **Cadence:** polished, efficient, courteous. Procurement vocabulary: lead time, fill, lot, terms.
- **Say:** "We can fill that." "Terms are standard." "Lead time is short."
- **Avoid:** menace, slang, anything that sounds improvised.
- **Sample:** "Halcyon can fill seven lots against that order at the stated price."
- **Radio signature:** clean, higher, narrower band than Vex (two short narrow bands, built).
- **Visual direction:** pale grey uniform with a thin blue edge, a tablet, palletised freight behind.

## Where each voice may speak

| Context | Who | Source of the words |
|---|---|---|
| Mission briefing and radio | Kestrel; the target's voice | `services/story.rs` templates, from facts the server holds |
| War Table: a faction's latest decision | The faction's representative (attribution only) | the logged `rationale` |
| Merchant procurement and offers | Vex or Halcyon (when wired) | the order record and each merchant's logged answer |
| Debrief | Kestrel | the stored result |

## Status

- Names, titles, call signs and voice direction: **documented here** and defined in `apps/web/src/lib/personas.ts` (checked by tests).
- Interface attribution: **built** on the War Table's Commander block.
- Radio: Kestrel, Vanguard, Ashen, Vex and Halcyon all have a voice (speaker, subtitle colour, signature). No mission line is written in Halcyon's voice yet; its lines come from the strategic radio (merchant procurement), not from `story.rs`.
- Portraits: **not drawn**; the visual direction above is the brief for them.
- Recorded voice: none. Lines are subtitles over a synthesised radio signature.
