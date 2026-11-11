'use client'

// The Advanced view: off by default, remembered per browser, never required. It reveals the
// plumbing (contract, tokens, transaction ids, the engine's validation record) next to the
// plain-language account, which is always shown first.

import { useCallback, useEffect, useState } from 'react'

const KEY = 'cz_advanced'

export function useAdvanced(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(false)
  useEffect(() => {
    try { setOn(localStorage.getItem(KEY) === '1') } catch { /* private mode */ }
    const sync = (e: StorageEvent) => { if (e.key === KEY) setOn(e.newValue === '1') }
    const local = () => { try { setOn(localStorage.getItem(KEY) === '1') } catch { /* */ } }
    window.addEventListener('storage', sync)
    window.addEventListener('cz-advanced', local)
    return () => { window.removeEventListener('storage', sync); window.removeEventListener('cz-advanced', local) }
  }, [])
  const set = useCallback((v: boolean) => {
    try { localStorage.setItem(KEY, v ? '1' : '0') } catch { /* private mode */ }
    setOn(v)
    window.dispatchEvent(new Event('cz-advanced'))
  }, [])
  return [on, set]
}
