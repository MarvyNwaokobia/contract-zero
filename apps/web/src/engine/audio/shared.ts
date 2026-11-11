// One audio engine for the whole app. The fight, the Hub, the War Table and Settings all use
// the same instance, so there is one AudioContext and one score however you move between
// screens, and a click on one screen unlocks sound for all of them. It is reference counted:
// the app holds a reference for its lifetime, and each screen that wants it takes and gives
// back its own.

import { FpsAudio } from './FpsAudio'

let instance: FpsAudio | null = null
let refs = 0

export function acquireAudio(): FpsAudio {
  if (!instance) instance = new FpsAudio()
  refs++
  return instance
}

export function releaseAudio(): void {
  refs = Math.max(0, refs - 1)
  if (refs === 0 && instance) {
    const dying = instance
    instance = null
    dying.dispose()
  }
}

/** Without taking a reference (probes, devtools). */
export const peekAudio = (): FpsAudio | null => instance
export const audioRefs = () => refs
