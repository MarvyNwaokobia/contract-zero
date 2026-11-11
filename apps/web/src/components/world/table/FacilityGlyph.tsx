// Small recognisable miniatures of each place, drawn from simple shapes. They stand for
// the kind of facility (a container yard, a bunker, a refinery, a market stall), not a
// survey of it.

const K = 'var(--color-line-strong)'

export function FacilityGlyph({ id, color, size = 36 }: { id: string; color: string; size?: number }) {
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden>
      {id === 'dustline-depot' && (<g fill="none" stroke={color} strokeWidth="1.6"><rect x="4" y="22" width="9" height="8" /><rect x="14" y="22" width="9" height="8" /><rect x="9" y="14" width="9" height="8" /><path d="M28 30V12M26 12h6" stroke={K} /><path d="M3 33h34" stroke={K} /></g>)}
      {id === 'blacksite' && (<g fill="none" stroke={color} strokeWidth="1.6"><path d="M5 30V19l8-6h14l8 6v11z" /><path d="M16 30v-8h8v8" /><path d="M20 8v5" stroke={K} /><circle cx="20" cy="7" r="1.6" fill={color} stroke="none" /></g>)}
      {id === 'cinder-yard' && (<g fill="none" stroke={color} strokeWidth="1.6"><rect x="4" y="19" width="11" height="12" rx="3" /><rect x="17" y="22" width="9" height="9" rx="2.5" /><path d="M31 31V9h4v22" /><path d="M32 6c1-2 1 2 2 0" stroke={K} /></g>)}
      {id.startsWith('exchange') && (<g fill="none" stroke={color} strokeWidth="1.6"><path d="M5 17l3-8h24l3 8z" /><path d="M7 17v13h26V17" /><path d="M16 30v-8h8v8" stroke={K} /></g>)}
      {!['dustline-depot', 'blacksite', 'cinder-yard'].includes(id) && !id.startsWith('exchange') && (<g fill="none" stroke={color} strokeWidth="1.6"><rect x="8" y="12" width="24" height="18" /><path d="M8 20h24" stroke={K} /></g>)}
    </svg>
  )
}
