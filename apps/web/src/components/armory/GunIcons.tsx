'use client'

import type { ReactElement } from 'react'
import type { GunId } from '@/engine/combat/GunStats'

interface GunIconProps {
  size?: number
  color?: string
  className?: string
}

function Sidearm({ size = 48, color = 'currentColor', className }: GunIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" className={className}>
      <g transform="translate(5, 15)">
        {/* Slide */}
        <path d="M5 25 L5 18 Q5 15, 8 15 L55 15 Q58 15, 58 18 L58 30 L40 30 L38 30 L5 30 Z" fill={color} opacity={0.9} />
        {/* Barrel */}
        <rect x="0" y="20" width="8" height="5" rx="1.5" fill={color} opacity={0.65} />
        {/* Ejection port */}
        <rect x="32" y="17" width="12" height="5" rx="1" fill={color} opacity={0.35} />
        {/* Front sight */}
        <rect x="10" y="13" width="2.5" height="4" rx="0.5" fill={color} opacity={0.75} />
        {/* Rear sight */}
        <rect x="48" y="13" width="6" height="3" rx="0.5" fill={color} opacity={0.6} />
        <rect x="50" y="13" width="2" height="3" fill="black" opacity={0.15} />
        {/* Slide serrations */}
        {[42, 44.5, 47, 49.5, 52, 54.5].map(x => (
          <line key={x} x1={x} y1="16" x2={x} y2="29" stroke={color} strokeWidth="0.8" opacity={0.2} />
        ))}
        {/* Frame */}
        <path d="M18 30 L58 30 L58 35 L50 35 L18 35 Z" fill={color} opacity={0.75} />
        {/* Trigger guard */}
        <path d="M28 35 Q28 46, 36 46 L42 46 Q46 46, 46 40 L46 35" stroke={color} strokeWidth="2.5" fill="none" opacity={0.55} />
        {/* Trigger */}
        <path d="M38 36 L35 44 L39 44 Z" fill={color} opacity={0.7} />
        {/* Grip */}
        <path d="M46 33 L60 33 L63 60 Q63 63, 60 63 L49 63 Q46 63, 46 60 Z" fill={color} opacity={0.85} />
        {/* Grip texture */}
        {[39, 43, 47, 51, 55, 59].map(y => (
          <line key={y} x1="48" y1={y} x2="61" y2={y} stroke={color} strokeWidth="0.7" opacity={0.2} />
        ))}
        {/* Magazine baseplate */}
        <rect x="47" y="61" width="14" height="4" rx="1.5" fill={color} opacity={0.6} />
        {/* Beaver tail */}
        <path d="M58 15 L62 14 L62 20 L58 22 Z" fill={color} opacity={0.6} />
      </g>
    </svg>
  )
}

function SMG({ size = 48, color = 'currentColor', className }: GunIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" className={className}>
      <g transform="translate(2, 18)">
        {/* Barrel */}
        <rect x="0" y="18" width="18" height="5" rx="2" fill={color} opacity={0.7} />
        {/* Barrel shroud / handguard */}
        <path d="M14 14 L30 14 L30 28 L14 28 Z" fill={color} opacity={0.7} />
        {/* Vent holes */}
        {[17, 21, 25].map(x => (
          <circle key={x} cx={x} cy={21} r="1.8" fill="black" opacity={0.2} />
        ))}
        {/* Upper receiver */}
        <path d="M28 12 L68 12 Q70 12, 70 14 L70 26 Q70 28, 68 28 L28 28 Z" fill={color} opacity={0.9} />
        {/* Charging handle */}
        <rect x="52" y="9" width="8" height="4" rx="1.5" fill={color} opacity={0.6} />
        {/* Bolt */}
        <rect x="34" y="15" width="14" height="5" rx="1" fill={color} opacity={0.3} />
        {/* Lower */}
        <path d="M30 28 L70 28 L70 33 L46 33 L30 33 Z" fill={color} opacity={0.7} />
        {/* Magazine — straight */}
        <rect x="34" y="33" width="9" height="26" rx="2" fill={color} opacity={0.8} />
        {[40, 45, 50].map(y => (
          <line key={y} x1="35.5" y1={y} x2="41.5" y2={y} stroke={color} strokeWidth="0.6" opacity={0.25} />
        ))}
        <rect x="33" y="57" width="11" height="4" rx="1" fill={color} opacity={0.6} />
        {/* Trigger guard */}
        <path d="M40 33 Q40 42, 46 42 L50 42 Q54 42, 54 38 L54 33" stroke={color} strokeWidth="2" fill="none" opacity={0.5} />
        {/* Trigger */}
        <path d="M48 34 L46 40 L49 40 Z" fill={color} opacity={0.65} />
        {/* Pistol grip */}
        <path d="M54 31 L70 31 L73 54 Q73 56, 71 56 L57 56 Q55 56, 55 54 Z" fill={color} opacity={0.8} />
        {[38, 42, 46, 50].map(y => (
          <line key={`g${y}`} x1="57" y1={y} x2="71" y2={y} stroke={color} strokeWidth="0.6" opacity={0.2} />
        ))}
        {/* Folding stock */}
        <path d="M70 14 L78 12 L80 14 L80 18 L78 20 L70 26" stroke={color} strokeWidth="3" fill="none" opacity={0.45} strokeLinecap="round" />
        <rect x="78" y="11" width="4" height="10" rx="1.5" fill={color} opacity={0.4} />
        {/* Front sight */}
        <rect x="5" y="14" width="2.5" height="5" rx="0.5" fill={color} opacity={0.6} />
        {/* Rear sight */}
        <rect x="58" y="9" width="5" height="4" rx="1" fill={color} opacity={0.5} />
      </g>
    </svg>
  )
}

function AssaultRifle({ size = 48, color = 'currentColor', className }: GunIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" className={className}>
      <g transform="translate(0, 20)">
        {/* Flash hider */}
        <path d="M0 20 L4 17 L4 24 L0 21 Z" fill={color} opacity={0.55} />
        <rect x="1" y="18" width="1.5" height="5" fill={color} opacity={0.35} />
        {/* Barrel */}
        <rect x="3" y="18.5" width="18" height="4" rx="1" fill={color} opacity={0.7} />
        {/* Gas tube */}
        <rect x="12" y="16" width="16" height="2" rx="0.5" fill={color} opacity={0.45} />
        {/* Handguard — M4 quad rail */}
        <path d="M16 14 L32 14 L32 26 L16 26 Z" fill={color} opacity={0.75} />
        {[17, 19.5, 22, 24.5].map(y => (
          <line key={y} x1="17" y1={y} x2="31" y2={y} stroke={color} strokeWidth="0.5" opacity={0.25} />
        ))}
        {/* Front sight / gas block */}
        <path d="M14 12 L14 16 L17 16 L17 12 L15.5 9 Z" fill={color} opacity={0.65} />
        {/* Upper receiver */}
        <path d="M30 11 L62 11 Q64 11, 64 13 L64 23 L30 23 Z" fill={color} opacity={0.9} />
        {/* Flat top rail */}
        <rect x="30" y="9" width="32" height="3" rx="0.5" fill={color} opacity={0.5} />
        {[32, 35, 38, 41, 44, 47, 50, 53, 56, 59].map(x => (
          <line key={x} x1={x} y1="9.5" x2={x} y2="11.5" stroke={color} strokeWidth="0.4" opacity={0.25} />
        ))}
        {/* Ejection port */}
        <rect x="38" y="14" width="12" height="4" rx="1" fill={color} opacity={0.3} />
        {/* Forward assist */}
        <circle cx="54" cy="16" r="2" fill={color} opacity={0.45} />
        {/* Lower receiver */}
        <path d="M32 23 L64 23 L64 28 L48 28 L32 28 Z" fill={color} opacity={0.8} />
        {/* Magazine — curved */}
        <path d="M36 28 L44 28 L47 52 Q47 54, 45 54 L34 53 Q32 53, 33 51 Z" fill={color} opacity={0.8} />
        {[35, 40, 45, 50].map(y => (
          <line key={y} x1="34" y1={y} x2="45" y2={y} stroke={color} strokeWidth="0.5" opacity={0.25} />
        ))}
        {/* Trigger guard */}
        <path d="M38 28 Q38 36, 42 36 L48 36 Q52 36, 52 32 L52 28" stroke={color} strokeWidth="2" fill="none" opacity={0.5} />
        {/* Trigger */}
        <path d="M46 29 L43 35 L47 35 Z" fill={color} opacity={0.6} />
        {/* Pistol grip */}
        <path d="M52 25 L64 25 L67 48 Q67 50, 65 50 L55 50 Q53 50, 53 48 Z" fill={color} opacity={0.8} />
        {[32, 36, 40, 44].map(y => (
          <line key={`g${y}`} x1="55" y1={y} x2="65" y2={y} stroke={color} strokeWidth="0.6" opacity={0.2} />
        ))}
        {/* Buffer tube */}
        <rect x="64" y="13" width="14" height="6" rx="3" fill={color} opacity={0.6} />
        {/* Stock — M4 collapsible */}
        <path d="M76 10 L90 10 Q92 10, 92 12 L92 24 Q92 26, 90 26 L76 26 Z" fill={color} opacity={0.55} />
        <rect x="90" y="11" width="3" height="14" rx="1" fill={color} opacity={0.4} />
        {/* Stock adjustment lever */}
        <rect x="80" y="22" width="6" height="2" rx="0.5" fill={color} opacity={0.3} />
      </g>
    </svg>
  )
}

function Marksman({ size = 48, color = 'currentColor', className }: GunIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" className={className}>
      <g transform="translate(0, 20)">
        {/* Muzzle brake */}
        <rect x="0" y="18" width="6" height="6" rx="1" fill={color} opacity={0.6} />
        <line x1="2" y1="17" x2="2" y2="25" stroke={color} strokeWidth="0.8" opacity={0.3} />
        <line x1="4" y1="17" x2="4" y2="25" stroke={color} strokeWidth="0.8" opacity={0.3} />
        {/* Long barrel */}
        <rect x="5" y="19" width="28" height="4" rx="1" fill={color} opacity={0.7} />
        {/* Free-float handguard */}
        <path d="M20 15 L36 15 L36 27 L20 27 Z" fill={color} opacity={0.65} />
        {/* M-LOK slots */}
        {[23, 27, 31].map(x => (
          <rect key={x} x={x} y="23" width="3" height="2" rx="0.5" fill="black" opacity={0.15} />
        ))}
        {/* Upper receiver */}
        <path d="M34 12 L64 12 Q66 12, 66 14 L66 24 L34 24 Z" fill={color} opacity={0.9} />
        {/* Flat top rail */}
        <rect x="34" y="10" width="30" height="3" rx="0.5" fill={color} opacity={0.45} />
        {/* Scope — large optic */}
        <g opacity={0.85}>
          <rect x="26" y="2" width="32" height="9" rx="4.5" fill={color} opacity={0.7} />
          {/* Objective lens */}
          <circle cx="27" cy="6.5" r="5.5" stroke={color} strokeWidth="1.5" fill="none" opacity={0.55} />
          <circle cx="27" cy="6.5" r="3.5" stroke={color} strokeWidth="0.8" fill="none" opacity={0.3} />
          {/* Eyepiece */}
          <circle cx="57" cy="6.5" r="4" stroke={color} strokeWidth="1.5" fill="none" opacity={0.5} />
          {/* Turrets */}
          <rect x="38" y="0" width="5" height="4" rx="1.5" fill={color} opacity={0.6} />
          <rect x="44" y="0.5" width="5" height="3.5" rx="1.5" fill={color} opacity={0.5} />
          {/* Scope rings */}
          <rect x="30" y="9" width="5" height="4" rx="1" fill={color} opacity={0.5} />
          <rect x="48" y="9" width="5" height="4" rx="1" fill={color} opacity={0.5} />
        </g>
        {/* Lower receiver */}
        <path d="M36 24 L66 24 L66 29 L50 29 L36 29 Z" fill={color} opacity={0.8} />
        {/* Magazine */}
        <rect x="40" y="29" width="9" height="16" rx="1.5" fill={color} opacity={0.75} />
        {[35, 39, 43].map(y => (
          <line key={y} x1="41" y1={y} x2="48" y2={y} stroke={color} strokeWidth="0.5" opacity={0.25} />
        ))}
        {/* Trigger guard */}
        <path d="M42 29 Q42 37, 46 37 L50 37 Q54 37, 54 33 L54 29" stroke={color} strokeWidth="1.8" fill="none" opacity={0.5} />
        {/* Trigger */}
        <path d="M49 30 L47 35 L50 35 Z" fill={color} opacity={0.6} />
        {/* Grip */}
        <path d="M56 26 L66 26 L66 46 Q66 48, 64 48 L58 48 Q56 48, 56 46 Z" fill={color} opacity={0.8} />
        {[33, 37, 41, 45].map(y => (
          <line key={`g${y}`} x1="57" y1={y} x2="65" y2={y} stroke={color} strokeWidth="0.5" opacity={0.2} />
        ))}
        {/* Precision stock */}
        <path d="M66 12 L78 11 Q80 11, 82 13 L84 18 Q86 22, 84 24 L78 26 L66 24 Z" fill={color} opacity={0.55} />
        <rect x="70" y="11" width="10" height="5" rx="1.5" fill={color} opacity={0.4} />
        <rect x="82" y="14" width="4" height="10" rx="1.5" fill={color} opacity={0.4} />
        {/* Bipod */}
        <line x1="22" y1="27" x2="17" y2="40" stroke={color} strokeWidth="2.5" opacity={0.45} strokeLinecap="round" />
        <line x1="28" y1="27" x2="33" y2="40" stroke={color} strokeWidth="2.5" opacity={0.45} strokeLinecap="round" />
        <rect x="15" y="39" width="5" height="2.5" rx="1" fill={color} opacity={0.35} />
        <rect x="31" y="39" width="5" height="2.5" rx="1" fill={color} opacity={0.35} />
      </g>
    </svg>
  )
}

function Legendary({ size = 48, color = 'currentColor', className }: GunIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" className={className}>
      <g transform="translate(0, 18)">
        {/* Integrated suppressor */}
        <rect x="0" y="17" width="20" height="9" rx="4.5" fill={color} opacity={0.6} />
        {[5, 9, 13, 17].map(x => (
          <circle key={x} cx={x} cy={21.5} r="1.2" fill="black" opacity={0.15} />
        ))}
        {/* Bullpup body */}
        <path d="M18 10 L72 8 Q74 8, 74 10 L74 28 Q74 30, 72 30 L18 32 Z" fill={color} opacity={0.9} />
        {/* Full-length top rail */}
        <rect x="18" y="6" width="54" height="3" rx="0.5" fill={color} opacity={0.5} />
        {[20, 23, 26, 29, 32, 35, 38, 41, 44, 47, 50, 53, 56, 59, 62, 65, 68].map(x => (
          <line key={x} x1={x} y1="6.5" x2={x} y2="8.5" stroke={color} strokeWidth="0.35" opacity={0.25} />
        ))}
        {/* Holographic sight */}
        <g opacity={0.8}>
          <rect x="26" y="0" width="16" height="7" rx="2" fill={color} opacity={0.6} />
          <rect x="28" y="2" width="12" height="3" rx="1" fill="black" opacity={0.25} />
          <circle cx="34" cy="3.5" r="1" fill={color} opacity={0.75} />
        </g>
        {/* Ejection port */}
        <rect x="24" y="14" width="8" height="4" rx="1" fill={color} opacity={0.3} />
        {/* Side controls */}
        <circle cx="38" cy="16" r="1.5" fill={color} opacity={0.4} />
        <rect x="41" y="15" width="4" height="2.5" rx="0.5" fill={color} opacity={0.35} />
        {/* Angled foregrip */}
        <path d="M26 32 L31 32 L33 44 Q33 46, 31 46 L26 46 Q24 46, 24 44 Z" fill={color} opacity={0.7} />
        {/* Trigger (forward — bullpup) */}
        <path d="M34 30 Q34 38, 38 38 L42 38 Q46 38, 46 34 L46 32" stroke={color} strokeWidth="1.8" fill="none" opacity={0.5} />
        <path d="M40 32 L38 37 L41 37 Z" fill={color} opacity={0.6} />
        {/* Magazine — behind grip (bullpup) */}
        <rect x="54" y="30" width="10" height="22" rx="2" fill={color} opacity={0.8} />
        {[37, 42, 47].map(y => (
          <line key={y} x1="55.5" y1={y} x2="62.5" y2={y} stroke={color} strokeWidth="0.5" opacity={0.25} />
        ))}
        <rect x="53" y="50" width="12" height="3.5" rx="1" fill={color} opacity={0.6} />
        {/* Stock — integrated short */}
        <path d="M68 10 L82 8 Q84 8, 84 10 L84 24 Q84 26, 82 26 L68 26 Z" fill={color} opacity={0.55} />
        <rect x="72" y="8" width="10" height="5" rx="2" fill={color} opacity={0.4} />
        <rect x="82" y="11" width="4" height="13" rx="1.5" fill={color} opacity={0.4} />
        {/* Accent glow lines */}
        <line x1="20" y1="16" x2="66" y2="14" stroke={color} strokeWidth="0.7" opacity={0.3} />
        <line x1="20" y1="26" x2="66" y2="24" stroke={color} strokeWidth="0.7" opacity={0.3} />
        {/* Status LEDs */}
        <circle cx="48" cy="17" r="1.2" fill={color} opacity={0.7} />
        <circle cx="52" cy="17" r="1.2" fill={color} opacity={0.5} />
        <circle cx="56" cy="17" r="1.2" fill={color} opacity={0.3} />
      </g>
    </svg>
  )
}

const GUN_ICON_MAP: Record<GunId, (props: GunIconProps) => ReactElement> = {
  sidearm: Sidearm,
  smg: SMG,
  assault_rifle: AssaultRifle,
  marksman: Marksman,
  legendary: Legendary,
  // Seasonal weapons take the nearest existing silhouette for the small 2D card
  // icon; the card's 3D crate preview shows their real model.
  ashfall_carbine: AssaultRifle,
  warden_repeater: Marksman,
  rift_lance: Legendary,
  seraph_lmg: AssaultRifle,
  ember_halo: Legendary,
}

export function GunIcon({ gunId, ...props }: GunIconProps & { gunId: GunId }) {
  const Icon = GUN_ICON_MAP[gunId]
  return <Icon {...props} />
}
