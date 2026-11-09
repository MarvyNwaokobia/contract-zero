import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'

// Development benches (/dev/*) exist in development builds only, or when a build
// opts in with NEXT_PUBLIC_CZ_DEV_HOOKS=1. None of them talk to the economy.
export default function DevLayout({ children }: { children: ReactNode }) {
  if (process.env.NODE_ENV === 'production' && process.env.NEXT_PUBLIC_CZ_DEV_HOOKS !== '1') notFound()
  return children
}
