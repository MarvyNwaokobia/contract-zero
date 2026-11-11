'use client'

// The strategic radio: what the factions and merchants are doing, said in their voices as
// it happens, with subtitles. Lines come from real records (engine/story/strategicRadio.ts),
// never for history, spaced out and few. Mount it on the screens where that world is on show.
// It is announced politely to screen readers, and honours the player's subtitle settings.

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { peekAudio } from '@/engine/audio/shared'
import { SPEAKER_META } from '@/engine/story/presence'
import { radioFromDecisions, radioFromProcurement, strategicQueue, type RadioEvent } from '@/engine/story/strategicRadio'
import { useSettings } from '@/lib/settings'

const SIZE = { s: 'text-[13px]', m: 'text-base', l: 'text-xl' } as const

export function RadioFeed() {
  const settings = useSettings()
  const decisions = useQuery({ queryKey: ['radio-decisions'], queryFn: () => api.decisions(60), refetchInterval: 15_000 })
  const procurement = useQuery({ queryKey: ['radio-procurement'], queryFn: () => api.procurement(15), refetchInterval: 15_000 })
  const [line, setLine] = useState<RadioEvent | null>(null)

  useEffect(() => { if (decisions.data) strategicQueue.ingest('decisions', radioFromDecisions(decisions.data)) }, [decisions.data])
  useEffect(() => { if (procurement.data) strategicQueue.ingest('orders', radioFromProcurement(procurement.data)) }, [procurement.data])

  useEffect(() => {
    let hide: ReturnType<typeof setTimeout> | undefined
    const tick = setInterval(() => {
      const audio = peekAudio()
      // Wait for a gesture: before one the browser would refuse the sound, and a line should not pass unheard.
      if (!audio?.isUnlocked()) return
      const e = strategicQueue.next(Date.now())
      if (!e) return
      audio.vo(`dyn-strategic-${e.key}`, e.speaker)
      setLine(e)
      if (hide) clearTimeout(hide)
      hide = setTimeout(() => setLine((cur) => (cur?.key === e.key ? null : cur)), 4500 + e.text.length * 55)
    }, 1000)
    return () => { clearInterval(tick); if (hide) clearTimeout(hide) }
  }, [])

  const sub = settings.subtitles
  const meta = line ? SPEAKER_META[line.speaker] : null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex justify-center px-4" data-testid="radio-feed" role="status" aria-live="polite" aria-atomic="true">
      {line && sub.on && meta && (
        <div className={`max-w-xl text-center ${SIZE[sub.size]}`} style={{ background: `rgba(0,0,0,${sub.background})`, padding: sub.background > 0 ? '8px 14px' : 0 }} data-testid="radio-line" title={line.evidence}>
          <div className="font-display text-[11px] font-bold uppercase tracking-[0.22em]" style={{ color: sub.speakerColors ? meta.color : '#e9edf2' }}>{meta.name}</div>
          <div className="text-fog">{line.text}</div>
        </div>
      )}
      {/* subtitles off: the line is still available to screen readers, never shown */}
      {line && !sub.on && <span className="sr-only">{meta?.name}: {line.text}</span>}
    </div>
  )
}
