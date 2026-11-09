// Account-level preferences: the portable part of Settings (controls, interface,
// accessibility, audio, subtitles) follows a signed-in player between devices.
// Whichever side changed last wins: this device's last local change against the
// account's `updated_at`. Graphics never syncs. Signed out, nothing leaves the device.
'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { api } from './api'
import { VERSION, loadSettings, portable, saveSettings, withPortable } from './settings'

export type SyncState =
  | { kind: 'local' }                          // signed out: this device only
  | { kind: 'syncing' }
  | { kind: 'synced'; at: number; pulled: boolean }
  | { kind: 'error'; message: string }

let state: SyncState = { kind: 'local' }
const subs = new Set<() => void>()
function set(s: SyncState) { state = s; subs.forEach((f) => f()) }

export function useSyncState(): SyncState {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f) }, () => state, () => state)
}

const localAt = () => { try { return Number(localStorage.getItem('cz_settings_at') ?? 0) || 0 } catch { return 0 } }
const markAt = (t: number) => { try { localStorage.setItem('cz_settings_at', String(t)) } catch { /* private mode */ } }

let applyingRemote = false

/** Pull or push once: the newer side wins. */
export async function syncNow(): Promise<void> {
  set({ kind: 'syncing' })
  try {
    const remote = await api.preferences()
    const remoteAt = remote.updated_at ? Date.parse(remote.updated_at) : 0
    if (remote.prefs && remoteAt > localAt()) {
      applyingRemote = true
      try { saveSettings(withPortable(loadSettings(), remote.prefs), { source: 'account' }) } finally { applyingRemote = false }
      markAt(remoteAt)
      set({ kind: 'synced', at: remoteAt, pulled: true })
      return
    }
    await push()
  } catch (e) {
    set({ kind: 'error', message: (e as Error).message || 'could not reach the server' })
  }
}

async function push(): Promise<void> {
  const r = await api.savePreferences(VERSION, portable(loadSettings()))
  const at = r.updated_at ? Date.parse(r.updated_at) : Date.now()
  markAt(at)
  set({ kind: 'synced', at, pulled: false })
}

/** Keep a signed-in player's preferences in step while the app is open. */
export function usePreferencesSync(account: string | null): void {
  useEffect(() => {
    if (!account) { set({ kind: 'local' }); return }
    void syncNow()
    let timer: ReturnType<typeof setTimeout> | null = null
    let last = JSON.stringify(portable(loadSettings()))
    const onChange = () => {
      if (applyingRemote) return
      const now = JSON.stringify(portable(loadSettings()))
      if (now === last) return // a graphics-only change stays on this device
      last = now
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { push().catch((e) => set({ kind: 'error', message: (e as Error).message })) }, 1500)
    }
    window.addEventListener('cz-settings', onChange)
    return () => { window.removeEventListener('cz-settings', onChange); if (timer) clearTimeout(timer) }
  }, [account])
}
