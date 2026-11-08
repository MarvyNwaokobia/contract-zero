import type { NextConfig } from 'next'
import path from 'path'

const nextConfig: NextConfig = {
  // Pin the workspace root: a stray lockfile higher up the filesystem otherwise
  // makes Next guess the wrong root for file tracing.
  outputFileTracingRoot: path.join(__dirname, '../..'),
  env: {
    NEXT_PUBLIC_BUILD_SHA: (process.env.VERCEL_GIT_COMMIT_SHA ?? 'local').slice(0, 7),
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
}

export default nextConfig
