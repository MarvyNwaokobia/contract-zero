'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { auth, type Session } from '@/lib/auth'

/** The signed-in player (null when signed out). */
export function useSession() {
  const qc = useQueryClient()
  const q = useQuery<Session | null>({ queryKey: ['session'], queryFn: auth.session, staleTime: 60_000, retry: 1 })
  return {
    session: q.data ?? null,
    loading: q.isLoading,
    refresh: () => qc.invalidateQueries({ queryKey: ['session'] }),
    signOut: async () => {
      await auth.logout().catch(() => {})
      await qc.invalidateQueries()
    },
  }
}

/** How a signed-in player is shown, without chain jargon. */
export function displayName(s: Session, label?: string | null): string {
  if (label) return label
  if (s.provider === 'google') return 'Google account'
  if (s.provider === 'apple') return 'Apple account'
  if (s.provider === 'email') return 'Email account'
  return s.account
}

/** The signed-in operator's profile (callsign), once they have one. */
export function useProfile() {
  const { session } = useSession()
  const q = useQuery({ queryKey: ['profile', session?.account], queryFn: api.profile, enabled: !!session, staleTime: 60_000 })
  return { profile: q.data ?? null, loading: !!session && q.isLoading, refetch: q.refetch }
}

/** The operator's credits and supplies (on-chain holdings when settlement is on). */
export function useStash() {
  const { session } = useSession()
  const q = useQuery({ queryKey: ['exchange', session?.account], queryFn: () => api.exchange(session!.account), enabled: !!session, refetchInterval: 15_000 })
  const x = q.data
  return x ? (x.settlement === 'near' ? x.chain_holdings : x.engine_holdings) : null
}
