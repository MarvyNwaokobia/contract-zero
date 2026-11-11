import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FACTION_COLOR } from '../factions'
import { attribution, PERSONAS, personaFor } from '../personas'
import { SPEAKER_META } from '@/engine/story/presence'

// The doc is the source of truth for names; the data must not drift from it.
const doc = readFileSync(resolve(process.cwd(), '../../docs/contract-zero/PERSONAS.md'), 'utf8')

describe('personas', () => {
  it('every power on the map has a persona', () => {
    for (const id of Object.keys(FACTION_COLOR)) expect(PERSONAS[id], id).toBeTruthy()
  })
  it('names, titles, voices and call signs match the documented cast', () => {
    for (const p of Object.values(PERSONAS)) {
      expect(doc, `${p.id} voice`).toContain(`**${p.voice}**`)
      expect(doc, `${p.id} name`).toContain(p.name)
      expect(doc, `${p.id} title`).toContain(p.title)
      expect(doc, `${p.id} call sign`).toContain(p.callSign)
    }
  })
  it('call signs and voices are unique', () => {
    const ps = Object.values(PERSONAS)
    expect(new Set(ps.map((p) => p.callSign)).size).toBe(ps.length)
    expect(new Set(ps.map((p) => p.voice)).size).toBe(ps.length)
  })
  it('each persona has real direction to write from', () => {
    for (const p of Object.values(PERSONAS)) {
      expect(p.say.length).toBeGreaterThan(0)
      expect(p.avoid.length).toBeGreaterThan(0)
      expect(p.cadence.length).toBeGreaterThan(10)
    }
  })
  it('onRadio is true exactly for the voices the radio really has', () => {
    for (const p of Object.values(PERSONAS)) expect(!!SPEAKER_META[p.id as keyof typeof SPEAKER_META], p.id).toBe(p.onRadio)
  })
  it('names are attribution only: none of the new names are in the radio defaults', () => {
    const presence = readFileSync(resolve(process.cwd(), 'src/engine/story/presence.ts'), 'utf8')
    for (const name of ['Brandt', 'Roake', 'Halloran']) expect(presence).not.toContain(name)
  })
  it('attribution is "Name, Title"', () => {
    expect(attribution(PERSONAS.vanguard)).toBe('Ilse Brandt, Quartermaster')
    expect(attribution(PERSONAS.vex)).toBe('Vex, Proprietor')
    expect(attribution(PERSONAS.handler)).toBe('Kestrel, Handler')
    expect(personaFor('nobody')).toBeUndefined()
  })
})
