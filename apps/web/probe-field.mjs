// Drives every operation type through the real scene and checks the physical
// interactions: E holds on cases, charges and the seized case, supplies, the
// extraction call and countdown, interruption, the record, and frame rate.
//
//   node probe-field.mjs [base] [outdir] [filter]
//
// It uses the scene's development hooks (window.__cz*) to move the player and to
// clear guards, so it checks interactions, not marksmanship. One run also fights
// for real to check finite ammunition, reloads and dropped magazines.
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3000';
const OUT = process.argv[3] ?? './field-out';
const FILTER = process.argv[4] ?? '';
fs.mkdirSync(OUT, { recursive: true });

const RUNS = [
  ['dustline-depot', 'raid', 'day'], ['dustline-depot', 'raid', 'night'],
  ['dustline-depot', 'sabotage', 'dusk'], ['dustline-depot', 'recovery', 'day'],
  ['blacksite', 'raid', 'night'], ['blacksite', 'raid', 'day'],
  ['blacksite', 'sabotage', 'night'], ['blacksite', 'recovery', 'night'],
].filter(([s, k, p]) => `${s}-${k}-${p}`.includes(FILTER));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = [];

async function until(page, fn, arg, ms = 60_000, every = 250) {
  const t0 = Date.now();
  for (;;) {
    const v = await page.evaluate(fn, arg).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(every);
  }
}
const field = (page) => page.evaluate(() => window.__czField?.());
const mission = (page) => page.evaluate(() => window.__czMission?.());

/** Stand just south of a point, looking down at it. */
async function standAt(page, [x, z]) {
  await page.evaluate(([x, z]) => { window.__czWarp(x, z + 0.5); window.__czLook(0, -1.2); }, [x, z]);
  await sleep(300);
}

/** Hold E until `done(field)` or a timeout. */
async function holdE(page, done, arg = null, ms = 45_000) {
  await page.keyboard.down('KeyE');
  const ok = await until(page, done, arg, ms, 200);
  await page.keyboard.up('KeyE');
  return !!ok;
}

async function fps(page, ms = 3000) {
  return page.evaluate((ms) => new Promise((res) => {
    let n = 0; const t0 = performance.now();
    const f = () => { n++; if (performance.now() - t0 < ms) requestAnimationFrame(f); else res(Math.round((n * 1000) / (performance.now() - t0))); };
    requestAnimationFrame(f);
  }), ms);
}

/** Walk the objective list in order: reach points by warping, rooms by clearing. */
async function advanceTo(page, kinds) {
  for (let guard = 0; guard < 12; guard++) {
    const m = await mission(page);
    const objs = await page.evaluate(() => window.__czObjectives());
    const cur = objs[m.objective];
    if (!cur || kinds.includes(cur.kind)) return cur;
    if (cur.kind === 'reach') { await page.evaluate(([x, z]) => window.__czWarp(x, z), cur.pos); }
    if (cur.kind === 'clear') { await page.evaluate(() => window.__czKillAll()); }
    await until(page, (i) => window.__czMission().objective > i, m.objective, 20_000);
  }
  return null;
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
for (const [site, kind, phase] of RUNS) {
  const name = `${site}-${kind}-${phase}`;
  const r = { name, checks: {}, errors: [] };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => r.errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|vo\/|404/.test(m.text())) r.errors.push(m.text()); });
  const t0 = Date.now();
  try {
    await page.goto(`${BASE}/dev/level?site=${site}&kind=${kind}&phase=${phase}&defense=2&seed=3`);
    await page.waitForSelector('canvas', { timeout: 120_000 });
    await until(page, () => !!window.__czField && !!window.__czMission, null, 60_000);
    await page.mouse.click(640, 360);
    await page.evaluate(() => window.__czSkipBriefing());
    await sleep(1500);
    r.fps_start = await fps(page);
    const f0 = await field(page);
    r.checks.objects = f0.items.length;
    r.checks.exfil = f0.exfil;
    await page.screenshot({ path: `${OUT}/${name}-1-start.png` });

    // Supplies: an ammunition crate and a medical case.
    const crate = f0.items.find((i) => i.kind === 'ammo_crate');
    if (crate) {
      const before = (await field(page)).reserve;
      await standAt(page, crate.pos);
      await page.screenshot({ path: `${OUT}/${name}-2-crate-prompt.png` });
      const took = await holdE(page, (id) => window.__czField().items.find((i) => i.id === id).state !== 'idle' || window.__czField().record.looted.includes(id), crate.id, 20_000);
      const after = await field(page);
      r.checks.ammo_pickup = { took, before, after: after.reserve, looted: after.record.looted };
    }
    const med = f0.items.find((i) => i.kind === 'med_case');
    if (med) {
      await page.evaluate(() => { window.__czState(); });
      const before = (await field(page)).medkits;
      await standAt(page, med.pos);
      await holdE(page, (id) => window.__czField().record.looted.includes(id), med.id, 20_000);
      r.checks.med_pickup = { before, after: (await field(page)).medkits };
    }

    if (kind === 'raid') {
      // Extraction before any cargo is refused.
      const cur = await advanceTo(page, ['secure']);
      r.checks.reached = cur?.kind;
      const f1 = await field(page);
      const cases = f1.items.filter((i) => i.kind === 'cargo_case');
      const c1 = cases[0];
      await standAt(page, c1.pos);
      await page.keyboard.down('KeyE');
      await sleep(250);
      await page.keyboard.up('KeyE'); // a tap: not enough
      r.checks.tap_does_not_take = (await field(page)).carried.length === 0;
      await page.keyboard.down('KeyE');
      await sleep(400);
      await page.screenshot({ path: `${OUT}/${name}-3-case-hold.png` });
      await until(page, () => window.__czField().carried.length >= 1, null, 30_000, 200);
      await page.keyboard.up('KeyE');
      await standAt(page, cases[1].pos);
      await holdE(page, () => window.__czField().carried.length >= 2);
      const f2 = await field(page);
      r.checks.carried = f2.carried;
      r.checks.speed_mult = f2.speed;
      r.checks.secured_before_exfil = f2.record.secured;
      await page.screenshot({ path: `${OUT}/${name}-4-carrying.png` });
    } else if (kind === 'sabotage') {
      for (const id of ['charge-1', 'charge-2']) {
        const cur = await advanceTo(page, ['plant']);
        const ch = (await field(page)).items.find((i) => i.id === id);
        await standAt(page, ch.pos);
        if (id === 'charge-1') { await page.keyboard.down('KeyE'); await sleep(600); await page.screenshot({ path: `${OUT}/${name}-3-planting.png` }); await page.keyboard.up('KeyE'); }
        await holdE(page, (id) => window.__czField().planted.includes(id), id);

        r.checks[id] = (await field(page)).planted.includes(id) && cur?.item === id;
      }
      r.checks.detonated = !!(await until(page, () => window.__czField().detonated, null, 90_000));
      await sleep(400);
      await page.evaluate(() => window.__czLook(Math.PI, 0));
      await page.screenshot({ path: `${OUT}/${name}-4-detonation.png` });
    } else {
      await advanceTo(page, ['retrieve']);
      const sc = (await field(page)).items.find((i) => i.kind === 'seized_case');
      await standAt(page, sc.pos);
      await page.screenshot({ path: `${OUT}/${name}-3-seized-prompt.png` });
      await holdE(page, () => window.__czField().carried.includes('seized-case'));
      r.checks.seized_in_hand = (await field(page)).carried;
      r.checks.speed_mult = (await field(page)).speed;
    }

    // Extraction: call it, hold the zone, step out once to check the pause. Guards
    // are cleared first so this checks the mechanics, not who wins the firefight
    // (the combat run below fights for real). A raid may call it while still on
    // the secure step, once a case is in hand.
    const cur = await advanceTo(page, ['extract', 'secure']);
    await page.evaluate(() => window.__czKillAll());
    r.checks.at_extract = cur?.text;
    const fz = await field(page);
    const z = fz.exfil;
    await page.evaluate(([x, zz]) => { window.__czWarp(x, zz); window.__czLook(0, -0.35); }, z.pos);
    await sleep(500);
    await page.screenshot({ path: `${OUT}/${name}-5-zone.png` });
    await holdE(page, () => window.__czField().phase === 'counting', null, 20_000);
    await until(page, () => window.__czField().progress > 2, null, 30_000);
    await page.evaluate(([x, zz, rr]) => window.__czWarp(x + rr + 3, zz), [z.pos[0], z.pos[1], z.radius]);
    await sleep(1500);
    const outside = await field(page);
    await page.screenshot({ path: `${OUT}/${name}-6-outside-zone.png` });
    await page.evaluate(([x, zz]) => window.__czWarp(x, zz), z.pos);
    r.checks.left_zone = { progress_outside: +outside.progress.toFixed(2), phase: outside.phase };
    await until(page, () => window.__czField().progress > 6, null, 40_000);
    await page.evaluate(() => window.__czLook(1.2, 0.05));
    await page.screenshot({ path: `${OUT}/${name}-7-countdown.png` });
    r.fps_exfil = await fps(page);
    const done = await until(page, () => window.__czField().phase === 'done' && window.__czMission().complete, null, 60_000);
    await sleep(600);
    await page.screenshot({ path: `${OUT}/${name}-8-complete.png` });
    const fin = await field(page);
    r.checks.extracted = !!done;
    r.checks.record = fin.record;
    r.checks.complete_text = await page.evaluate(() => document.body.innerText.match(/EXTRACTED[^\n]*|HANDED OVER[^\n]*/)?.[0] ?? null);
    r.perf = await page.evaluate(() => window.__czPerf?.());
  } catch (e) {
    r.errors.push(`probe: ${e.message}`);
    await page.screenshot({ path: `${OUT}/${name}-error.png` }).catch(() => {});
  }
  r.secs = Math.round((Date.now() - t0) / 1000);
  report.push(r);
  console.log(JSON.stringify(r));
  await ctx.close();
}

// One fight for real: finite ammunition, reloads, dropped magazines.
if (!FILTER || FILTER === 'combat') {
  const r = { name: 'combat-depot-day', checks: {}, errors: [] };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => r.errors.push(String(e)));
  try {
    await page.goto(`${BASE}/dev/level?site=dustline-depot&kind=raid&phase=day&defense=1&seed=3`);
    await page.waitForSelector('canvas', { timeout: 120_000 });
    await until(page, () => !!window.__czField, null, 60_000);
    await page.mouse.click(640, 360);
    await page.evaluate(() => window.__czSkipBriefing());
    await sleep(1500);
    const start = await field(page);
    r.checks.reserve_start = start.reserve;
    await page.evaluate(() => { const o = window.__czObjectives()[0]; window.__czWarp(o.pos[0], o.pos[1]); });
    await until(page, () => window.__czMission().objective >= 1, null, 20_000);
    // Aim at the nearest live guard each beat and hold the trigger.
    const t0 = Date.now();
    let kills = 0;
    while (Date.now() - t0 < 90_000) {
      const st = await page.evaluate(() => {
        const s = window.__czState(); const p = window.__czPlayer();
        const live = s.enemies.filter((e) => e.alive);
        if (!live.length) return { done: true, kills: s.stats.kills };
        live.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
        const e = live[0];
        window.__czLook(Math.atan2(-(e.x - p.x), -(e.z - p.z)), -0.03);
        return { done: false, kills: s.stats.kills, d: Math.hypot(e.x - p.x, e.z - p.z) };
      });
      kills = st.kills;
      if (st.done || kills >= 3) break;
      await page.evaluate(() => window.__czFire(true));
      await sleep(700);
      await page.evaluate(() => window.__czFire(false));
      await sleep(150);
    }
    await page.evaluate(() => window.__czFire(false));
    const after = await field(page);
    r.checks.kills = kills;
    r.checks.reserve_after = after.reserve;
    r.checks.reserve_spent = start.reserve - after.reserve;
    r.checks.pouches = after.items.filter((i) => i.kind === 'pouch').length;
    const pouch = after.items.find((i) => i.kind === 'pouch');
    if (pouch) {
      await page.evaluate(() => window.__czKillAll());
      await standAt(page, pouch.pos);
      await page.screenshot({ path: `${OUT}/combat-pouch-prompt.png` });
      const before = (await field(page)).reserve;
      await holdE(page, (id) => window.__czField().items.find((i) => i.id === id).state === 'empty', pouch.id, 15_000);
      const fp = await field(page);
      r.checks.pouch_pickup = { id: pouch.id, rounds: pouch.rounds, state: fp.items.find((i) => i.id === pouch.id).state };
      await page.keyboard.press('Digit2'); await sleep(400);
      r.checks.sidearm_reserve = (await field(page)).reserve;
    }
    await page.screenshot({ path: `${OUT}/combat-after.png` });
  } catch (e) { r.errors.push(`probe: ${e.message}`); }
  report.push(r);
  console.log(JSON.stringify(r));
  await ctx.close();
}
await browser.close();
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
