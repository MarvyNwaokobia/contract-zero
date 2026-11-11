'use client'

// Before and after for one operation, side by side. Every cell is a recorded value; a
// cell with no record says so. The change mark is text as well as colour.

import type { Consequence } from '@/lib/api'
import { compareConsequence, type Change } from '@/lib/presenter/compare'
import { worldClock } from '@/lib/presenter/consequence'

const MARK: Record<Exclude<Change, null>, { glyph: string; word: string; cls: string }> = {
  up: { glyph: '▲', word: 'up', cls: 'text-amber-hi' },
  down: { glyph: '▼', word: 'down', cls: 'text-hostile' },
  same: { glyph: '=', word: 'unchanged', cls: 'text-dim' },
}

export function BeforeAfter({ c }: { c: Consequence }) {
  const cmp = compareConsequence(c)
  return (
    <div className="overflow-x-auto" data-testid="before-after">
      <table className="w-full min-w-[24rem] text-sm">
        <caption className="sr-only">Recorded state of {c.before.name} before and after the operation</caption>
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wider text-dim">
            <th className="py-1 font-normal">&nbsp;</th>
            <th className="font-normal">Before <span className="normal-case tracking-normal">{worldClock(cmp.beforeAt)}</span></th>
            <th className="font-normal">After <span className="normal-case tracking-normal">{cmp.afterAt != null ? worldClock(cmp.afterAt) : 'not settled'}</span></th>
            <th className="w-20 font-normal">Change</th>
          </tr>
        </thead>
        <tbody>
          {cmp.rows.map((r) => {
            const m = r.change ? MARK[r.change] : null
            return (
              <tr key={r.key} className="border-t border-line/60 align-top" data-testid={`cmp-${r.key}`}>
                <td className="py-1 pr-2 text-muted">{r.label}{r.note && <span className="block text-[11px] text-dim">{r.note}</span>}</td>
                <td className="cz-num pr-2 text-fog">{r.before ?? <span className="text-dim">not recorded</span>}</td>
                <td className="cz-num pr-2 text-fog">{r.after ?? <span className="text-dim">{cmp.settled || r.before == null ? 'not recorded' : 'pending'}</span>}</td>
                <td className={m?.cls ?? 'text-dim'}>{m ? <span aria-label={m.word}>{m.glyph} <span className="text-[11px]">{m.word}</span></span> : '–'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
