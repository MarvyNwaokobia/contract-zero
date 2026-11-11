// Who is who on the map and in the interface: each power's colour, materials, equipment and
// way of speaking. The descriptions restate docs/contract-zero/PERSONAS.md and STORY.md (a test
// keeps them in step); the names of factions and merchants themselves come from the server.

export const FACTION_COLOR: Record<string, string> = {
  vanguard: 'var(--color-steel)',
  ashen: 'var(--color-hostile)',
  vex: 'var(--color-amber)',
  halcyon: 'var(--color-fog)',
}
export const factionColor = (id: string | null | undefined) => (id && FACTION_COLOR[id]) || 'var(--color-muted)'

export interface FactionIdentity {
  id: string
  name: string
  /** What kind of power it is, in a phrase. */
  role: string
  /** What its things are made of and look like (the art brief). */
  materials: string
  /** Recognisable equipment. */
  equipment: string
  /** How it speaks, in a phrase. */
  voice: string
  /** Swatches: [label, CSS colour]. The first is its accent. */
  palette: [string, string][]
}

export const IDENTITY: Record<string, FactionIdentity> = {
  vanguard: {
    id: 'vanguard', name: 'Vanguard', role: 'Disciplined military logistics, professional command',
    materials: 'Olive-drab and steel, stencilled numerals', equipment: 'Standardised crates, tracked vehicles',
    voice: 'Cold, measured, procedural. Counts everything.',
    palette: [['steel', '#6fa3c7'], ['olive', '#59603f'], ['stencil', '#d8d3c4']],
  },
  ashen: {
    id: 'ashen', name: 'Ashen Compact', role: 'Rugged industrial power, improvisation, aggressive survival',
    materials: 'Rust, soot, welded plate', equipment: 'Jury-rigged rigs, hand-painted markings',
    voice: 'Short, loud, blunt. Threatens rather than warns.',
    palette: [['ember', '#e5484d'], ['rust', '#8a4a2a'], ['soot', '#2a2522']],
  },
  vex: {
    id: 'vex', name: 'Vex Exchange', role: 'Opportunistic, informal wartime commerce',
    materials: 'Tarp, chalk-marked crates, amber lamps', equipment: 'Mixed salvage, handwritten tags',
    voice: 'Warm the way a business is warm. Pays as agreed.',
    palette: [['amber', '#f0a03c'], ['tarp', '#6b5a3a'], ['chalk', '#e8e4dc']],
  },
  halcyon: {
    id: 'halcyon', name: 'Halcyon Logistics', role: 'Polished corporate procurement and efficiency',
    materials: 'Clean white-grey, thin blue accent', equipment: 'Uniform palletised freight',
    voice: 'Polished, efficient, courteous. Procurement vocabulary.',
    palette: [['blue', '#9fc3e0'], ['grey', '#c9cdd2'], ['white', '#f1f3f5']],
  },
}
export const identityFor = (id: string | null | undefined): FactionIdentity | undefined => (id ? IDENTITY[id] : undefined)
