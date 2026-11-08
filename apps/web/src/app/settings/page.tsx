'use client'

import { useEffect, useState } from 'react'
import { Panel, Shell } from '@/components/ui/Shell'
import { defaultQuality, loadSettings, saveSettings, type Quality } from '@/lib/settings'

const PRESETS: { id: Quality; label: string; note: string }[] = [
  { id: 'low', label: 'Low', note: 'Integrated graphics and older laptops. Lower resolution, fewer lights and particles.' },
  { id: 'medium', label: 'Medium', note: 'Most desktops and recent laptops.' },
  { id: 'high', label: 'High', note: 'Dedicated graphics. Full resolution, shadows, dense atmosphere.' },
]

export default function Settings() {
  const [quality, setQuality] = useState<Quality | null>(null)
  const [saved, setSaved] = useState(false)
  useEffect(() => { setQuality(loadSettings().quality) }, [])
  function pick(q: Quality) {
    setQuality(q)
    saveSettings({ ...loadSettings(), quality: q })
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }
  return (
    <Shell title="Settings" back={{ href: '/', label: 'Hub' }}>
      <Panel title="Graphics">
        <div className="grid gap-3 sm:grid-cols-3">
          {PRESETS.map((p) => (
            <button key={p.id} onClick={() => pick(p.id)} className={`cz-panel p-4 text-left ${quality === p.id ? 'outline outline-1 outline-amber' : 'opacity-80 hover:opacity-100'}`}>
              <div className="font-display text-lg font-bold uppercase tracking-wider">{p.label}{p.id === defaultQuality() ? <span className="ml-2 text-xs text-muted">recommended</span> : null}</div>
              <div className="mt-1 text-xs text-muted">{p.note}</div>
            </button>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted">{saved ? 'Saved. It applies the next time a scene loads.' : 'Applies to the hub now; combat scenes follow in a later milestone.'}</p>
      </Panel>
    </Shell>
  )
}
