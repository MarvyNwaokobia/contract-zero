'use client';

// Training: everything you can play without a contract. Nothing here is scored and
// nothing here touches the economy or NEAR.
//
//  - Campaign: the 15 authored practice operations and the kill-house.
//  - Practice: any implemented site, at any hour, as any operation type, at any
//    defense level. The same mission builder and field objects as a live contract,
//    with a local object list instead of the server's.
//  - Endless: the procedural room chain, wave after wave.

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Rajdhani } from 'next/font/google';
import { retryImport } from '@/lib/retryImport';
import { Shell } from '@/components/ui/Shell';
import { HowToPlayButton } from '@/components/help/HowToPlay';
import { useSettings } from '@/lib/settings';
import { bindLabel, type Action } from '@/lib/keybinds';
import { OperationIntel } from '@/components/world/OperationIntel';
import { buildOperationMission, conditionsFor, PRACTICE_SITES, type ConvoyContract, type OpKind, type Phase, type Resource } from '@/engine/fps/convoy';
import type { ContractRunStats } from '@/engine/scene/ContractZeroScene';

// The condensed, technical HUD face, exposed as a CSS var the scene's overlays use.
const tactical = Rajdhani({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-tactical',
  display: 'swap',
});

const ContractZeroScene = dynamic(
  () => retryImport(() => import('@/engine/scene/ContractZeroScene')).then((m) => m.ContractZeroScene),
  { ssr: false, loading: () => <div className="fixed inset-0 bg-black" /> },
);

type Mode = 'menu' | 'campaign' | 'practice' | 'endless';

const KINDS: { id: OpKind; label: string; about: string }[] = [
  { id: 'raid', label: 'Raid', about: 'Take cargo cases, carry them out' },
  { id: 'sabotage', label: 'Sabotage', about: 'Set two charges on real targets' },
  { id: 'recovery', label: 'Recovery', about: 'Free the seized case, hand it over' },
];
const PHASES: { id: Phase; label: string }[] = [{ id: 'day', label: 'Day' }, { id: 'dusk', label: 'Dusk' }, { id: 'night', label: 'Night' }];
const RESOURCES: { id: Resource; label: string }[] = [{ id: 'ammo', label: 'Ammunition' }, { id: 'med', label: 'Medicine' }, { id: 'fuel', label: 'Fuel' }];

function Choice<T extends string | number>({ label, value, options, onChange, testid }: {
  label: string; value: T; options: { id: T; label: string; about?: string }[]; onChange: (v: T) => void; testid: string;
}) {
  return (
    <fieldset>
      <legend className="cz-label mb-2 !text-[10px]">{label}</legend>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={String(o.id)} role="radio" aria-checked={value === o.id} data-testid={`${testid}-${o.id}`} onClick={() => onChange(o.id)}
            className={`border px-4 py-2 text-left text-sm ${value === o.id ? 'border-amber bg-amber/10 text-fog' : 'border-line text-muted hover:bg-panel-2'}`}>
            <div className="font-semibold">{o.label}</div>
            {o.about && <div className="text-xs text-dim">{o.about}</div>}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function Practice({ onPlay }: { onPlay: (c: ConvoyContract) => void }) {
  const [siteId, setSite] = useState(PRACTICE_SITES[0].id);
  const [phase, setPhase] = useState<Phase>('day');
  const [kind, setKind] = useState<OpKind>('raid');
  const [defense, setDefense] = useState(2);
  const [resource, setResource] = useState<Resource>('ammo');
  const site = PRACTICE_SITES.find((s) => s.id === siteId)!;
  const contract = useMemo<ConvoyContract>(() => ({
    id: `practice-${siteId}-${kind}-${phase}-${defense}`,
    kind, issuer: kind === 'raid' ? undefined : 'Vex Exchange', target: 'Vanguard',
    cargo: { resource, units: 60 }, defense, seed: 1000 + defense * 7 + (kind === 'raid' ? 0 : kind === 'sabotage' ? 1 : 2),
    site, conditions: conditionsFor(phase),
  }), [siteId, kind, phase, defense, resource, site]);
  return (
    <div className="grid gap-5">
      <div className="cz-panel grid gap-4 p-4 md:grid-cols-2">
        <Choice<string> label="Environment" value={siteId} onChange={setSite} testid="site" options={PRACTICE_SITES.map((s) => ({ id: s.id, label: s.name, about: s.environment }))} />
        <Choice<Phase> label="Time of day" value={phase} onChange={setPhase} testid="phase" options={PHASES} />
        <Choice<OpKind> label="Operation" value={kind} onChange={setKind} testid="kind" options={KINDS} />
        <Choice<number> label="Difficulty (defense level)" value={defense} onChange={setDefense} testid="defense" options={[1, 2, 3, 4, 5].map((d) => ({ id: d, label: `L${d}` }))} />
        <Choice<Resource> label="Cargo" value={resource} onChange={setResource} testid="resource" options={RESOURCES} />
      </div>
      <OperationIntel contract={contract} kind={kind} practice />
      <div className="flex items-center gap-4">
        <button className="cz-btn cz-btn-primary px-6 py-3" onClick={() => onPlay(contract)} data-testid="start-practice">Start practice</button>
        <span className="text-xs text-dim">Unscored. Nothing you take here exists outside this run, and nothing is settled on NEAR.</span>
      </div>
    </div>
  );
}

export default function TrainingPage() {
  const settings = useSettings();
  const k = (a: Action) => bindLabel(settings.controls.binds, a);
  const [mode, setMode] = useState<Mode>('menu');
  const [practice, setPractice] = useState<ConvoyContract | null>(null);
  const [result, setResult] = useState<{ outcome: 'extracted' | 'killed'; stats: ContractRunStats } | null>(null);
  const [runKey, setRunKey] = useState(0);
  const [seed] = useState(() => Math.floor(Math.random() * 1e6));
  const mission = useMemo(() => (practice ? buildOperationMission(practice) : null), [practice]);

  if (mode === 'campaign') {
    return (
      <div className={tactical.variable} style={{ position: 'fixed', inset: 0 }}>
        <ContractZeroScene onExit={() => setMode('menu')} />
      </div>
    );
  }
  if (mode === 'endless') {
    return (
      <div className={tactical.variable} style={{ position: 'fixed', inset: 0 }}>
        <ContractZeroScene key={runKey} endless={{ seed, startWave: 1 }} onExit={() => setMode('menu')} />
      </div>
    );
  }
  if (mode === 'practice' && mission && !result) {
    return (
      <div className={tactical.variable} style={{ position: 'fixed', inset: 0 }}>
        <ContractZeroScene
          key={runKey}
          contract={{ mission, onExtracted: (stats) => setResult({ outcome: 'extracted', stats }), onKilled: (stats) => setResult({ outcome: 'killed', stats }) }}
          onExit={() => { setPractice(null); setMode('practice'); }}
        />
      </div>
    );
  }

  return (
    <Shell title="Training" back={{ href: '/', label: 'Hub' }} wide>
      <div className="-mt-3 mb-4 flex justify-end"><HowToPlayButton /></div>
      {result && (
        <section className="cz-panel mb-5 p-5" data-testid="practice-result">
          <div className={`font-display text-2xl font-bold uppercase ${result.outcome === 'extracted' ? 'text-friendly' : 'text-hostile'}`}>
            {result.outcome === 'extracted' ? 'Practice complete' : 'Down · practice over'}
          </div>
          <p className="mt-1 text-sm text-muted">
            {Math.round(result.stats.secs)} s · {result.stats.kills} kills
            {result.stats.record && ` · cases carried out: ${result.stats.record.secured.length} · charges: ${result.stats.record.charges.length}${result.stats.record.delivered ? ' · seized case delivered' : ''} · containers looted: ${result.stats.record.looted.length}`}
          </p>
          <p className="mt-1 text-xs text-dim">Nothing was scored or settled. Live contracts are on the <Link href="/contracts" className="text-amber-hi">board</Link>.</p>
          <div className="mt-3 flex gap-3">
            <button className="cz-btn cz-btn-primary px-5 py-2 text-sm" onClick={() => { setResult(null); setRunKey((k) => k + 1); }}>Run it again</button>
            <button className="cz-btn cz-btn-ghost px-5 py-2 text-sm" onClick={() => { setResult(null); setPractice(null); }}>Change setup</button>
          </div>
        </section>
      )}
      <div className="mb-5 grid gap-3 sm:grid-cols-3" role="tablist" aria-label="Training modes">
        {([
          ['campaign', 'Campaign', '15 authored operations across Dustline, Redyard and the Blacksite, plus the kill-house. Extraction zones at the end of each.'],
          ['practice', 'Practice', 'Any site, any hour, any operation type and difficulty. The same objects and extraction as a live contract.'],
          ['endless', 'Endless', 'A procedural chain of rooms, generated as you push. Waves grow until you fall. Unscored.'],
        ] as const).map(([id, name, about]) => (
          <button key={id} role="tab" aria-selected={mode === id} data-testid={`mode-${id}`}
            onClick={() => { setResult(null); setMode(id); }}
            className={`cz-panel p-4 text-left ${mode === id ? 'ring-1 ring-amber' : 'hover:bg-panel-2'}`}>
            <div className="font-display text-xl font-bold uppercase tracking-wide">{name}</div>
            <div className="mt-1 text-sm text-muted">{about}</div>
          </button>
        ))}
      </div>
      {mode === 'practice' && <Practice onPlay={(c) => { setResult(null); setPractice(c); setRunKey((k) => k + 1); }} />}
      {mode === 'menu' && <p className="text-sm text-muted">Choose a mode. Nothing in Training is scored, and nothing here touches the economy or NEAR.</p>}
      <p className="mt-6 text-xs text-dim">Controls: {k('moveForward')}{k('moveLeft')}{k('moveBack')}{k('moveRight')} move · mouse aim · click or {k('fire')} fire · {k('reload')} reload · {k('interact')} interact ({settings.access.toggleInteract ? 'press' : 'hold'}) · {k('heal')} field dressing · {k('crouch')} crouch · {k('leanLeft')} / {k('leanRight')} lean · {k('swap')} swap · {k('nvg')} night vision · {k('light')} light · Esc pause. <Link href="/settings#keys" className="underline hover:text-fog">Change keys</Link></p>
    </Shell>
  );
}
