'use client'

import { useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ErrorBoundary from '@/components/ui/ErrorBoundary'
import { useSession } from '@/lib/useSession'
import { usePreferencesSync } from '@/lib/preferencesSync'
import { useSettings } from '@/lib/settings'
import { AudioProvider } from '@/components/audio/AudioProvider'

/** Signed in, the portable settings follow the account between devices. */
function PreferencesSync() {
  const { session } = useSession()
  usePreferencesSync(session?.account ?? null)
  return null
}

/** Settings → Reduce motion zeroes the interface's motion tokens (globals.css), like the OS setting does. */
function MotionSync() {
  const reduce = useSettings().access.reduceMotion
  useEffect(() => {
    document.documentElement.dataset.reduceMotion = reduce ? 'true' : 'false'
  }, [reduce])
  return null
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 2 } } }),
  )

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}><PreferencesSync /><MotionSync /><AudioProvider>{children}</AudioProvider></QueryClientProvider>
    </ErrorBoundary>
  )
}
