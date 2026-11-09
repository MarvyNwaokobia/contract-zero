'use client'

// A top-down map of a site from its real geometry (fps/levels): walls, cover, and the
// operation's points (way in, objectives, the extraction zone). Drawn as SVG, so it
// is exactly the map the fight plays on.

import { LEVELS, type LevelId } from '@/engine/fps/levels'
import type { Mission } from '@/engine/fps/campaign'

const MARK: Record<string, { color: string; label: string }> = {
  start: { color: '#cfd8df', label: 'Insertion' },
  reach: { color: '#37d0e0', label: 'Waypoint' },
  clear: { color: '#e0455a', label: 'Clear' },
  secure: { color: '#e6c766', label: 'Cargo' },
  plant: { color: '#ff7a3a', label: 'Charge' },
  retrieve: { color: '#e6c766', label: 'Seized case' },
  extract: { color: '#5fe0a8', label: 'Extraction' },
}

export function SiteMap({ layout, mission, className = '' }: { layout: LevelId; mission?: Mission; className?: string }) {
  const lv = LEVELS[layout]
  const b = lv.bounds
  const w = b.maxX - b.minX, h = b.maxZ - b.minZ
  // The way in (+z) at the top; deeper into the site toward the bottom.
  const X = (x: number) => x - b.minX
  const Y = (z: number) => b.maxZ - z
  // Numbered as in the objective list; room clears have no point of their own.
  const objs = (mission?.objectives ?? []).map((o, n) => ({ ...o, n: n + 1 })).filter((o) => o.kind !== 'clear')
  const exfil = mission?.field?.exfil
  const supplies = mission?.field?.items.filter((i) => i.kind === 'ammo_crate' || i.kind === 'med_case') ?? []
  return (
    <figure className={className} data-testid="site-map">
      <svg viewBox={`-2 -2 ${w + 4} ${h + 4}`} className="h-full w-full" role="img" aria-label={`Map of ${lv.name}`}>
        <rect x={-2} y={-2} width={w + 4} height={h + 4} fill={lv.floor.kind === 'dirt' ? '#1d1a15' : '#15181c'} />
        {lv.walls.map((c, i) => <rect key={`w${i}`} x={X(c.x - c.w / 2)} y={Y(c.z + c.d / 2)} width={c.w} height={c.d} fill="#4a4f57" />)}
        {lv.cover.map((c, i) => <rect key={`c${i}`} x={X(c.x - c.w / 2)} y={Y(c.z + c.d / 2)} width={c.w} height={c.d} fill="#33373d" />)}
        {supplies.map((s) => <rect key={s.id} x={X(s.pos[0]) - 0.6} y={Y(s.pos[1]) - 0.6} width={1.2} height={1.2} fill={s.kind === 'med_case' ? '#e4e6e1' : '#8a9a5a'} />)}
        {exfil && <circle cx={X(exfil.pos[0])} cy={Y(exfil.pos[1])} r={exfil.radius} fill="#5fe0a822" stroke="#5fe0a8" strokeWidth={0.4} strokeDasharray="1 0.6" />}
        <circle cx={X(lv.start[0])} cy={Y(lv.start[1])} r={1} fill={MARK.start.color} />
        {objs.map((o) => {
          const m = MARK[o.kind] ?? MARK.reach
          return (
            <g key={o.n}>
              <circle cx={X(o.pos[0])} cy={Y(o.pos[1])} r={1.5} fill="none" stroke={m.color} strokeWidth={0.5} />
              <text x={X(o.pos[0])} y={Y(o.pos[1]) + 0.9} fontSize={2.4} textAnchor="middle" fill={m.color} fontWeight={700}>{o.n}</text>
            </g>
          )
        })}
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] uppercase tracking-wider text-muted">
        <span><span style={{ color: MARK.start.color }}>●</span> Insertion</span>
        <span><span style={{ color: MARK.extract.color }}>◌</span> Extraction zone</span>
        <span><span style={{ color: '#8a9a5a' }}>■</span> Ammunition</span>
        <span><span style={{ color: '#e4e6e1' }}>■</span> Medical</span>
        <span>Numbers: objective order</span>
      </figcaption>
    </figure>
  )
}
