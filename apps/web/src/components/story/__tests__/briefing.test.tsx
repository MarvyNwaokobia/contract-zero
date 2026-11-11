import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Briefing } from '../Briefing'
import type { MissionStory } from '@/engine/story/presence'

const story: MissionStory = {
  codename: 'OPERATION TEST', location: 'CINDER YARD', time: 'DAY 1', source: 'authored', radio: {},
  briefing: [{ id: 'a', speaker: 'handler', text: 'First line of the briefing.' }, { id: 'b', speaker: 'ashen', text: 'Second line, from the other side.' }],
}
beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('briefing', () => {
  it('types lines one at a time by default, so only the first has begun', () => {
    render(<Briefing story={story} pending={false} onDeploy={() => {}} />)
    expect(screen.queryByText('Second line, from the other side.')).toBeNull()
  })
  it('shows every line at once, with no typing, when reduced motion is on', () => {
    localStorage.setItem('cz_settings', JSON.stringify({ access: { reduceMotion: true } }))
    render(<Briefing story={story} pending={false} onDeploy={() => {}} />)
    expect(screen.getByText('First line of the briefing.')).toBeTruthy()
    expect(screen.getByText('Second line, from the other side.')).toBeTruthy()
  })
  it('gives each speaker a portrait, decorative because the name is beside it', () => {
    localStorage.setItem('cz_settings', JSON.stringify({ access: { reduceMotion: true } }))
    const { container } = render(<Briefing story={story} pending={false} onDeploy={() => {}} />)
    expect(container.querySelectorAll('[data-portrait]').length).toBe(2)
    expect(screen.getByText('KESTREL')).toBeTruthy()
  })
})
