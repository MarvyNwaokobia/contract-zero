import { describe, it, expect } from 'vitest'
import { AutoQuality, readAutoLevel, writeAutoLevel, WARMUP_SECONDS, SLOW_SECONDS } from '../autoQuality'

const run = (q: AutoQuality, fps: number, seconds: number) => {
  const out: (number | null)[] = []
  for (let i = 0; i < fps * seconds; i++) { const r = q.frame(1 / fps); if (r !== null) out.push(r) }
  return out
}

describe('auto quality', () => {
  it('ignores the warm-up, then steps down one tier after sustained slow frames', () => {
    const q = new AutoQuality()
    expect(run(q, 20, WARMUP_SECONDS)).toEqual([]) // a slow load is not judged
    expect(run(q, 30, SLOW_SECONDS + 0.5)).toEqual([1]) // high → medium
    expect(run(q, 30, WARMUP_SECONDS + SLOW_SECONDS + 0.5)).toEqual([2]) // medium → low
    expect(run(q, 10, 20)).toEqual([]) // nothing below low
  })
  it('a fast machine stays put, and a single slow second does not step', () => {
    const q = new AutoQuality()
    run(q, 60, WARMUP_SECONDS)
    expect(run(q, 60, 10)).toEqual([])
    run(q, 30, 1.2)
    expect(run(q, 60, 5)).toEqual([])
    expect(q.level).toBe(0)
  })
  it('persists the step and reads the legacy flag', () => {
    expect(readAutoLevel('1')).toBe(2)
    expect(readAutoLevel(writeAutoLevel(1))).toBe(1)
    expect(readAutoLevel(null)).toBe(0)
  })
})
