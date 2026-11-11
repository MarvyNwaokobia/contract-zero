'use client'

// Who this power is: a portrait, what it is, what its things look like, how it speaks, and
// one line in its own voice about its position right now. The line (lib/presenter/remarks)
// restates real state; the dossier explains and never decides.

import { Portrait } from '@/components/ui/Portrait'
import { FactionInsignia } from '@/components/ui/FactionInsignia'
import { IDENTITY, factionColor } from '@/lib/factions'
import { attribution, personaFor } from '@/lib/personas'

export function FactionDossier({ id, remark, compact = false }: { id: string; remark?: string; compact?: boolean }) {
  const who = IDENTITY[id], p = personaFor(id)
  if (!who || !p) return null
  const c = factionColor(id)
  return (
    <section className="grid grid-cols-[auto_1fr] gap-3 border border-line bg-ink-2/60 p-3" data-testid={`dossier-${id}`} aria-label={`${who.name} dossier`}>
      <div className="flex flex-col items-center gap-1.5" style={{ color: c }}>
        <Portrait id={id} size={compact ? 56 : 76} />
        <FactionInsignia id={id} className="h-5 w-5" title="" />
      </div>
      <div className="min-w-0">
        <div className="font-display text-sm font-bold uppercase tracking-wider text-fog">{attribution(p)}</div>
        <div className="text-[11px] uppercase tracking-widest text-dim">Call sign {p.callSign} · {who.name}</div>
        {remark && <blockquote className="mt-1.5 border-l-2 pl-2 text-sm italic text-fog" style={{ borderColor: c }} data-testid="remark">“{remark}”</blockquote>}
        <p className="mt-1 text-[11px] text-dim">{remark ? 'Describes the position as it stands; the economy engine makes the decisions.' : 'A voice, not a decision-maker: the economy engine decides.'}</p>
        {!compact && (
          <dl className="mt-2 grid gap-0.5 text-xs">
            {([['Is', who.role], ['Looks', who.materials], ['Equipment', who.equipment], ['Speaks', who.voice]] as const).map(([k, v]) => (
              <div key={k} className="grid grid-cols-[4.5rem_1fr] gap-2"><dt className="text-dim">{k}</dt><dd className="text-muted">{v}</dd></div>
            ))}
            <div className="mt-1 flex flex-wrap gap-1.5" aria-label="Palette">{who.palette.map(([label, css]) => <span key={label} title={label} className="inline-flex items-center gap-1 text-[10px] text-dim"><span className="h-3 w-3 border border-line-strong" style={{ background: css }} />{label}</span>)}</div>
          </dl>
        )}
      </div>
    </section>
  )
}
