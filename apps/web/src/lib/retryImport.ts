'use client';

/**
 * Chunk-load resilience for the heavy game bundles.
 *
 * The 3D scenes (ValorScene / GameScene) ship as large dynamic chunks — three.js
 * + fiber + drei + postprocessing all land in one file. On weak / mobile networks
 * that single fetch can stall past webpack's chunk-load timeout, and after a
 * redeploy an old open tab can reference a chunk hash the CDN has since aged out.
 * Either way `next/dynamic` has no built-in retry, so one failed fetch used to
 * dead-end on Next's raw "Loading chunk NNNN failed" screen with no recovery.
 *
 * This wraps a dynamic import so it:
 *   1. retries the fetch a few times with backoff (rides out a transient stall),
 *   2. and if it still can't load a chunk, does a single hard reload — fresh HTML
 *      points at the current chunk names, which fixes the stale-deploy case.
 */

/** True for the webpack / Next chunk-loading failures we can recover from. */
export function isChunkLoadError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: string; message?: string; code?: string };
  const name = e.name ?? '';
  const message = e.message ?? '';
  return (
    name === 'ChunkLoadError' ||
    e.code === 'CSS_CHUNK_LOAD_FAILED' ||
    /Loading (CSS )?chunk [\d]+ failed/i.test(message) ||
    /Loading chunk .* failed/i.test(message) ||
    /import\(\).*(failed|timeout)/i.test(message)
  );
}

/**
 * True for a chunk failure caused by the request stalling past the browser's
 * chunk-load timeout (the "(timeout: ...)" case), as opposed to a fast 404.
 * These are the ones we must NOT retry: a retry just waits out that same long
 * timeout window again, turning a bad load into a multi-minute stall.
 */
export function isTimeoutChunkError(err: unknown): boolean {
  if (!isChunkLoadError(err)) return false;
  const message = (err as { message?: string }).message ?? '';
  return /timeout/i.test(message);
}

const RELOAD_KEY = 'valor:chunk-reload-at';

// In-memory guard: stops a second auto-reload within the SAME page load (before
// any reload has actually navigated away). It resets to false on a real reload,
// so it can't by itself prevent a cross-reload loop — that's what the persisted
// timestamp is for.
let reloadedThisLoad = false;

/** Last auto-reload time in ms, or null if storage is unavailable (can't tell). */
function readLastReload(): number | null {
  try {
    return Number(window.sessionStorage.getItem(RELOAD_KEY) ?? '0');
  } catch {
    return null;
  }
}

/** Persist the auto-reload time; false if storage refused the write. */
function writeLastReload(ts: number): boolean {
  try {
    window.sessionStorage.setItem(RELOAD_KEY, String(ts));
    return true;
  } catch {
    return false;
  }
}

/**
 * Force a one-time hard reload to recover from an unreachable chunk, but never
 * more than once per window — so a genuinely offline device shows the error
 * boundary instead of thrashing in a reload loop.
 *
 * The loop guard depends on remembering the reload across the reload itself,
 * which needs sessionStorage. If storage is blocked (some private/locked-down
 * browsers), we CANNOT safely auto-reload — an in-memory flag resets on reload,
 * so we'd loop forever. In that case we bail and let the boundary show a manual
 * button instead. Returns true only when a reload was actually triggered.
 */
export function hardReloadForChunkError(): boolean {
  if (typeof window === 'undefined') return false;
  if (reloadedThisLoad) return false;

  const last = readLastReload();
  // Storage unavailable: no reliable way to prevent a reload loop → don't reload.
  if (last === null) return false;
  // Already reloaded within the guard window → don't reload again.
  if (Number.isFinite(last) && Date.now() - last < 15_000) return false;
  // Can read but not write → still can't record this reload, so don't risk it.
  if (!writeLastReload(Date.now())) return false;

  reloadedThisLoad = true;
  window.location.reload();
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry a dynamic import on chunk-load failure. Webpack 5 clears the failed
 * chunk from its registry on rejection, so re-calling the factory genuinely
 * re-fetches.
 *
 * The retry budget is deliberately small (ONE quick attempt). Each browser
 * chunk-load attempt already waits out a long internal timeout before it
 * rejects, so a bigger budget would multiply that wait into minutes — the exact
 * slow-connection users we're helping would suffer most. So:
 *   - a TIMEOUT failure (the request stalled) skips retries entirely and goes
 *     straight to a hard reload — re-attempting would just stall again;
 *   - any other chunk failure (typically a fast 404 from a stale deploy, or a
 *     transient blip) gets one quick retry, then a hard reload.
 * The reload returns a never-resolving promise so nothing renders mid-navigation.
 * Non-chunk errors are re-thrown for the boundary to handle.
 */
export function retryImport<T>(
  factory: () => Promise<T>,
  retries = 1,
  backoffMs = 500,
): Promise<T> {
  return factory().catch(async (err) => {
    if (!isChunkLoadError(err)) throw err;
    // A stalled request or an exhausted budget: reload rather than re-wait.
    if (isTimeoutChunkError(err) || retries <= 0) {
      if (hardReloadForChunkError()) {
        // The reload is taking over — hang so nothing renders in the meantime.
        return new Promise<T>(() => {});
      }
      throw err;
    }
    await sleep(backoffMs);
    return retryImport(factory, retries - 1, backoffMs);
  });
}

// Warm a heavy scene chunk at most once per page load, on idle, ignoring errors.
// Called from the pre-fight screens (on intent) so only players actually heading
// into a fight pay the multi-MB download — not every visitor. Entering the fight
// then hits a warm cache instead of a cold, blocking fetch.
const warmed = new Set<string>();

function warmChunk(key: string, load: () => Promise<unknown>): void {
  if (typeof window === 'undefined' || warmed.has(key)) return;
  warmed.add(key);
  const run = () => { load().catch(() => {}); };
  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
  }).requestIdleCallback;
  if (ric) ric(run, { timeout: 4000 });
  else setTimeout(run, 800);
}

/** Preload the first-person /fight scene (ValorScene). */
export function warmFightScene(): void {
  warmChunk('valor-scene', () => import('@/engine/scene/ValorScene'));
}

/** Preload the legacy scene used by /endless and /fight-legacy (GameScene). */
export function warmGameScene(): void {
  warmChunk('game-scene', () => import('@/engine/scene/GameScene'));
}
