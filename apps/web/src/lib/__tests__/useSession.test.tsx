import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const session = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: { session: () => session(), logout: vi.fn() }, loadSessionKey: vi.fn(), disableQuickTrade: vi.fn() }))
const { useSession } = await import('../useSession')

const wrap = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } })}>{children}</QueryClientProvider>
afterEach(() => { cleanup(); session.mockReset() })

describe('useSession', () => {
  it('a definite "not signed in" (the server says 401) is no session and not a failure', async () => {
    session.mockResolvedValue(null)
    const { result } = renderHook(() => useSession(), { wrapper: wrap })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.session).toBeNull()
    expect(result.current.failed).toBe(false)
  })
  it('a failed check is a failure, not a sign-out', async () => {
    session.mockRejectedValue(new Error('network down'))
    const { result } = renderHook(() => useSession(), { wrapper: wrap })
    await waitFor(() => expect(result.current.failed).toBe(true))
    expect(result.current.session).toBeNull()
  })
  it('a signed-in player is a session', async () => {
    session.mockResolvedValue({ account: 'a.testnet', method: 'dev', provider: 'dev', subject: null, public_key: null, expires_at: 'x' })
    const { result } = renderHook(() => useSession(), { wrapper: wrap })
    await waitFor(() => expect(result.current.session?.account).toBe('a.testnet'))
    expect(result.current.failed).toBe(false)
  })
})
