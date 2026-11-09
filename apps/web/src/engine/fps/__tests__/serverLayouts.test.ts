import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { serverLayouts } from '../serverLayouts'

describe('the server checks events against the same map the client plays', () => {
  it('layouts.json matches levels.ts (run `npx tsx scripts/export-layouts.ts` after editing levels)', () => {
    const onDisk = JSON.parse(readFileSync(resolve(process.cwd(), '../api/src/services/layouts.json'), 'utf8'))
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(serverLayouts())))
  })
})
