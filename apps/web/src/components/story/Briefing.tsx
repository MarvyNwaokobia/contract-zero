'use client'

// The insertion briefing: a letterboxed card between choosing a loadout and the
// fight. The operation's codename, where and when, then the cast's lines one at a
// time over radio static. Every line comes from the server's story (facts it can
// vouch for); nothing here is invented on the client.

import { useEffect, useRef, useState } from 'react'
import { SPEAKER_META, type MissionStory, type Speaker } from '@/engine/story/presence'

const CHAR_MS = 22
const GAP_MS = 650

function speaker(id: string) {
  return SPEAKER_META[id as Speaker] ?? { name: id.toUpperCase(), color: '#c9ced6' }
}

export function Briefing({ story, pending, onDeploy }: { story: MissionStory; pending: boolean; onDeploy: () => void }) {
  const lines = story.briefing
  const [shown, setShown] = useState(0) // lines fully shown
  const [chars, setChars] = useState(0) // characters of the current line
  const done = shown >= lines.length
  const deployRef = useRef(onDeploy)
  deployRef.current = onDeploy

  // Type the current line, then pause, then the next.
  useEffect(() => {
    if (pending || done) return
    const text = lines[shown].text
    if (chars < text.length) {
      const t = window.setTimeout(() => setChars((c) => Math.min(text.length, c + 2)), CHAR_MS * 2)
      return () => window.clearTimeout(t)
    }
    const t = window.setTimeout(() => { setShown((s) => s + 1); setChars(0) }, GAP_MS)
    return () => window.clearTimeout(t)
  }, [pending, done, shown, chars, lines])

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
      <div className="relative flex flex-1 flex-col justify-center overflow-hidden px-6 sm:px-16">
        <div className="pointer-events-none absolute inset-0 opacity-[0.07]" style={{ backgroundImage: 'repeating-linear-gradient(0deg, #fff 0 1px, transparent 1px 3px)' }} />
        <div className="relative mx-auto w-full max-w-3xl">
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
                <div key={l.id} className="grid gap-1 sm:grid-cols-[11rem_1fr] sm:gap-4">
                  <span className="font-display text-sm font-bold uppercase tracking-[0.2em]" style={{ color: s.color }}>{s.name}</span>
                  <p className="text-lg leading-relaxed text-slate-200">{text}{i === shown && <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-fog/70 align-middle" />}</p>
                </div>
              )
            })}
          </div>
          <div className="mt-10 flex flex-wrap items-center gap-4">
            <button className="cz-btn cz-btn-primary px-8 py-3 text-base" onClick={onDeploy} disabled={pending} autoFocus>Deploy</button>
            {!done && !pending && <button className="cz-label hover:text-fog" onClick={() => setShown(lines.length)}>Skip ▸</button>}
            <span className="text-xs text-dim">Enter to deploy · Space to skip</span>
          </div>
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
          <div key={l.id} className="grid gap-1 sm:grid-cols-[10rem_1fr] sm:gap-3">
            <span className="font-display text-xs font-bold uppercase tracking-[0.2em]" style={{ color: s.color }}>{s.name}</span>
            <p className="text-sm text-slate-200">{l.text}</p>
          </div>
        )
      })}
    </div>
  )
}
