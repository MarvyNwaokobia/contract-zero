import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { BUDGET_MB, FIGHT_SETS, gpuBytes, MAPS_COLOUR, MAPS_FULL } from '../textureBudget'

const root = process.cwd()
/** Width and height from a JPEG's start-of-frame marker. */
function jpegSize(path: string): [number, number] {
  const b = readFileSync(path)
  let i = 2
  while (i < b.length) {
    if (b[i] !== 0xff) { i++; continue }
    const m = b[i + 1]
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]
    i += 2 + b.readUInt16BE(i + 2)
  }
  throw new Error(`no frame header in ${path}`)
}
const file = (s: { dir: string; base: string }, map: string) => resolve(root, `public/textures/${s.dir}/${s.base}_${map}_1k.jpg`)
const mb = (bytes: number) => bytes / 1024 / 1024
const total = (maps: readonly string[]) => FIGHT_SETS.reduce((sum, s) => sum + maps.reduce((a, m) => { const [w, h] = jpegSize(file(s, m)); return a + gpuBytes(w, h) }, 0), 0)

describe('texture memory for a fight', () => {
  it('lists every PBR set the scene and level art load, so the budget cannot drift', () => {
    const src = ['src/engine/scene/ContractZeroScene.tsx', 'src/engine/scene/LevelArt.tsx'].map((p) => readFileSync(resolve(root, p), 'utf8')).join('\n')
    const used = [...src.matchAll(/usePbr\('([a-z0-9_]+)'/g)].map((m) => m[1])
    const listed = new Set(FIGHT_SETS.map((s) => s.base))
    for (const u of used) expect(listed.has(u), `usePbr('${u}') is not in FIGHT_SETS`).toBe(true)
    for (const l of listed) expect(used.includes(l), `${l} is listed but nothing loads it`).toBe(true)
  })
  it('has every file it counts', () => {
    const have = new Set([...readdirSync(resolve(root, 'public/textures/dustline')), ...readdirSync(resolve(root, 'public/textures/hangar'))])
    for (const s of FIGHT_SETS) for (const m of MAPS_FULL) expect(have.has(`${s.base}_${m}_1k.jpg`), `${s.base} ${m}`).toBe(true)
  })
  it('stays inside the full-tier budget', () => {
    expect(mb(total(MAPS_FULL))).toBeLessThanOrEqual(BUDGET_MB.full)
  })
  it('colour-only, for touch and minimal, is a third of that and inside its own budget', () => {
    const full = total(MAPS_FULL), colour = total(MAPS_COLOUR)
    expect(mb(colour)).toBeLessThanOrEqual(BUDGET_MB.colourOnly)
    expect(colour / full).toBeCloseTo(1 / 3, 1)
  })
  it('measures what it says (a 1024x1024 texture is 5.33 MB with mips)', () => {
    expect(mb(gpuBytes(1024, 1024))).toBeCloseTo(5.33, 1)
  })
})
