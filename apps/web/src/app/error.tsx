'use client';

import { useEffect, useState } from 'react';
import { isChunkLoadError, hardReloadForChunkError } from '@/lib/retryImport';

/**
 * Page-level error boundary — catches runtime errors inside the route tree while
 * keeping the root layout mounted. Chunk-load failures self-heal with a single
 * hard reload; everything else offers a retry that re-renders the segment.
 *
 * If the auto-reload is suppressed (the once-per-window guard already fired, e.g.
 * the device is offline or the deploy is genuinely broken) we must NOT sit on a
 * "Reloading…" screen that never reloads — we show honest copy and a manual
 * button so the user always has a way out.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const chunk = isChunkLoadError(error);
  // Assume a chunk error is about to reload; the effect corrects this to `false`
  // if the guard suppressed the reload, revealing the manual button + real copy.
  const [reloading, setReloading] = useState(chunk);

  useEffect(() => {
    if (chunk && !hardReloadForChunkError()) setReloading(false);
  }, [chunk]);

  // This boundary used to swallow the error completely: players saw "Something
  // broke", we saw nothing, and diagnosing it meant guessing at which of a dozen
  // client paths threw on a phone we cannot attach a console to. Log it, and put
  // a short identifier on screen so a screenshot carries the one detail that
  // makes the report actionable.
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[valor] route error', { message: error.message, digest: error.digest, stack: error.stack });

    // Send it. A console line only helps someone holding the phone, and these
    // crashes happen to players on mobile with no inspector attached — which is
    // exactly why this one went two rounds of diagnosis on symptoms alone.
    //
    // Best-effort in every direction: no await, failures swallowed. A reporter
    // that can itself throw inside an error boundary would loop.
    try {
      const api = process.env.NEXT_PUBLIC_API_URL;
      if (!api) return;
      // The signed-in wallet, read straight from the persisted store rather than
      // a hook — this component renders outside the app's providers.
      let wallet: string | undefined;
      try {
        const raw = localStorage.getItem('valor-player');
        wallet = raw ? JSON.parse(raw)?.state?.player?.wallet_address : undefined;
      } catch { /* not worth failing a crash report over */ }

      void fetch(`${api}/client-errors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true, // survives the navigation if the player reloads immediately
        body: JSON.stringify({
          message: error.message,
          stack: error.stack,
          digest: error.digest,
          url: window.location.href,
          wallet_address: wallet,
        }),
      }).catch(() => {});
    } catch { /* never let reporting break the error screen */ }
  }, [error]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#04030c',
        color: '#e7e5ea',
        fontFamily: 'Inter, system-ui, sans-serif',
        padding: 24,
        textAlign: 'center',
      }}
    >
      <div style={{ maxWidth: 380 }}>
        <div
          style={{
            fontFamily: 'Cinzel, serif',
            fontWeight: 900,
            letterSpacing: '0.12em',
            fontSize: 22,
            color: '#f4f3f7',
          }}
        >
          VALOR
        </div>
        <p style={{ marginTop: 18, fontSize: 15, lineHeight: 1.5, color: '#b7b4c0' }}>
          {reloading
            ? 'A new version just shipped. Reloading…'
            : chunk
              ? "Couldn't load the latest version. Check your connection and try again."
              : 'Something broke. Give it another go.'}
        </p>
        {!reloading && (
          <button
            onClick={() => (chunk ? window.location.reload() : reset())}
            style={{
              marginTop: 22,
              padding: '12px 28px',
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.14)',
              background: 'linear-gradient(180deg,#2a2740,#171528)',
              color: '#fff',
              fontWeight: 700,
              fontSize: 15,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        )}
        {!reloading && (error.digest || error.message) && (
          <p
            style={{
              marginTop: 18,
              fontSize: 11,
              lineHeight: 1.4,
              color: '#5c5868',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              wordBreak: 'break-word',
            }}
          >
            {error.digest ? `ref ${error.digest}` : error.message.slice(0, 120)}
          </p>
        )}
      </div>
    </div>
  );
}
