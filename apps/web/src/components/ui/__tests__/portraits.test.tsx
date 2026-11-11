import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Portrait } from '../Portrait'
import { PERSONAS } from '@/lib/personas'
import { IDENTITY, FACTION_COLOR } from '@/lib/factions'

const IDS = Object.keys(PERSONAS)
const personasDoc = readFileSync(resolve(process.cwd(), '../../docs/contract-zero/PERSONAS.md'), 'utf8').toLowerCase()
const brief = readFileSync(resolve(process.cwd(), '../../docs/contract-zero/LIVING_WORLD.md'), 'utf8')

describe('portraits', () => {
  it('every voice has its own portrait, and each reads differently', () => {
    const html = IDS.map((id) => render(<Portrait id={id} />).container.querySelector('svg')!.innerHTML)
    expect(new Set(html).size).toBe(IDS.length)
  })
  it('a labelled portrait is announced by name and title; an unlabelled one is decoration', () => {
    const lab = render(<Portrait id="vanguard" title="Ilse Brandt, Quartermaster" />).container.querySelector('svg')!
    expect(lab.getAttribute('role')).toBe('img')
    expect(lab.getAttribute('aria-label')).toBe('Ilse Brandt, Quartermaster')
    expect(render(<Portrait id="vanguard" title="" />).container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')
  })
  it('the persona’s own name and title are the default label', () => {
    expect(render(<Portrait id="ashen" />).container.querySelector('svg')!.getAttribute('aria-label')).toBe('Tavi Roake, Foreman of the Yard')
  })
  it('draws no faces: nothing here decides what a person looks like', () => {
    for (const id of IDS) { const s = render(<Portrait id={id} />).container.querySelector('svg')!.innerHTML; expect(s, id).not.toMatch(/<circle[^>]*r="[12]"[^>]*cx="(4[0-9]|5[0-9])"[^>]*cy="4[0-9]"/) }
  })
})

describe('faction identity', () => {
  it('every power has an identity, a colour and a palette whose first swatch is its accent', () => {
    for (const id of ['vanguard', 'ashen', 'vex', 'halcyon']) {
      expect(IDENTITY[id], id).toBeTruthy()
      expect(FACTION_COLOR[id], id).toBeTruthy()
      expect(IDENTITY[id].palette.length).toBeGreaterThanOrEqual(3)
    }
  })
  it('its materials, equipment and voice restate the documented direction', () => {
    for (const i of Object.values(IDENTITY)) {
      expect(brief, `${i.id} materials`).toContain(i.materials)
      expect(brief, `${i.id} equipment`).toContain(i.equipment)
      expect(personasDoc, `${i.id} voice`).toContain(i.voice.split('.')[0].toLowerCase())
    }
  })
})
