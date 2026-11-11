'use client'

// The strategic map. A layered 2D tactical table: terrain contours and grid, faction
// territories, facilities, the convoys on the road and the markers for what is happening
// (a line down, a contract open, an operator deployed). Layout is schematic and says so.
// Facilities are real buttons: keyboard, mouse and touch all select them.

import { factionColor } from '@/lib/factions'
import { TABLE_VIEW, type TableModel, type TableFacility } from '@/lib/world/table'
import type { ResourceName } from '@/lib/api'
import { FacilityGlyph } from './FacilityGlyph'

export type Tone = 'ok' | 'warn' | 'critical' | 'info'
export interface FacilityStatus {
  /** Readiness label, shown as text as well as colour. */
  label: string
  tone: Tone
  linesDown: number
  /** Contracts the board offers at this facility. */
  openContracts: number
  activeOperations: number
}

const TONE: Record<Tone, string> = { ok: 'var(--color-friendly)', warn: 'var(--color-amber)', critical: 'var(--color-hostile)', info: 'var(--color-steel)' }
const RES_COLOR: Record<ResourceName, string> = { ammo: 'var(--color-amber)', med: 'var(--color-friendly)', fuel: 'var(--color-steel)' }
const clock = (tick: number) => `D${Math.floor(tick / 24)} ${String(tick % 24).padStart(2, '0')}:00`

function Node({ f, status, selected, onSelect }: { f: TableFacility; status: FacilityStatus | undefined; selected: boolean; onSelect: () => void }) {
  const c = factionColor(f.owner)
  const tone = status ? TONE[status.tone] : 'var(--color-dim)'
  return (
    <g transform={`translate(${f.pos.x} ${f.pos.y})`} role="button" tabIndex={0} aria-pressed={selected}
      aria-label={`${f.name}, ${f.kind === 'site' ? 'held by' : ''} ${f.owner}${status ? `, ${status.label}` : ''}${status?.linesDown ? `, ${status.linesDown} production line down` : ''}`}
      className="group cursor-pointer outline-none" data-testid={`facility-${f.id}`}
      onClick={onSelect} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect() } }}>
      {/* a 44px-wide hit area for touch */}
      <rect x="-30" y="-30" width="60" height="78" fill="transparent" />
      <circle r="27" fill="var(--color-panel)" stroke={tone} strokeWidth={selected ? 3 : 1.8} opacity="0.98" />
      <circle r="31" fill="none" stroke="var(--color-fog)" strokeWidth="2" strokeDasharray="4 3" className="opacity-0 group-focus-visible:opacity-100" />
      {selected && <circle r="35" fill="none" stroke={c} strokeWidth="1.2" opacity="0.8" />}
      <g transform="translate(-18 -18)"><FacilityGlyph id={f.id} color={c} size={36} /></g>
      <text y="44" textAnchor="middle" className="fill-fog font-display text-[12px] font-bold uppercase tracking-wider">{f.name}</text>
      {status && <text y="57" textAnchor="middle" className="font-display text-[10px] font-semibold uppercase tracking-widest" style={{ fill: tone }}>{status.label}</text>}
      {status && status.linesDown > 0 && <g transform="translate(22 -24)"><path d="M0 -9L9 7H-9Z" fill="var(--color-hostile)" stroke="var(--color-ink)" strokeWidth="1.5" /><text y="4.5" textAnchor="middle" className="fill-ink text-[10px] font-bold">!</text><title>{status.linesDown} production line down</title></g>}
      {status && status.openContracts > 0 && <g transform="translate(-22 -24)"><circle r="8.5" fill="var(--color-amber)" stroke="var(--color-ink)" strokeWidth="1.5" /><text y="4" textAnchor="middle" className="fill-ink text-[10px] font-bold">{status.openContracts}</text><title>{status.openContracts} contract{status.openContracts === 1 ? '' : 's'} on offer here</title></g>}
      {status && status.activeOperations > 0 && <g transform="translate(0 -36)"><rect x="-11" y="-7" width="22" height="14" fill="var(--color-steel)" stroke="var(--color-ink)" strokeWidth="1.5" /><text y="3.5" textAnchor="middle" className="fill-ink text-[9px] font-bold">OP</text><title>{status.activeOperations} operator deployed here</title></g>}
    </g>
  )
}

export function WarTable({ model, status, selectedId, onSelect, tick }: { model: TableModel; status: Record<string, FacilityStatus>; selectedId: string | null; onSelect: (id: string) => void; tick: number }) {
  const { w, h } = TABLE_VIEW
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-auto w-full min-w-[620px] select-none" role="group" aria-label="War Table: facilities, territories and supply convoys. A schematic, not a survey.">
      <defs>
        <pattern id="wt-grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="var(--color-line)" strokeWidth="0.5" /></pattern>
        <linearGradient id="wt-ground" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="var(--color-ink-2)" /><stop offset="1" stopColor="var(--color-panel)" /></linearGradient>
      </defs>
      <rect width={w} height={h} fill="url(#wt-ground)" />
      <rect width={w} height={h} fill="url(#wt-grid)" opacity="0.7" />
      {/* terrain contours: decoration only */}
      <g fill="none" stroke="var(--color-line-strong)" strokeWidth="1" opacity="0.35" aria-hidden>
        <path d="M-10 190C90 150 160 190 250 170S420 120 520 160 700 190 780 150" />
        <path d="M-10 215C100 180 170 225 262 202S430 160 530 198 700 225 780 188" />
        <path d="M-10 70C120 40 200 100 330 60S560 20 780 80" />
        <path d="M-10 95C130 66 205 124 336 86S566 48 780 106" />
      </g>
      {/* territories */}
      {model.territories.map((t) => {
        const fs = model.facilities.filter((f) => t.facilityIds.includes(f.id))
        const rx = Math.max(...fs.map((f) => Math.abs(f.pos.x - t.anchor.x))) + 62
        const ry = Math.max(...fs.map((f) => Math.abs(f.pos.y - t.anchor.y))) + 66
        return (
          <g key={t.owner} aria-hidden>
            <ellipse cx={t.anchor.x} cy={t.anchor.y} rx={rx} ry={ry} fill={factionColor(t.owner)} fillOpacity="0.05" stroke={factionColor(t.owner)} strokeOpacity="0.45" strokeDasharray="2 5" strokeWidth="1.3" />
            <text x={t.anchor.x} y={t.anchor.y - ry + 14} textAnchor="middle" className="font-display text-[10px] font-semibold uppercase tracking-[0.3em]" style={{ fill: factionColor(t.owner), opacity: 0.8 }}>{t.name}</text>
          </g>
        )
      })}
      {/* supply routes: drawn only while a convoy is actually on one */}
      {model.convoys.filter((c) => c.state === 'in_transit').map((c) => <polyline key={`r${c.id}`} points={c.path.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={RES_COLOR[c.resource]} strokeOpacity="0.5" strokeWidth="1.6" strokeDasharray="6 6" aria-hidden />)}
      <g transform={`translate(${model.offMap.x} ${model.offMap.y})`} aria-hidden>
        <path d="M-12 8L0 -8L12 8Z" fill="var(--color-panel-2)" stroke="var(--color-dim)" strokeWidth="1.5" />
        <text x="14" y="-13" textAnchor="end" className="fill-muted text-[10px] uppercase tracking-widest">Off-map supply</text>
      </g>
      {model.facilities.map((f) => <Node key={f.id} f={f} status={status[f.id]} selected={f.id === selectedId} onSelect={() => onSelect(f.id)} />)}
      {/* convoys: strategic transport markers placed from the server's own progress */}
      {model.convoys.filter((c) => c.state === 'in_transit' || c.state === 'seized').map((c, i) => {
        const seized = c.state === 'seized'
        return (
          <g key={c.id} transform={`translate(${c.pos.x} ${c.pos.y})`} data-testid={`convoy-${c.id}`}>
            <rect x="-6.5" y="-6.5" width="13" height="13" transform="rotate(45)" fill={seized ? 'var(--color-hostile)' : RES_COLOR[c.resource]} stroke="var(--color-ink)" strokeWidth="2" />
            <text x="11" y={-4 - (i % 4) * 11} className="fill-fog font-display text-[10px] font-semibold">{c.units} {c.resource}{seized ? ' · SEIZED' : ''}</text>
            <title>{`${c.ownerName}: ${c.units} ${c.resource}. ${seized ? `Seized by ${c.seizedBy}.` : `Dispatched ${clock(c.dispatchedAt)}, due ${clock(c.arrivesAt)} (${Math.round(c.progress * 100)}% of the trip by the server's clock).`} Strategic transport marker, not vehicle telemetry.`}</title>
          </g>
        )
      })}
      <text x="12" y="16" className="fill-dim text-[10px]">Schematic. Positions are slots, not survey data. Day {Math.floor(tick / 24)}, {String(tick % 24).padStart(2, '0')}:00.</text>
    </svg>
  )
}
