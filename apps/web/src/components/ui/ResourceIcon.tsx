// The four things the game is about, as one icon family: ammunition, medicine, fuel and
// credits. Original artwork on a 24px grid, drawn with currentColor so they take the
// surrounding text colour, and always paired with a text label or aria-label by callers.

export type IconKind = 'ammo' | 'med' | 'fuel' | 'credits'

export const ICON_LABEL: Record<IconKind, string> = { ammo: 'Ammunition', med: 'Medicine', fuel: 'Fuel', credits: 'Credits' }
/** The accent each resource wears wherever it is drawn. */
export const ICON_COLOR: Record<IconKind, string> = { ammo: 'var(--color-amber)', med: 'var(--color-friendly)', fuel: 'var(--color-steel)', credits: 'var(--color-fog)' }

export function ResourceIcon({ kind, className = 'h-4 w-4', title }: { kind: IconKind; className?: string; title?: string }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'square' as const, strokeLinejoin: 'miter' as const }
  return (
    <svg viewBox="0 0 24 24" className={className} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} data-icon={kind} {...p}>
      {title && <title>{title}</title>}
      {/* three cartridges: tapered heads, flat bases, a primer line */}
      {kind === 'ammo' && <><path d="M4.5 21v-9l2-4 2 4v9zM10.5 21v-9l2-4 2 4v9zM16.5 21v-9l2-4 2 4v9z" /><path d="M4.5 17.5h4M10.5 17.5h4M16.5 17.5h4" /></>}
      {/* a field case with a cross */}
      {kind === 'med' && <><path d="M3 7h18v13H3zM8.5 7V4h7v3" /><path d="M12 10.5v6M9 13.5h6" strokeWidth="2.2" /></>}
      {/* a jerrycan: handle, spout and a fill line */}
      {kind === 'fuel' && <><path d="M5 8l3-4h6l1 3v14H5z" /><path d="M15 7h3.5L20 9v10h-5M8 12h4" /><path d="M5 16h10" strokeDasharray="2 2" /></>}
      {/* a notched chit: hexagon with a punched centre */}
      {kind === 'credits' && <><path d="M12 2.5l8 4.5v10l-8 4.5-8-4.5V7z" /><path d="M9 10h6M9 14h6" /><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" /></>}
    </svg>
  )
}
