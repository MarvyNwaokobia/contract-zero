import { describe, it, expect } from 'vitest'
import { classifyMoveDir } from '@/engine/animation'

// Directional locomotion: velocity projected on the fighter's facing picks the
// clip (walk forward / backpedal / strafe L / strafe R). The soft-lock camera
// keeps the fighter facing the enemy, so these axes are what the player sees.

describe('classifyMoveDir', () => {
  it('maps the four cardinal travel directions', () => {
    expect(classifyMoveDir(2, 0, 'forward')).toBe('forward')
    expect(classifyMoveDir(-2, 0, 'forward')).toBe('back')
    expect(classifyMoveDir(0, 2, 'forward')).toBe('right')
    expect(classifyMoveDir(0, -2, 'forward')).toBe('left')
  })

  it('gives the held axis 15% stickiness so diagonals do not flicker', () => {
    // Slightly side-dominant while walking forward → forward sticks.
    expect(classifyMoveDir(1, 1.1, 'forward')).toBe('forward')
    // Clearly side-dominant → switches to the strafe.
    expect(classifyMoveDir(1, 1.3, 'forward')).toBe('right')
    // Mirror: slightly forward-dominant while strafing → strafe sticks.
    expect(classifyMoveDir(1.1, 1, 'right')).toBe('right')
    expect(classifyMoveDir(1.3, 1, 'right')).toBe('forward')
  })
})
