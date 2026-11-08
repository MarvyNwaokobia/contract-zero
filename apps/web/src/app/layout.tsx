import type { Metadata } from 'next'
import { Providers } from './providers'
import './globals.css'

export const metadata: Metadata = {
  title: 'CONTRACT ZERO',
  description: 'A tactical extraction shooter with autonomous faction economies, settled on NEAR.',
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#04030c',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
