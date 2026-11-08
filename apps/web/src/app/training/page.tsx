'use client';

import dynamic from 'next/dynamic';
import { Rajdhani } from 'next/font/google';
import { retryImport } from '@/lib/retryImport';

// The condensed, technical HUD face, exposed as a CSS var the scene's overlays use.
const tactical = Rajdhani({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-tactical',
  display: 'swap',
});

// Training: the full FPS with its practice operations and the kill-house, offline
// and unscored. Contracts run through the deployment flow instead.
const ContractZeroScene = dynamic(
  () => retryImport(() => import('@/engine/scene/ContractZeroScene')).then((m) => m.ContractZeroScene),
  { ssr: false },
);

export default function TrainingPage() {
  return (
    <div className={tactical.variable} style={{ position: 'fixed', inset: 0 }}>
      <ContractZeroScene />
    </div>
  );
}
