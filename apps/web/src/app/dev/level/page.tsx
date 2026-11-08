'use client';

import { Suspense, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { buildOperationMission, type ConvoyZone, type OpKind } from '@/engine/fps/convoy';
import { ContractZeroScene } from '@/engine/scene/ContractZeroScene';

/** Dev only: drop into a raid on a level without the server.
 *  /dev/level?zone=DUSTLINE|REDYARD|BLACKSITE&kind=raid|sabotage|recovery&defense=1..5&seed=n */
function Level() {
  const q = useSearchParams();
  const zone = (q.get('zone') ?? 'DUSTLINE') as ConvoyZone;
  const defense = Number(q.get('defense') ?? 2);
  const seed = Number(q.get('seed') ?? 1);
  const kind = (q.get('kind') ?? 'raid') as OpKind;
  const mission = useMemo(() => buildOperationMission({ id: `dev-${zone}-${seed}`, kind, issuer: 'Vex Exchange', target: 'vanguard', cargo: { resource: 'ammo', units: 60 }, defense, seed, zone }), [zone, defense, seed, kind]);
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <ContractZeroScene contract={{ mission, onExtracted: () => {}, onKilled: () => {} }} />
    </div>
  );
}

export default function DevLevel() {
  return <Suspense fallback={null}><Level /></Suspense>;
}
