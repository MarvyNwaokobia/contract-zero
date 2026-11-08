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

  // Log it, and put a short identifier on screen so a screenshot carries the one
  // detail that makes a report actionable.
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[contract-zero] route error', { message: error.message, digest: error.digest, stack: error.stack });
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
          CONTRACT ZERO
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
