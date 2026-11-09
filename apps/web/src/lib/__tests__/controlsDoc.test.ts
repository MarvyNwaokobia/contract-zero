import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { controlsMarkdown } from '../controlsDoc'
import { desktopControls, TOUCH_CONTROLS } from '../controls'
import { ACTIONS } from '../keybinds'

describe('the controls documentation', () => {
  it('matches the game (regenerate with `npx tsx scripts/export-controls.ts`)', () => {
    const doc = readFileSync(join(__dirname, '../../../../../docs/CONTROLS.md'), 'utf8')
    expect(doc).toBe(controlsMarkdown())
  })
  it('lists every bindable action and the touch layout', () => {
    const rows = desktopControls().flatMap((g) => g.rows.map((r) => r.action))
    for (const a of ACTIONS) expect(rows).toContain(a.label)
    expect(TOUCH_CONTROLS.map((t) => t.keys)).toEqual(expect.arrayContaining(['ADS', 'CROUCH', 'USE (hold)', 'MED']))
    // The interact key is E and lean right is G (the old docs said Q / E lean).
    const flat = desktopControls().flatMap((g) => g.rows)
    expect(flat.find((r) => r.action === 'Use / interact')?.keys).toBe('E')
    expect(flat.find((r) => r.action === 'Lean right')?.keys).toBe('G')
  })
})
