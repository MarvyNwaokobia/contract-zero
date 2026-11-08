import type { Metadata } from 'next'
import { Barlow, Rajdhani } from 'next/font/google'
import { Providers } from './providers'
import './globals.css'

const display = Rajdhani({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-rajdhani', display: 'swap' })
const body = Barlow({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-barlow', display: 'swap' })

export const metadata: Metadata = {
  title: 'CONTRACT ZERO',
  description: 'A tactical extraction shooter in a war economy run by rival AI factions.',
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0a0b0d',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
