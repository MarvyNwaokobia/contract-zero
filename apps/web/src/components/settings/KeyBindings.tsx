'use client'

// Key bindings: pick a slot, press a key. A key already used elsewhere moves here and
// the action that lost it is named (with undo). Reserved keys are refused with the
// reason. Esc cancels capture; Backspace or Delete clears the slot.

import { useEffect, useState } from 'react'
import { ACTIONS, DEFAULT_BINDS, assign, clearSlot, conflicts, keyLabel, unboundRequired, type Action, type Binds } from '@/lib/keybinds'
import { Button, Note, focusRing } from './controls'

type Slot = { action: Action; slot: 0 | 1 }

export function KeyBindings({ binds, onChange }: { binds: Binds; onChange: (b: Binds) => void }) {
  const [capturing, setCapturing] = useState<Slot | null>(null)
  const [notice, setNotice] = useState<{ tone: 'info' | 'warn' | 'error'; text: string; undo?: Binds } | null>(null)

  useEffect(() => {
    if (!capturing) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.code === 'Escape') { setCapturing(null); setNotice({ tone: 'info', text: 'Cancelled. Nothing changed.' }); return }
      if (e.code === 'Backspace' || e.code === 'Delete') {
        onChange(clearSlot(binds, capturing.action, capturing.slot))
        setNotice({ tone: 'info', text: `${label(capturing.action)}: slot ${capturing.slot + 1} cleared.` })
        setCapturing(null)
        return
      }
      const r = assign(binds, capturing.action, capturing.slot, e.code)
      if (r.error) { setNotice({ tone: 'error', text: `${keyLabel(e.code)} can’t be bound. ${r.error}` }); return } // keep listening
      onChange(r.binds)
      setNotice(r.displaced
        ? { tone: 'warn', text: `${keyLabel(e.code)} moved to ${label(capturing.action)}. ${label(r.displaced.action)} lost it${r.binds[r.displaced.action].some(Boolean) ? '' : ' and now has no key'}.`, undo: binds }
        : { tone: 'info', text: `${label(capturing.action)} is now ${keyLabel(e.code)}.` })
      setCapturing(null)
    }
    // Capture phase, so nothing else on the page sees the key first.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, binds, onChange])

  const missing = unboundRequired(binds)
  const dupes = conflicts(binds)
  const groups = [...new Set(ACTIONS.map((a) => a.group))]

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <p className="flex-1 text-xs text-dim">Choose a slot and press a key. <kbd className="text-muted">Esc</kbd> cancels; <kbd className="text-muted">Backspace</kbd> clears. The mouse is fixed: left button fires, right button aims.</p>
        <Button onClick={() => { onChange(DEFAULT_BINDS); setNotice({ tone: 'info', text: 'Every key is back to its default.', undo: binds }) }} testid="binds-reset">Reset keys</Button>
      </div>
      <div aria-live="polite" className="min-h-[2.25rem]">
        {capturing && <Note tone="warn" testid="bind-capturing">Press a key for <b>{label(capturing.action)}</b> (slot {capturing.slot + 1})…</Note>}
        {capturing && notice?.tone === 'error' && <div className="mt-1"><Note tone="error" testid="bind-notice">{notice.text} Press another key, or Esc to cancel.</Note></div>}
        {!capturing && notice && (
          <Note tone={notice.tone} testid="bind-notice">
            {notice.text}
            {notice.undo && <button className={`ml-3 font-display font-bold uppercase tracking-widest text-amber-hi underline ${focusRing}`} onClick={() => { onChange(notice.undo!); setNotice({ tone: 'info', text: 'Undone.' }) }} data-testid="bind-undo">Undo</button>}
          </Note>
        )}
      </div>
      {missing.length > 0 && <div className="mt-2"><Note tone="error" testid="bind-missing">No key for {missing.map((m) => m.label).join(', ')}. Bind one before you deploy: the game can’t be played without it.</Note></div>}
      {dupes.size > 0 && <div className="mt-2"><Note tone="error">Keys used twice: {[...dupes].map(([c, a]) => `${keyLabel(c)} (${a.map(label).join(', ')})`).join('; ')}.</Note></div>}

      <div className="mt-3 grid gap-x-8 lg:grid-cols-2">
        {groups.map((g) => (
          <div key={g} className="mb-4">
            <div className="mb-1 font-display text-[11px] font-bold uppercase tracking-[0.28em] text-steel">{g}</div>
            <table className="w-full border-collapse">
              <caption className="sr-only">{g} keys</caption>
              <thead className="sr-only"><tr><th scope="col">Action</th><th scope="col">Primary key</th><th scope="col">Second key</th></tr></thead>
              <tbody>
                {ACTIONS.filter((a) => a.group === g).map((a) => (
                  <tr key={a.id} className="border-b border-line/60">
                    <th scope="row" className="truncate py-1.5 pr-2 text-left text-sm font-normal text-fog">{a.label}{a.required && <span className="sr-only"> (required)</span>}</th>
                    {([0, 1] as const).map((slot) => {
                      const code = binds[a.id][slot]
                      const on = capturing?.action === a.id && capturing.slot === slot
                      const changed = code !== DEFAULT_BINDS[a.id][slot]
                      return (
                        <td key={slot} className="w-[6.25rem] py-1 pl-2">
                          <button type="button" onClick={() => { setNotice(null); setCapturing(on ? null : { action: a.id, slot }) }}
                            aria-label={`${a.label}, ${slot === 0 ? 'primary' : 'second'} key: ${code ? keyLabel(code) : 'none'}. Press to change.`}
                            aria-pressed={on}
                            className={`w-full border px-2 py-1 font-mono text-xs transition-colors ${focusRing} ${on ? 'animate-pulse border-amber bg-amber/20 text-amber-hi' : code ? `border-line-strong bg-ink-2 ${changed ? 'text-amber-hi' : 'text-fog'} hover:border-amber/70` : 'border-dashed border-line-strong text-dim hover:border-amber/70'}`}
                            data-testid={`bind-${a.id}-${slot}`}>
                            {on ? 'press a key' : code ? keyLabel(code) : '—'}
                          </button>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  )
}

function label(a: Action): string {
  return ACTIONS.find((x) => x.id === a)?.label ?? a
}
