import '@testing-library/jest-dom'
import { afterAll, beforeAll, vi } from 'vitest'

// Mock Next.js router
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))

// Mock Three.js canvas (no WebGL in test env)
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children: React.ReactNode }) => children,
  useFrame: vi.fn(),
  useThree: () => ({ camera: {}, gl: {}, scene: {} }),
}))

vi.mock('@react-three/drei', () => ({
  useGLTF: () => ({ scene: { clone: () => ({}) }, animations: [] }),
  useAnimations: () => ({ actions: {}, mixer: null }),
  Environment: () => null,
  OrbitControls: () => null,
}))

// Suppress console.error for known noise
const originalError = console.error
beforeAll(() => {
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('Not implemented')) return
    originalError(...args)
  }
})
afterAll(() => { console.error = originalError })
