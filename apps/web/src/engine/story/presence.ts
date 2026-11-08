/**
 * The three voices (CLONE_PLAN.md slice 5: Valor as presence).
 *
 * The gate for this slice: a first-time player can say who they are, who
 * Ember is, and why Valor scares them, WITHOUT reading a menu. So the story
 * arrives as voices over the fight, never as a screen you must visit:
 *
 *   ASH   — the hero. The one who walked out of the fire. Never speaks;
 *           everyone speaks TO them (the GoW intimacy trick at zero VO cost).
 *   EMBER — the other survivor. Your ally on a scavenged radio. Warm, scared,
 *           practical. The relationship arc of the campaign.
 *   VALOR — the name every enemy dies protecting. He has your radio channel.
 *           He is never a body in zone 1 — only a voice that owns things:
 *           the crew, Cinder, and the blade in your hand.
 *
 * Delivery: each line is a radio-styled subtitle + per-speaker static
 * signature now; the ids map 1:1 to VO files (public/vo/{id}.mp3) that
 * scripts/generate-vo.mjs produces when an ElevenLabs key is available.
 * AudioDirector.playVo() prefers the file and falls back to static-only.
 *
 * Lines are data, triggers are semantic — the campaign reuses this exact
 * shape when the playground grows into Ashfall (slice 6).
 */

export type Speaker = 'ember' | 'valor' | 'cinder';

export interface PresenceLine {
  id: string;
  speaker: Speaker;
  text: string;
  trigger: PresenceTrigger;
}

export type PresenceTrigger =
  | 'combatStart'   // first fight of the session
  | 'firstCatch'    // the first recall catch — the weapon acknowledged
  | 'lowHp'         // first time below 30
  | 'troopsCleared' // round 1 down, something else is coming
  | 'bossIntro'     // Cinder takes the field
  | 'bossPhase2'
  | 'bossPhase3'
  | 'heroDown'
  | 'zoneClear'     // Cinder dead
  | 'zoneClearTag'  // the follow-up beat after zoneClear
  // ── Valor doorkicker beats (the plan slice 6). The melee triggers above name a
  // blade the hero no longer carries, so the rifle operation gets its own lines.
  // These have no recorded mp3 yet: they land as subtitle + radio static until
  // scripts/generate-vo.mjs is run with an ElevenLabs key (it reads this file).
  | 'opStart'        // briefing: who you are, who Ember is, whose compound this is
  | 'opBreach'       // the doorway
  | 'valorFirstWord' // he answers the channel Ember just noticed
  | 'opPushIn'       // entering the objective room
  | 'opHeroDown'     // Valor over your body (rifle-appropriate)
  | 'missionCleared' // a non-finale op is done (Ember)
  | 'valorReveal'    // the finale: Valor, finally in the room with you
  | 'bossEscalate'   // a boss dropped past half — it stops holding back (phase 2)
  | 'bossEnrage';    // a boss is nearly down and turns feral (phase 3)

export const SPEAKER_META: Record<Speaker, { name: string; color: string }> = {
  ember: { name: 'EMBER', color: '#ffb38a' },
  valor: { name: 'VALOR', color: '#e0455a' },
  cinder: { name: 'CINDER', color: '#ff4422' },
};

export const PRESENCE_LINES: PresenceLine[] = [
  {
    id: 'ember-radio-check',
    speaker: 'ember',
    trigger: 'combatStart',
    text: "Radio check. Ash, it's me. So you actually took the blade... they're going to come for it.",
  },
  {
    id: 'ember-first-catch',
    speaker: 'ember',
    trigger: 'firstCatch',
    text: 'It comes back to you. It never did that for any of them.',
  },
  {
    id: 'ember-low-hp',
    speaker: 'ember',
    trigger: 'lowHp',
    text: "You're bleeding. Move, Ash. MOVE.",
  },
  {
    id: 'ember-troops-cleared',
    speaker: 'ember',
    trigger: 'troopsCleared',
    text: 'Four down... wait. Ash, someone else is on this channel.',
  },
  {
    id: 'valor-intro',
    speaker: 'valor',
    trigger: 'bossIntro',
    text: "There you are. My crew, my village, and now my blade in your hand. Cinder, bring it back to me.",
  },
  {
    id: 'cinder-phase2',
    speaker: 'cinder',
    trigger: 'bossPhase2',
    text: 'You want to know what the fire looked like? Look closer.',
  },
  {
    id: 'valor-phase3',
    speaker: 'valor',
    trigger: 'bossPhase3',
    text: 'Stop playing with it, Cinder.',
  },
  {
    id: 'valor-hero-down',
    speaker: 'valor',
    trigger: 'heroDown',
    text: 'Leave the body. Bring my blade.',
  },
  {
    id: 'valor-zone-clear',
    speaker: 'valor',
    trigger: 'zoneClear',
    text: '...So it chose you. Keep it warm for me, ember-rat. I burn everything I own.',
  },
  {
    id: 'ember-zone-clear',
    speaker: 'ember',
    trigger: 'zoneClearTag',
    text: 'That voice. Ash... that was him. That was Valor.',
  },

  // ── Valor doorkicker lines (slice 6). No mp3 yet → subtitle + radio static. ──
  {
    id: 'ember-op-start',
    speaker: 'ember',
    trigger: 'opStart',
    text: "Radio check, Ash. It's Ember. Two of us walked out of that fire, and one of us is standing outside a compound that belongs to him. Go.",
  },
  {
    id: 'ember-op-breach',
    speaker: 'ember',
    trigger: 'opBreach',
    text: "Door's yours. Whatever they're holding in there, they're holding it for him.",
  },
  {
    id: 'valor-first-word',
    speaker: 'valor',
    trigger: 'valorFirstWord',
    text: "You hear me. Good. I wanted you to know I have been on this channel the whole time.",
  },
  {
    id: 'valor-push-in',
    speaker: 'valor',
    trigger: 'opPushIn',
    text: 'Deeper, then. Everything you came for is in that room. So is everything I left there for you.',
  },
  {
    id: 'valor-op-down',
    speaker: 'valor',
    trigger: 'opHeroDown',
    text: 'Leave the body where it fell. Ember, you can stay on the line for this part.',
  },
  {
    id: 'ember-mission-cleared',
    speaker: 'ember',
    trigger: 'missionCleared',
    text: "Compound's clear, Ash. Extract, and we push to the next one. He's still out there.",
  },
  {
    id: 'valor-reveal',
    speaker: 'valor',
    trigger: 'valorReveal',
    text: 'So. You walked all the way into the dark to find me. Good. I was getting tired of the radio.',
  },
  {
    id: 'valor-boss-escalate',
    speaker: 'valor',
    trigger: 'bossEscalate',
    text: "You cut him. He felt that. Now watch what he does when he stops being careful.",
  },
  {
    id: 'valor-boss-enrage',
    speaker: 'valor',
    trigger: 'bossEnrage',
    text: "He's almost gone, and he knows it. That's when they're worst. Finish it.",
  },
];

export function linesFor(trigger: PresenceTrigger): PresenceLine[] {
  return PRESENCE_LINES.filter((l) => l.trigger === trigger);
}
