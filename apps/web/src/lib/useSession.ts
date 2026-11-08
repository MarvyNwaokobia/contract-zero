'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
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
