import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { FactionInsignia } from '../FactionInsignia'
import { ICON_COLOR, ICON_LABEL, ResourceIcon, type IconKind } from '../ResourceIcon'
import { FACTION_COLOR } from '@/lib/factions'

const KINDS: IconKind[] = ['ammo', 'med', 'fuel', 'credits']
const FACTIONS = ['vanguard', 'ashen', 'vex', 'halcyon']

describe('identity marks', () => {
  it('every resource has an icon, a label and an accent', () => {
    for (const k of KINDS) {
      const { container, unmount } = render(<ResourceIcon kind={k} title={ICON_LABEL[k]} />)
      expect(container.querySelector(`[data-icon="${k}"]`)).toBeTruthy()
      expect(container.querySelector('title')?.textContent).toBe(ICON_LABEL[k])
      expect(ICON_COLOR[k]).toMatch(/^var\(--color-/)
      unmount()
    }
  })
  it('an unlabelled icon is hidden from assistive tech; a labelled one is announced', () => {
    expect(render(<ResourceIcon kind="ammo" />).container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')
    expect(render(<ResourceIcon kind="ammo" title="Ammunition" />).container.querySelector('svg')!.getAttribute('role')).toBe('img')
  })
  it('each faction has its own distinct insignia', () => {
    const shapes = FACTIONS.map((f) => render(<FactionInsignia id={f} />).container.querySelector('svg')!.innerHTML)
    expect(new Set(shapes).size).toBe(4)
    for (const f of FACTIONS) expect(FACTION_COLOR[f]).toBeTruthy()
  })
  it('an unknown faction gets a neutral plate, not another faction’s mark', () => {
    const unknown = render(<FactionInsignia id="stranger" />).container.querySelector('svg')!.innerHTML
    for (const f of FACTIONS) expect(unknown).not.toBe(render(<FactionInsignia id={f} />).container.querySelector('svg')!.innerHTML)
  })
})
