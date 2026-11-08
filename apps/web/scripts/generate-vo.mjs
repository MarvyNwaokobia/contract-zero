// VO generation pipeline.
//
// Reads the presence-line manifest and synthesizes one mp3 per line into
// public/vo/{id}.mp3 via ElevenLabs. AudioDirector.playVo() picks the files
// up automatically — no code changes needed after generating.
//
// Usage:
//   ELEVENLABS_API_KEY=sk_... node scripts/generate-vo.mjs
//
// Optional per-speaker voice overrides (browse voices at elevenlabs.io):
//   VOICE_HANDLER=<voice_id> VOICE_IRONVEIL=<voice_id> VOICE_VEX=<voice_id>
//
// Existing files are skipped, so re-running only generates new lines.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(root, 'src/engine/story/presence.ts');
const outDir = resolve(root, 'public/vo');

const API_KEY = process.env.ELEVENLABS_API_KEY;
if (!API_KEY) {
  console.error('ELEVENLABS_API_KEY is not set. Get a key at elevenlabs.io, then:');
  console.error('  ELEVENLABS_API_KEY=sk_... node scripts/generate-vo.mjs');
  process.exit(1);
}

// Default voice ids are ElevenLabs premades; override per speaker via env.
const VOICES = {
  handler: process.env.VOICE_HANDLER ?? 'EXAVITQu4vr4xnSDxMaL',   // "Sarah": calm, close
  ironveil: process.env.VOICE_IRONVEIL ?? 'onwK4e9ZLuTAKqWW03F9',  // "Daniel": low, unhurried
  vex: process.env.VOICE_VEX ?? 'TX3LPaxmHKxFdv7VOQHJ',            // "Liam": a trader's edge
};

// Tolerant extraction of { id, speaker, text } from the TS manifest.
const src = readFileSync(manifestPath, 'utf8');
const lineRe = /id:\s*'([^']+)',\s*speaker:\s*'(\w+)',\s*trigger:\s*'[^']+',\s*text:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/gs;
const lines = [];
let m;
while ((m = lineRe.exec(src)) !== null) {
  lines.push({ id: m[1], speaker: m[2], text: (m[3] ?? m[4]).replace(/\\(['"])/g, '$1') });
}
if (lines.length === 0) {
  console.error('No lines parsed from presence.ts — did the manifest shape change?');
  process.exit(1);
}
console.log(`${lines.length} lines in the manifest`);
mkdirSync(outDir, { recursive: true });

for (const line of lines) {
  const out = resolve(outDir, `${line.id}.mp3`);
  if (existsSync(out)) {
    console.log(`skip   ${line.id} (exists)`);
    continue;
  }
  const voice = VOICES[line.speaker];
  process.stdout.write(`gen    ${line.id} [${line.speaker}] ... `);
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
    method: 'POST',
    headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: line.text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35 },
    }),
  });
  if (!res.ok) {
    console.log(`FAILED (${res.status}: ${(await res.text()).slice(0, 120)})`);
    continue;
  }
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  console.log('ok');
}
console.log('done — files land in public/vo/, playVo() uses them automatically');
