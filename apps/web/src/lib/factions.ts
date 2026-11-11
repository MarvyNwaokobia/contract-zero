// One place for who is who on the map. Colours are design tokens from globals.css;
// the names come from the server, so this only supplies a colour and a short role.

export const FACTION_COLOR: Record<string, string> = {
  vanguard: 'var(--color-steel)',
  ashen: 'var(--color-hostile)',
  vex: 'var(--color-amber)',
  halcyon: 'var(--color-fog)',
}
export const factionColor = (id: string | null | undefined) => (id && FACTION_COLOR[id]) || 'var(--color-muted)'
