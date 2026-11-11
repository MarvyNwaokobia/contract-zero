'use client'

// Whether the page is on screen. A tab in the background has no business rendering a 3D scene
// (browsers already stop animation frames there, but timers, audio and the scene's own clock do
// not all follow), so scenes use this to stop their frame loop and resume cleanly.

import { useEffect, useState } from 'react'

export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const apply = () => setVisible(!document.hidden)
    apply()
    document.addEventListener('visibilitychange', apply)
    return () => document.removeEventListener('visibilitychange', apply)
  }, [])
  return visible
}
