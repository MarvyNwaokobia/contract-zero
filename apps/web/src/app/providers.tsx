'use client'

import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ErrorBoundary from '@/components/ui/ErrorBoundary'
import { useSession } from '@/lib/useSession'
import { usePreferencesSync } from '@/lib/preferencesSync'

/** Signed in, the portable settings follow the account between devices. */
function PreferencesSync() {
  const { session } = useSession()
  usePreferencesSync(session?.account ?? null)
  return null
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 2 } } }),
  )

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}><PreferencesSync />{children}</QueryClientProvider>
    </ErrorBoundary>
  )
}
