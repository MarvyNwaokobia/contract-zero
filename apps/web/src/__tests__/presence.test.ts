import { describe, it, expect } from 'vitest';
import { PRESENCE_LINES, SPEAKER_META, linesFor } from '@/engine/story/presence';

/** Slice 5: the manifest is content AND config (VO filenames) — keep it sound. */

describe('presence manifest', () => {
  it('ids are unique (they become VO filenames)', () => {
    const ids = PRESENCE_LINES.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every speaker exists in the meta table', () => {
    for (const l of PRESENCE_LINES) {
      expect(SPEAKER_META[l.speaker]).toBeDefined();
    }
  });

  it('no empty lines, nothing unreadably long for a combat subtitle', () => {
    for (const l of PRESENCE_LINES) {
      expect(l.text.trim().length).toBeGreaterThan(0);
      expect(l.text.length).toBeLessThan(160);
    }
  });

  it('the arc is covered: intro, the turn, Valor, and both endings', () => {
    for (const t of ['combatStart', 'troopsCleared', 'bossIntro', 'heroDown', 'zoneClear'] as const) {
      expect(linesFor(t).length).toBeGreaterThan(0);
    }
  });
});
