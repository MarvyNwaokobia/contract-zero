'use client';

import { useEffect, useState } from 'react';
import { Cinzel } from 'next/font/google';
import { isChunkLoadError, hardReloadForChunkError } from '@/lib/retryImport';

// global-error replaces the whole document — including the layout's font <link> —
// so the brand face must be self-contained. next/font self-hosts Cinzel (inlined
// @font-face served from our own origin), so the wordmark renders correctly here
// without a network round-trip to Google at the moment the app is already broken.
const cinzel = Cinzel({ subsets: ['latin'], weight: ['900'], display: 'swap' });

/**
 * Root error boundary — the last line of defence. It replaces the whole document
 * when even the layout throws, so it renders its own <html>/<body>.
 *
 * The case that used to burn users: a game chunk fails to load (stale deploy or a
 * stalled fetch on a weak connection) and Next's raw "Loading chunk NNNN failed"
 * screen appears with no way out. Here we detect that and self-heal with a single
 * hard reload; anything else gets a branded retry screen instead of a dead end.
 *
 * If that reload is suppressed (once-per-window guard already fired — offline, or
 * a genuinely broken deploy), we drop the "Reloading…" message and show a manual
 * button so the user is never stranded.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const chunk = isChunkLoadError(error);
  const [reloading, setReloading] = useState(chunk);

  useEffect(() => {
    if (chunk && !hardReloadForChunkError()) setReloading(false);
  }, [chunk]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#04030c',
          color: '#e7e5ea',
          fontFamily: 'Inter, system-ui, sans-serif',
          padding: '24px',
          textAlign: 'center',
        }}
      >
        <div style={{ maxWidth: 380 }}>
          <div
            className={cinzel.className}
            style={{
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
              ? 'A new version just shipped. Reloading to get you back in the fight…'
              : chunk
                ? "Couldn't load the latest version. Check your connection and try again."
                : 'Something broke while loading the game.'}
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
        </div>
      </body>
    </html>
  );
}
