'use client'

// The insertion briefing: a letterboxed card between accepting a contract and
// choosing a loadout. The operation's codename, where and when, then the cast's lines one at a
// time over radio static. Every line comes from the server's story (facts it can
// vouch for); nothing here is invented on the client.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Portrait } from '@/components/ui/Portrait'
import { FactionInsignia } from '@/components/ui/FactionInsignia'
import { factionColor, IDENTITY } from '@/lib/factions'
import { useSettings } from '@/lib/settings'
import { buildOperationMission, type ConvoyContract, type OpKind } from '@/engine/fps/convoy'
import { worldClock } from '@/engine/fps/lineProps'
import { HowToPlayButton } from '@/components/help/HowToPlay'
import { SPEAKER_META, type MissionStory, type Speaker } from '@/engine/story/presence'

const CHAR_MS = 22
const GAP_MS = 650

function speaker(id: string) {
  return SPEAKER_META[id as Speaker] ?? { name: id.toUpperCase(), color: '#c9ced6' }
}

/** The operation at a glance, beside the briefing: who holds it, where, the guards, what it pays, what the site is doing. From the accepted contract itself. */
function Facts({ contract, kind, pay }: { contract: ConvoyContract; kind: OpKind; pay?: number }) {
  const mission = useMemo(() => buildOperationMission({ ...contract, kind }), [contract, kind])
  const t = contract.target.toLowerCase()
  const holder = IDENTITY[t] ?? Object.values(IDENTITY).find((i) => t.includes(i.id) || t.includes(i.name.toLowerCase()))
  const rifles = mission.enemies.filter((e) => !e.dmgMult).length
  const down = contract.cues?.lines_down ?? []
  return (
    <aside className="self-start border border-line bg-black/50 p-4 text-sm" aria-label="Operation at a glance" data-testid="briefing-facts">
      <div className="flex items-center gap-3">
        {holder && <span style={{ color: factionColor(holder.id) }}><FactionInsignia id={holder.id} className="h-10 w-10" title="" /></span>}
        <div><div className="cz-label !text-[10px]">Held by</div><div className="font-display font-bold uppercase tracking-wider" style={{ color: holder ? factionColor(holder.id) : undefined }}>{holder?.name ?? contract.target}</div></div>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3">
        <div><dt className="cz-label !text-[10px]">Guards</dt><dd className="cz-num font-display text-lg font-bold">{mission.enemies.length}</dd><dd className="text-[11px] text-muted">{rifles} rifle · {mission.enemies.length - rifles} sidearm</dd></div>
        <div><dt className="cz-label !text-[10px]">Cargo</dt><dd className="cz-num font-display text-lg font-bold">{kind === 'sabotage' ? '—' : contract.cargo.units}</dd><dd className="text-[11px] text-muted">{kind === 'sabotage' ? 'none to take' : contract.cargo.resource}</dd></div>
        <div><dt className="cz-label !text-[10px]">Pays</dt><dd className="cz-num font-display text-lg font-bold text-amber-hi">{pay ? `${pay} cr` : '—'}</dd></div>
      </dl>
      <ol className="mt-3 grid gap-0.5 border-t border-line pt-3 text-xs text-muted" aria-label="Objectives">
        {mission.objectives.map((o, i) => <li key={i} className="flex gap-2"><span className="w-4 text-right font-display font-bold text-amber">{i + 1}</span><span>{o.text}</span></li>)}
      </ol>
      {(down.length > 0 || (contract.cues?.deliveries.length ?? 0) > 0) && (
        <ul className="mt-3 grid gap-0.5 border-t border-line pt-3 text-xs" data-testid="briefing-site-status">
          {down.map((l) => <li key={l.line} className="text-hostile">The {l.line} is down until {worldClock(l.until)}.</li>)}
          {(contract.cues?.deliveries.length ?? 0) > 0 && <li className="text-steel">A shipment is {contract.cues!.deliveries[0].state === 'arrived' ? 'just in' : 'landing'} in the yard.</li>}
        </ul>
      )}
    </aside>
  )
}

export function Briefing({ story, pending, onDeploy, actionLabel = 'Deploy', contract, kind = 'raid', pay }: { story: MissionStory; pending: boolean; onDeploy: () => void; actionLabel?: string; contract?: ConvoyContract; kind?: OpKind; pay?: number }) {
  const lines = story.briefing
  const reduce = useSettings().access.reduceMotion
  const [typed, setShown] = useState(0) // lines fully typed
  const shown = reduce ? lines.length : typed // reduced motion: every line at once, no typing
  const [chars, setChars] = useState(0) // characters of the current line
  const done = shown >= lines.length
  const deployRef = useRef(onDeploy)
  deployRef.current = onDeploy

  // Type the current line, then pause, then the next.
  useEffect(() => {
    if (pending || done || reduce) return
    const text = lines[shown].text
    if (chars < text.length) {
      const t = window.setTimeout(() => setChars((c) => Math.min(text.length, c + 2)), CHAR_MS * 2)
      return () => window.clearTimeout(t)
    }
    const t = window.setTimeout(() => { setShown((s) => s + 1); setChars(0) }, GAP_MS)
    return () => window.clearTimeout(t)
  }, [pending, done, reduce, shown, chars, lines])

  // Enter deploys; Space/Escape skip to the full briefing first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (pending) return
      if (e.key === 'Enter') deployRef.current()
      else if (e.key === ' ' || e.key === 'Escape') { e.preventDefault(); setShown(lines.length) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending, lines.length])

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#050607] text-fog" data-testid="briefing">
      <div className="h-[9vh] shrink-0 bg-black" />
      <div className="relative flex flex-1 flex-col overflow-y-auto px-6 py-4 sm:px-16">
        <div className="pointer-events-none absolute inset-0 opacity-[0.07]" style={{ backgroundImage: 'repeating-linear-gradient(0deg, #fff 0 1px, transparent 1px 3px)' }} />
        <div className={`relative mx-auto my-auto grid w-full gap-8 ${contract ? 'max-w-6xl lg:grid-cols-[1fr_20rem]' : 'max-w-3xl'}`}>
          <div>
          <div className="cz-label mb-2 !text-[11px] text-amber">Contract briefing{story.source.startsWith('llm:') ? ' · voiced' : ''}</div>
          <h1 className="font-display text-4xl font-bold uppercase tracking-[0.14em] text-fog sm:text-5xl">{story.codename}</h1>
          <div className="mt-2 flex flex-wrap gap-x-6 text-sm uppercase tracking-widest text-muted">
            <span>{story.location}</span>
            <span>{story.time}</span>
          </div>
          <div className="mt-8 grid min-h-[16rem] content-start gap-5" aria-live="polite">
            {pending && <div className="animate-pulse text-sm uppercase tracking-[0.3em] text-dim">Decrypting channel…</div>}
            {!pending && lines.slice(0, Math.min(lines.length, shown + 1)).map((l, i) => {
              const s = speaker(l.speaker)
              const text = i < shown ? l.text : l.text.slice(0, chars)
              return (
                <div key={l.id} className="grid gap-1 sm:grid-cols-[3.5rem_8rem_1fr] sm:items-start sm:gap-4">
                  <span className="hidden sm:block" style={{ color: s.color }}><Portrait id={l.speaker} size={56} title="" /></span>
                  <span className="font-display text-sm font-bold uppercase tracking-[0.2em]" style={{ color: s.color }}>{s.name}</span>
                  <p className="text-lg leading-relaxed text-slate-200">{text}{i === shown && <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-fog/70 align-middle" />}</p>
                </div>
              )
            })}
          </div>
          <div className="mt-10 flex flex-wrap items-center gap-4">
            <button className="cz-btn cz-btn-primary px-8 py-3 text-base" onClick={onDeploy} disabled={pending} autoFocus>{actionLabel}</button>
            <HowToPlayButton label="Controls" initial="desktop" className="cz-btn cz-btn-ghost ml-3 px-5 py-3 text-sm" />
            {!done && !pending && <button className="cz-label hover:text-fog" onClick={() => setShown(lines.length)}>Skip ▸</button>}
            <span className="text-xs text-dim">Enter to continue · Space to skip</span>
          </div>
          </div>
          {contract && <Facts contract={contract} kind={kind} pay={pay} />}
        </div>
      </div>
      <div className="h-[9vh] shrink-0 bg-black" />
    </div>
  )
}

/** The debrief: the same cast, after the fact. */
export function Debrief({ lines }: { lines: { id: string; speaker: string; text: string }[] }) {
  return (
    <div className="grid gap-3" data-testid="debrief">
      {lines.map((l) => {
        const s = speaker(l.speaker)
        return (
          <div key={l.id} className="grid grid-cols-[2.5rem_1fr] gap-x-3 gap-y-0.5">
            <span className="row-span-2" style={{ color: s.color }}><Portrait id={l.speaker} size={40} title="" /></span>
            <span className="font-display text-xs font-bold uppercase tracking-[0.2em]" style={{ color: s.color }}>{s.name}</span>
            <p className="text-sm text-fog">{l.text}</p>
          </div>
        )
      })}
    </div>
  )
}
