// Original insignia for the four powers. Simple geometry drawn with currentColor, each
// carrying one idea about its owner: Vanguard's disciplined chevrons, the Ashen Compact's
// riveted weld-plate with a slash, Vex's chalked ticket, Halcyon's clean hex ring and
// pallet line. Unknown factions get a neutral blank plate rather than a borrowed mark.

import { factionColor } from '@/lib/factions'

export function FactionInsignia({ id, className = 'h-8 w-8', title, colored = true }: { id: string | null | undefined; className?: string; title?: string; colored?: boolean }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'square' as const, strokeLinejoin: 'miter' as const }
  return (
    <svg viewBox="0 0 48 48" className={className} style={colored ? { color: factionColor(id) } : undefined} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} data-insignia={id ?? 'none'} {...p}>
      {title && <title>{title}</title>}
      {id === 'vanguard' && (<>
        {/* a shield stencilled with three rising chevrons and a bar: ordered, professional */}
        <path d="M24 3l17 6v14c0 10-7 18-17 22C14 41 7 33 7 23V9z" />
        <path d="M14 22l10-7 10 7M14 29l10-7 10 7" />
        <path d="M17 35h14" strokeWidth="3" />
      </>)}
      {id === 'ashen' && (<>
        {/* a weld-plate: bolted corners and a jagged slash of flame through it, improvised and hard-used */}
        <path d="M8 8h32v32H8z" />
        <circle cx="13" cy="13" r="1.6" fill="currentColor" stroke="none" /><circle cx="35" cy="13" r="1.6" fill="currentColor" stroke="none" />
        <circle cx="13" cy="35" r="1.6" fill="currentColor" stroke="none" /><circle cx="35" cy="35" r="1.6" fill="currentColor" stroke="none" />
        <path d="M30 10l-9 12h6l-8 16 14-17h-7z" fill="currentColor" fillOpacity="0.22" />
      </>)}
      {id === 'vex' && (<>
        {/* a ticket stub with notched sides, a chalked V and a tally: informal wartime trade */}
        <path d="M6 14h36v7a3 3 0 0 0 0 6v7H6v-7a3 3 0 0 0 0-6z" />
        <path d="M16 19l5 10 5-10" strokeWidth="2.6" />
        <path d="M32 19v10M35 19v10M38 19v10M31 28l9-8" strokeWidth="1.5" />
      </>)}
      {id === 'halcyon' && (<>
        {/* a thin hexagon ring over a pallet line and a single node: polished procurement */}
        <path d="M24 4l17 10v20L24 44 7 34V14z" strokeWidth="1.6" />
        <path d="M14 27h20M14 31h20" strokeWidth="1.6" />
        <circle cx="24" cy="19" r="3.2" />
      </>)}
      {!['vanguard', 'ashen', 'vex', 'halcyon'].includes(id ?? '') && (<><path d="M9 9h30v30H9z" strokeDasharray="4 3" /><path d="M18 24h12" /></>)}
    </svg>
  )
}
