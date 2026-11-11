import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Every sound the game ships must be accounted for in CREDITS.md. All audio today is original:
// four generated samples plus runtime synthesis. This fails the day an undeclared recording,
// an outside URL or a voice file slips in.

const WEB = process.cwd()
const PUBLIC = join(WEB, 'public')
const AUDIO = /\.(mp3|wav|ogg|m4a|flac|aac|opus|webm)$/i
const credits = readFileSync(join(WEB, 'CREDITS.md'), 'utf8')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

describe('audio licensing', () => {
  const shipped = walk(PUBLIC).filter((f) => AUDIO.test(f)).map((f) => relative(PUBLIC, f))

  it('every shipped audio file is declared in CREDITS.md', () => {
    expect(shipped.length).toBeGreaterThan(0)
    for (const f of shipped) {
      const dir = f.split('/').slice(0, -1).join('/')
      expect(credits, `${f} is not covered by CREDITS.md`).toContain(`public/${dir}/*`)
    }
  })

  it('the declared generator exists and names exactly the files that ship', () => {
    expect(credits).toContain('scripts/generate-sfx.mjs')
    const gen = readFileSync(join(WEB, 'scripts/generate-sfx.mjs'), 'utf8')
    for (const f of shipped.filter((x) => x.startsWith('sounds/fps/'))) expect(gen, f).toContain(f.split('/').pop()!.replace('.mp3', ''))
  })

  it('no recorded voice or music ships (all of it is synthesised, and CREDITS says so)', () => {
    expect(existsSync(join(PUBLIC, 'vo'))).toBe(false)
    expect(existsSync(join(PUBLIC, 'music'))).toBe(false)
    expect(credits).toMatch(/ships no recorded voice/i)
    expect(shipped.every((f) => f.startsWith('sounds/fps/'))).toBe(true)
  })

  it('the source never loads audio from an outside host', () => {
    const files = walk(join(WEB, 'src')).filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes('__tests__'))
    const outside = /https?:\/\/[^'"`\s]+\.(mp3|wav|ogg|m4a|flac|aac|opus)\b/i
    for (const f of files) expect(readFileSync(f, 'utf8'), relative(WEB, f)).not.toMatch(outside)
  })

  it('CREDITS lists the runtime-synthesised sounds and the scripts that generate files', () => {
    expect(credits).toMatch(/synthesised at runtime with the Web Audio API/)
    expect(resolve(WEB, 'scripts/generate-sfx.mjs')).toBeTruthy()
  })
})
