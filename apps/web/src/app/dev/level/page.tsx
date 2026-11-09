'use client';

import { Suspense, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { buildOperationMission, conditionsFor, PRACTICE_SITES, ZONE_PHASE, type OpKind, type Phase } from '@/engine/fps/convoy';
import { ContractZeroScene } from '@/engine/scene/ContractZeroScene';

/** Dev only: drop into an operation on a site without the server. Nothing is scored.
 *  /dev/level?site=dustline-depot|blacksite&phase=day|dusk|night&kind=raid|sabotage|recovery&defense=1..5&seed=n
 *  The old ?zone=DUSTLINE|REDYARD|BLACKSITE still works (it picks the site and the hour). */
function Level() {
  const q = useSearchParams();
  const zone = q.get('zone');
  const siteId = q.get('site') ?? (zone === 'BLACKSITE' ? 'blacksite' : 'dustline-depot');
  const phase = (q.get('phase') ?? (zone ? ZONE_PHASE[zone] : 'day') ?? 'day') as Phase;
  const defense = Number(q.get('defense') ?? 2);
  const seed = Number(q.get('seed') ?? 1);
  const kind = (q.get('kind') ?? 'raid') as OpKind;
  const site = PRACTICE_SITES.find((s) => s.id === siteId) ?? PRACTICE_SITES[0];
  const mission = useMemo(() => buildOperationMission({
    id: `dev-${site.id}-${seed}`, kind, issuer: 'Vex Exchange', target: 'vanguard', cargo: { resource: 'ammo', units: 60 },
    defense, seed, site, conditions: conditionsFor(phase),
  }), [site, defense, seed, kind, phase]);
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <ContractZeroScene contract={{ mission, onExtracted: () => {}, onKilled: () => {} }} />
    </div>
  );
}

export default function DevLevel() {
  return <Suspense fallback={null}><Level /></Suspense>;
}
