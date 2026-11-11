'use client';

import { Suspense, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { buildOperationMission, conditionsFor, PRACTICE_SITES, ZONE_PHASE, type OpKind, type Phase } from '@/engine/fps/convoy';
import dynamic from 'next/dynamic';
// Client-only, like the player routes: the scene reads the device (touch, saved
// settings) on its first render, which a server render can't know.
const ContractZeroScene = dynamic(() => import('@/engine/scene/ContractZeroScene').then((m) => m.ContractZeroScene), { ssr: false });
import type { GunId } from '@/engine/combat/GunStats';

/** Dev only: drop into an operation on a site without the server. Nothing is scored.
 *  /dev/level?site=dustline-depot|blacksite|cinder-yard&phase=day|dusk|night&kind=raid|sabotage|recovery&defense=1..5&seed=n&gun=smg
 *  The old ?zone=DUSTLINE|REDYARD|BLACKSITE still works (it picks the site and the hour). */
function Level() {
  const q = useSearchParams();
  const zone = q.get('zone');
  const siteId = q.get('site') ?? (zone === 'BLACKSITE' ? 'blacksite' : 'dustline-depot');
  const phase = (q.get('phase') ?? (zone ? ZONE_PHASE[zone] : 'day') ?? 'day') as Phase;
  const defense = Number(q.get('defense') ?? 2);
  const seed = Number(q.get('seed') ?? 1);
  const kind = (q.get('kind') ?? 'raid') as OpKind;
  const gun = (q.get('gun') ?? 'assault_rifle') as GunId;
  const site = PRACTICE_SITES.find((s) => s.id === siteId) ?? PRACTICE_SITES[0];
  // Dev only: ?linesDown=fuel,ammo and ?delivering=1 stand in for what the server would send (cues).
  const linesParam = q.get('linesDown') ?? '';
  const delivering = q.get('delivering') === '1';
  const mission = useMemo(() => buildOperationMission({
    id: `dev-${site.id}-${seed}`, kind, issuer: 'Vex Exchange', target: 'vanguard', cargo: { resource: 'ammo', units: 60 },
    defense, seed, site, conditions: conditionsFor(phase),
    cues: linesParam || delivering ? {
      tick: 0,
      lines_down: linesParam.split(',').filter((r): r is 'ammo' | 'med' | 'fuel' => r === 'ammo' || r === 'med' || r === 'fuel').map((resource) => ({ resource, line: `${resource} line`, until: 60 })),
      deliveries: delivering ? [{ resource: 'fuel', units: 60, arrives_at: 0, state: 'arriving' }] : [],
    } : undefined,
  }, gun), [site, defense, seed, kind, phase, gun, linesParam, delivering]);
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <ContractZeroScene contract={{ mission, onExtracted: () => {}, onKilled: () => {} }} />
    </div>
  );
}

export default function DevLevel() {
  return <Suspense fallback={null}><Level /></Suspense>;
}
