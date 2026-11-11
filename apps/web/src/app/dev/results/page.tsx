'use client'

// Bench for the Extraction Results screen. The data is a real extracted raid captured from
// the API (fixture.json); "killed" and "rejected" are that same record with the outcome
// changed, for checking layout only. It never reaches the economy except the read-only
// aftermath poll the real screen also makes.

import { useState } from 'react'
import { MissionResults } from '@/components/world/MissionResults'
import type { MissionResult, WorldView } from '@/lib/api'
import fixture from './fixture.json'

type Variant = 'extracted' | 'killed' | 'rejected'

export default function ResultsBench() {
  const [v, setV] = useState<Variant>('extracted')
  const base = fixture.result as unknown as MissionResult
  const result: MissionResult = v === 'extracted' ? base
    : v === 'killed' ? { ...base, outcome: 'killed', extracted_units: 0, bounty: 0, settlement: null, debrief: [], consequence: null }
    : { ...base, outcome: 'rejected', reason: 'the run was faster than the minimum', extracted_units: 0, bounty: 0, settlement: null, consequence: null }
  return (
    <div>
      <div className="flex gap-2 border-b border-line bg-ink-2 p-2 text-xs" role="group" aria-label="Variant">
        {(['extracted', 'killed', 'rejected'] as Variant[]).map((x) => <button key={x} aria-pressed={v === x} onClick={() => setV(x)} data-testid={`variant-${x}`} className={`border px-3 py-1 ${v === x ? 'border-amber text-amber-hi' : 'border-line text-muted'}`}>{x}</button>)}
        <span className="ml-2 self-center text-dim">Bench: a real extracted raid; the other two only change the outcome.</span>
      </div>
      <MissionResults result={result} before={fixture.before as unknown as WorldView} after={fixture.after as unknown as WorldView} session={fixture.session} />
    </div>
  )
}
