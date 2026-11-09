/**
 * Radio voices over the fight.
 *
 * The story arrives as voices on the channel, never as a screen you must visit:
 *
 *   KESTREL  — your contract handler. Calm, transactional, on your side as long
 *              as the contract is.
 *   VANGUARD — Vanguard command. The faction whose convoys you hit;
 *              it notices, and it talks about what it will do next.
 *   VEX      — the independent merchant who buys what you take. Friendly in the
 *              way a business is friendly.
 *   ASHEN    — the Ashen Compact, fuel refiners and Vanguard's rival. Zealous,
 *              short sentences, fire and ash.
 *
 * On a live contract the server writes the mission's lines from verified facts
 * (apps/api/src/services/story.rs) and they replace these defaults per trigger;
 * the defaults below still voice training and any trigger the server leaves out.
 *
 * Delivery: each line is a radio-styled subtitle + per-speaker static signature;
 * ids map 1:1 to optional VO files (public/vo/{id}.mp3) that
 * scripts/generate-vo.mjs produces when an ElevenLabs key is available. The audio
 * layer prefers the file and falls back to static-only.
 */

export type Speaker = 'handler' | 'vanguard' | 'vex' | 'ashen';

export interface PresenceLine {
  id: string;
  speaker: Speaker;
  text: string;
  trigger: PresenceTrigger;
}

/** The beats the scene fires. */
export type PresenceTrigger =
  | 'opStart'        // deployment: whose cargo, who is paying
  | 'opBreach'       // through the first door
  | 'troopsCleared'  // the forward escort is down
  | 'rivalFirstWord' // the convoy owner comes on the channel (once per session)
  | 'opPushIn'       // entering the yard
  | 'finaleReveal'   // entering the last room of the hardest op
  | 'lowHp'          // first time below 30
  | 'opHeroDown'     // the player is down for good
  | 'missionCleared' // extracted
  | 'zoneClear'      // a boss is down
  | 'zoneClearTag'   // the follow-up beat after zoneClear
  | 'bossEscalate'   // a boss dropped past half (phase 2)
  | 'bossEnrage'     // a boss is nearly down (phase 3)
  | 'cargoSecured'   // first cargo case in hand (or the seized case)
  | 'chargePlaced'   // first sabotage charge set
  | 'detonation'     // the charges blow: the target reacts
  | 'extractCalled'  // extraction called in: hold the zone
  | 'extractBroken'  // left the zone mid-countdown
  | 'extractDone';   // out

export const SPEAKER_META: Record<Speaker, { name: string; color: string }> = {
  handler: { name: 'KESTREL', color: '#8fd6e8' },
  vanguard: { name: 'VANGUARD COMMAND', color: '#e0455a' },
  vex: { name: 'VEX', color: '#e6c766' },
  ashen: { name: 'ASHEN COMPACT', color: '#f08a4b' },
};

export const PRESENCE_LINES: PresenceLine[] = [
  // Field beats. Ids start "dyn-" so the audio layer plays them as radio, never a recording.
  { id: 'dyn-default-cargo', speaker: 'handler', trigger: 'cargoSecured', text: "That's one. Carry what you can and get to the extraction zone." },
  { id: 'dyn-default-charge', speaker: 'handler', trigger: 'chargePlaced', text: 'Charge set. One more, then we light it.' },
  { id: 'dyn-default-boom', speaker: 'vanguard', trigger: 'detonation', text: 'Fire on the line! Seal the site. Nobody leaves.' },
  { id: 'dyn-default-exfil', speaker: 'handler', trigger: 'extractCalled', text: 'Extraction is inbound. Hold the zone until it lands.' },
  { id: 'dyn-default-exfil-broken', speaker: 'handler', trigger: 'extractBroken', text: "You've left the zone. They won't wait for you. Get back in." },
  { id: 'dyn-default-exfil-done', speaker: 'handler', trigger: 'extractDone', text: "You're out. Nice work." },
  { id: 'handler-op-start', speaker: 'handler', trigger: 'opStart', text: "Contract's live. The cargo is in the yard past the hall. Load it, walk it out, get paid." },
  { id: 'handler-op-breach', speaker: 'handler', trigger: 'opBreach', text: "You're in. Escort's awake now, so make it quick." },
  { id: 'handler-troops-cleared', speaker: 'handler', trigger: 'troopsCleared', text: 'Forward escort is down. Someone just keyed in on the convoy channel.' },
  { id: 'vanguard-first-word', speaker: 'vanguard', trigger: 'rivalFirstWord', text: "This is Vanguard. That cargo is accounted for. You will be too." },
  { id: 'handler-push-in', speaker: 'handler', trigger: 'opPushIn', text: "That's the yard. Get on the cargo and start loading. They will try to take it back." },
  { id: 'vanguard-finale', speaker: 'vanguard', trigger: 'finaleReveal', text: 'Every crate you carry out, we pay for twice. Remember that when the next convoy rolls.' },
  { id: 'handler-low-hp', speaker: 'handler', trigger: 'lowHp', text: "You're hit. Get behind something. The cargo isn't going anywhere." },
  { id: 'vanguard-hero-down', speaker: 'vanguard', trigger: 'opHeroDown', text: 'Raider down. Recover the cargo and log the bounty as unpaid.' },
  { id: 'vex-mission-cleared', speaker: 'vex', trigger: 'missionCleared', text: "Lovely. Bring it round to the exchange. I'll have the credits ready, as agreed." },
  { id: 'vanguard-zone-clear', speaker: 'vanguard', trigger: 'zoneClear', text: 'Convoy commander lost. Doubling escorts on every route out of the depot.' },
  { id: 'handler-zone-clear', speaker: 'handler', trigger: 'zoneClearTag', text: 'Hear that? They just raised the price of the next job.' },
  { id: 'handler-boss-escalate', speaker: 'handler', trigger: 'bossEscalate', text: "He's hurt and he knows it. He'll stop being careful now." },
  { id: 'handler-boss-enrage', speaker: 'handler', trigger: 'bossEnrage', text: 'Almost done. This is when they are worst. Finish it.' },
];

/** A mission's own lines from the server, by trigger. */
export interface StoryLine { id: string; speaker: string; text: string }
export type MissionRadio = Partial<Record<PresenceTrigger, StoryLine[]>>;

/** The full story the server briefs a contract with. */
export interface MissionStory {
  codename: string;
  location: string;
  time: string;
  briefing: StoryLine[];
  radio: MissionRadio;
  /** "authored", or "llm:<model>" when checked model rewrites were accepted. */
  source: string;
}

const known = (s: string): s is Speaker => s in SPEAKER_META;

/** Lines for a trigger: the mission's own when it has them, else the defaults. */
export function linesFor(trigger: PresenceTrigger, radio?: MissionRadio): PresenceLine[] {
  const own = radio?.[trigger]?.filter((l) => known(l.speaker) && l.text.trim());
  if (own?.length) return own.map((l) => ({ id: l.id, speaker: l.speaker as Speaker, text: l.text, trigger }));
  return PRESENCE_LINES.filter((l) => l.trigger === trigger);
}
