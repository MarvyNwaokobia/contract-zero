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
 *
 * Delivery: each line is a radio-styled subtitle + per-speaker static signature;
 * ids map 1:1 to optional VO files (public/vo/{id}.mp3) that
 * scripts/generate-vo.mjs produces when an ElevenLabs key is available. The audio
 * layer prefers the file and falls back to static-only.
 */

export type Speaker = 'handler' | 'vanguard' | 'vex';

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
  | 'bossEnrage';    // a boss is nearly down (phase 3)

export const SPEAKER_META: Record<Speaker, { name: string; color: string }> = {
  handler: { name: 'KESTREL', color: '#8fd6e8' },
  vanguard: { name: 'VANGUARD COMMAND', color: '#e0455a' },
  vex: { name: 'VEX', color: '#e6c766' },
};

export const PRESENCE_LINES: PresenceLine[] = [
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

export function linesFor(trigger: PresenceTrigger): PresenceLine[] {
  return PRESENCE_LINES.filter((l) => l.trigger === trigger);
}
