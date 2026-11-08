import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PRESENCE_LINES, SPEAKER_META, linesFor, type PresenceTrigger } from '../presence';

/** The mission beats the Valor doorkicker operation fires (the plan slice 6). */
const MISSION_TRIGGERS: PresenceTrigger[] = [
  'opStart', 'opBreach', 'troopsCleared', 'valorFirstWord',
  'opPushIn', 'lowHp', 'opHeroDown', 'zoneClear', 'zoneClearTag',
];

/** These four are already recorded and are weapon-agnostic, so the FPS reuses them. */
const REUSED_RECORDED = ['ember-low-hp', 'ember-troops-cleared', 'valor-zone-clear', 'ember-zone-clear'];

describe('presence lines', () => {
  it('gives every line a unique id', () => {
    const ids = PRESENCE_LINES.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names a known speaker on every line', () => {
    for (const l of PRESENCE_LINES) expect(SPEAKER_META[l.speaker]).toBeTruthy();
  });

  it('resolves at least one line for every mission beat', () => {
    for (const t of MISSION_TRIGGERS) {
      expect(linesFor(t).length, `no line for trigger "${t}"`).toBeGreaterThan(0);
    }
  });

  it('ends the operation on Valor, then Ember naming him (the gate)', () => {
    expect(linesFor('zoneClear')[0].speaker).toBe('valor');
    const tag = linesFor('zoneClearTag')[0];
    expect(tag.speaker).toBe('ember');
    expect(tag.text).toContain('Valor');
  });

  it('the reused lines actually have recorded VO on disk', () => {
    const vo = resolve(__dirname, '../../../../public/vo');
    for (const id of REUSED_RECORDED) {
      expect(PRESENCE_LINES.some((l) => l.id === id), `${id} missing from manifest`).toBe(true);
      expect(existsSync(resolve(vo, `${id}.mp3`)), `${id}.mp3 not on disk`).toBe(true);
    }
  });

  it('the new doorkicker lines never mention the blade the hero no longer carries', () => {
    const newIds = ['ember-op-start', 'ember-op-breach', 'valor-first-word', 'valor-push-in', 'valor-op-down'];
    for (const id of newIds) {
      const line = PRESENCE_LINES.find((l) => l.id === id);
      expect(line, `${id} missing`).toBeTruthy();
      expect(line!.text.toLowerCase()).not.toContain('blade');
    }
  });
});
