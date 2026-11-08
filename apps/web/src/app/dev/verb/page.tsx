'use client';

import dynamic from 'next/dynamic';
import { Rajdhani } from 'next/font/google';
import { retryImport } from '@/lib/retryImport';

// A condensed, technical typeface for the tactical HUD — exposed as a CSS var so
// the scene's overlays can opt into it (defaulting to mono for raw telemetry).
const tactical = Rajdhani({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-tactical',
  display: 'swap',
});

// Valor clone · slice 1 graybox (docs/the plan.md).
// This dev sandbox is repurposed for the Valor first-person build (Marvy's rule:
// test here without disturbing the live /fight game; attach to /fight only when
// the whole Valor build is done). The old melee GrayboxVerbScene is shelved in
// git history, not mounted.
const ValorScene = dynamic(
  () => retryImport(() => import('@/engine/scene/ValorScene')).then((m) => m.ValorScene),
  { ssr: false },
);

export default function ValorPlaygroundPage() {
  return (
    <div className={tactical.variable} style={{ position: 'fixed', inset: 0 }}>
      <ValorScene />
    </div>
  );
}
