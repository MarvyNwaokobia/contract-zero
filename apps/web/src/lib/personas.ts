// The cast, as data. The names, titles and call signs are fixed by
// docs/contract-zero/PERSONAS.md and must match it. A persona is a voice: the economy
// decides what happens, and a persona only explains a logged decision.

export interface Persona {
  /** Faction or merchant id (matches the server), or 'handler'. */
  id: string
  /** What the radio and subtitles call the speaker. */
  voice: string
  /** The named representative, for interface attribution only (never in generated radio text). */
  name: string
  title: string
  callSign: string
  /** How they speak: for authors and for any future generated text. */
  cadence: string
  say: string[]
  avoid: string[]
  /** Whether the radio can speak with this voice today. */
  onRadio: boolean
}

export const PERSONAS: Record<string, Persona> = {
  handler: { id: 'handler', voice: 'KESTREL', name: 'Kestrel', title: 'Handler', callSign: 'KESTREL', cadence: 'Short, dry, transactional. Plain verbs. Gives the next thing to do.', say: ["Contract's live.", 'Get behind something.', "You're clear."], avoid: ['praise', 'exclamation marks', 'talk of systems or chains'], onRadio: true },
  vanguard: { id: 'vanguard', voice: 'VANGUARD COMMAND', name: 'Ilse Brandt', title: 'Quartermaster', callSign: 'LEDGER', cadence: 'Cold, measured, procedural. Counts things.', say: ['We keep count.', 'Logged.', 'Escorts are doubled on every route out.'], avoid: ['insults', 'boasting', 'slang'], onRadio: true },
  ashen: { id: 'ashen', voice: 'ASHEN COMPACT', name: 'Tavi Roake', title: 'Foreman of the Yard', callSign: 'SLAG', cadence: 'Short, loud, blunt. Threatens rather than warns.', say: ['Burn it.', 'We pay for the fire.', 'Ash remembers.'], avoid: ['polish', 'corporate words', 'long explanations'], onRadio: true },
  vex: { id: 'vex', voice: 'VEX', name: 'Vex', title: 'Proprietor', callSign: 'VEX', cadence: 'Warm the way a business is warm. Easy, informal. Pays as agreed.', say: ['Lovely.', 'As agreed.', 'Bring it round.'], avoid: ['sentiment', 'loyalty', 'promises'], onRadio: true },
  halcyon: { id: 'halcyon', voice: 'HALCYON DESK', name: 'Sena Halloran', title: 'Director of Procurement', callSign: 'DESK', cadence: 'Polished, efficient, courteous. Procurement vocabulary.', say: ['We can fill that.', 'Terms are standard.', 'Lead time is short.'], avoid: ['menace', 'slang', 'anything improvised'], onRadio: true },
}

export const personaFor = (id: string | null | undefined): Persona | undefined => (id ? PERSONAS[id] : undefined)

/** "Ilse Brandt, Quartermaster". */
export const attribution = (p: Persona): string => `${p.name}, ${p.title}`
