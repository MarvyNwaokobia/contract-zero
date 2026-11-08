import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PRESENCE_LINES, SPEAKER_META, linesFor, type PresenceTrigger } from '../presence';

const SCENE = readFileSync(resolve(__dirname, '../../scene/ContractZeroScene.tsx'), 'utf8');

describe('presence lines', () => {
  it('gives every line a unique id (ids become VO filenames)', () => {
    const ids = PRESENCE_LINES.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names a known speaker on every line', () => {
    for (const l of PRESENCE_LINES) expect(SPEAKER_META[l.speaker]).toBeTruthy();
  });

  it('keeps every line readable as a combat subtitle', () => {
    for (const l of PRESENCE_LINES) {
      expect(l.text.trim().length).toBeGreaterThan(0);
      expect(l.text.length).toBeLessThan(160);
    }
  });

  it('has a line for every trigger the scene fires', () => {
    const fired = new Set<string>();
    for (const m of SCENE.matchAll(/say\((?:[^)]*?\?\s*)?'([a-zA-Z]+)'(?:\s*:\s*'([a-zA-Z]+)')?/g)) {
      fired.add(m[1]);
      if (m[2]) fired.add(m[2]);
    }
    expect(fired.size).toBeGreaterThan(5);
    for (const t of fired) {
      expect(linesFor(t as PresenceTrigger).length, `no line for trigger "${t}"`).toBeGreaterThan(0);
    }
  });
});
