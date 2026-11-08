#!/usr/bin/env node
// The mission story end to end: a signed-in player takes a contract from the live
// board, gets a briefing written from the world's facts, fetches the (optionally
// model-voiced, checked) story, and reports the run lost, which settles nothing,
// so this never touches NEAR. Prints the briefing, the radio and the debrief.
//
// Usage: node scripts/story-e2e.mjs [apiUrl] [kind]
import { homedir } from 'node:os';
import { client, loadKey, signIn } from './lib/cz-auth.mjs';

const API = process.argv[2] ?? 'http://127.0.0.1:8080';
const want = process.argv[3];
const key = loadKey(`${homedir()}/.contract-zero/keys/players-full/player.contract-zero.testnet.json`);
const must = (c, m) => { if (!c) throw new Error(m); };

const login = await signIn(API, key.accountId, key.keyPair);
must(login.status === 200, 'sign-in failed');
const me = client(API, login.cookie);
const board = (await me.get('/board')).body.board;
const e = board.find((b) => !want || b.kind === want) ?? board[0];
must(e, 'nothing on the board');
const start = await me.post('/missions/start', { target: e.target, resource: e.resource, kind: e.kind });
must(start.status === 200, `start: ${JSON.stringify(start.body)}`);
const s = start.body.story;
must(s && s.briefing.length >= 2, 'no briefing in the start response');
console.log(`${s.codename} · ${s.location} · ${s.time} (${e.kind} on ${e.target_name}'s ${e.resource}, sponsor ${e.bounty?.sponsor_name ?? 'none'})`);
for (const l of s.briefing) console.log(`  [${l.speaker}] ${l.text}`);
const t0 = Date.now();
const voiced = await me.get(`/missions/${start.body.session}/story`);
must(voiced.status === 200, `story: ${voiced.status}`);
console.log(`story endpoint: ${voiced.body.story.source} in ${Date.now() - t0} ms`);
for (const [trigger, lines] of Object.entries(voiced.body.story.radio)) for (const l of lines) console.log(`  ${trigger.padEnd(15)} [${l.speaker}] ${l.text}`);
const other = await client(API).get(`/missions/${start.body.session}/story`);
must(other.status === 401, `story without a session should be refused, got ${other.status}`);
const done = await me.post(`/missions/${start.body.session}/complete`, { outcome: 'killed', kills: 2 });
must(done.status === 200, `complete: ${JSON.stringify(done.body)}`);
console.log(`debrief (${done.body.result.codename}):`);
for (const l of done.body.result.debrief ?? []) console.log(`  [${l.speaker}] ${l.text}`);
must((done.body.result.debrief ?? []).length >= 1, 'no debrief');
console.log('OK');
