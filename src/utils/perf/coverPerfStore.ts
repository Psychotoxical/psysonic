import { useSyncExternalStore } from 'react';

/**
 * Cover-pipeline throughput store — the cover analogue of `analysisPerfStore`.
 *
 * Two independent throughput series share the one-minute rolling window:
 *   - **lib**: the native backfill worker emits cumulative `done` (covers
 *     cached) on `cover:library-progress`; we sample it and derive the delta
 *     rate, mirroring analysis tpm.
 *   - **ui**: on-demand cover ensures (grid/now-playing) are counted natively —
 *     the backend exposes a cumulative `uiEnsuredTotal` in the pipeline stats;
 *     we sample it and derive the delta rate, exactly like lib. Sourcing the
 *     count in Rust avoids the webview ensure-queue dedup/HMR pitfalls that made
 *     a JS-side counter unreliable.
 */
export type CoverProgressSample = {
  at: number;
  done: number;
};

type CoverTotalSample = {
  at: number;
  total: number;
};

type CoverPerfState = {
  samples: CoverProgressSample[];
  done: number;
  total: number;
  pending: number;
  /** Cumulative on-demand (UI) ensure totals sampled from the backend (rolling window). */
  uiSamples: CoverTotalSample[];
};

/** Sample-retention window (kept generous so backwards-jump detection is robust). */
const WINDOW_MS = 60_000;
/**
 * Rate is measured over the trailing few seconds only — a full-minute average
 * has too much inertia and flattens real bursts/stalls. We still extrapolate to
 * a per-minute figure for display.
 */
const RATE_WINDOW_MS = 5_000;

let state: CoverPerfState = { samples: [], done: 0, total: 0, pending: 0, uiSamples: [] };
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach(fn => fn());
}

function pruneSamples(now: number, samples: readonly CoverProgressSample[]): CoverProgressSample[] {
  const cutoff = now - WINDOW_MS;
  return samples.filter(s => s.at >= cutoff);
}

function pruneTotals(now: number, samples: readonly CoverTotalSample[]): CoverTotalSample[] {
  const cutoff = now - WINDOW_MS;
  return samples.filter(s => s.at >= cutoff);
}

export function recordCoverProgress(payload: {
  done: number;
  total?: number;
  pending?: number;
}): void {
  const now = Date.now();
  const done = Math.max(0, Math.floor(payload.done));
  let samples = pruneSamples(now, state.samples);
  // A backwards jump means a different pass (server switch / cache clear) — start
  // a fresh window so the old baseline doesn't inflate or zero out the rate.
  if (samples.length > 0 && done < samples[samples.length - 1].done) {
    samples = [];
  }
  samples = [...samples, { at: now, done }];
  state = {
    ...state,
    samples,
    done,
    total: payload.total ?? state.total,
    pending: payload.pending ?? state.pending,
  };
  emit();
}

/** Sample the backend's cumulative on-demand (UI) ensure total. */
export function recordCoverUiTotal(total: number): void {
  const now = Date.now();
  const next = Math.max(0, Math.floor(total));
  let uiSamples = pruneTotals(now, state.uiSamples);
  // A backwards jump means the process restarted — drop the stale baseline.
  if (uiSamples.length > 0 && next < uiSamples[uiSamples.length - 1].total) {
    uiSamples = [];
  }
  uiSamples = [...uiSamples, { at: now, total: next }];
  state = { ...state, uiSamples };
  emit();
}

/**
 * Per-minute rate from a cumulative-counter series, measured over the trailing
 * `RATE_WINDOW_MS`. Returns 0 when fewer than two recent samples are available
 * (so a stalled pipeline drops to 0 within the window instead of coasting).
 */
function recentRatePerMinute<T extends { at: number }>(
  now: number,
  samples: readonly T[],
  valueOf: (sample: T) => number,
): number {
  const cutoff = now - RATE_WINDOW_MS;
  const recent = samples.filter(s => s.at >= cutoff);
  if (recent.length < 2) return 0;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const delta = Math.max(0, valueOf(last) - valueOf(first));
  if (delta === 0) return 0;
  const spanMs = Math.max(1, last.at - first.at);
  return (delta / spanMs) * 60_000;
}

/** Covers cached per minute, averaged over the trailing few seconds (0 when idle). */
export function getCoverCachedPerMinute(now = Date.now()): number {
  return recentRatePerMinute(now, state.samples, s => s.done);
}

/** On-demand UI covers produced per minute, averaged over the trailing few seconds. */
export function getCoverUiPerMinute(now = Date.now()): number {
  return recentRatePerMinute(now, state.uiSamples, s => s.total);
}

export function getCoverPerfState(): CoverPerfState {
  return state;
}

export function subscribeCoverPerf(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useCoverPerfState(): CoverPerfState {
  return useSyncExternalStore(subscribeCoverPerf, getCoverPerfState, () => state);
}

/** Test-only reset. */
export function resetCoverPerfStateForTest(): void {
  state = { samples: [], done: 0, total: 0, pending: 0, uiSamples: [] };
  emit();
}
