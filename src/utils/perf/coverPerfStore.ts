import { useSyncExternalStore } from 'react';

/**
 * Cover-pipeline throughput store — the cover analogue of `analysisPerfStore`.
 *
 * Two independent throughput series share the one-minute rolling window:
 *   - **lib**: the native backfill worker emits cumulative `done` (covers
 *     cached) on `cover:library-progress`; we sample it and derive the delta
 *     rate, mirroring analysis tpm.
 *   - **ui**: on-demand cover ensures (grid/now-playing) resolve through the
 *     webview ensure queue; each completed Rust ensure records a timestamp and
 *     we count them per minute.
 */
export type CoverProgressSample = {
  at: number;
  done: number;
};

type CoverPerfState = {
  samples: CoverProgressSample[];
  done: number;
  total: number;
  pending: number;
  /** Completion timestamps of on-demand UI cover ensures (rolling window). */
  uiCompletedAt: number[];
};

const WINDOW_MS = 60_000;

let state: CoverPerfState = { samples: [], done: 0, total: 0, pending: 0, uiCompletedAt: [] };
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach(fn => fn());
}

function pruneSamples(now: number, samples: readonly CoverProgressSample[]): CoverProgressSample[] {
  const cutoff = now - WINDOW_MS;
  return samples.filter(s => s.at >= cutoff);
}

function pruneTimestamps(now: number, times: readonly number[]): number[] {
  const cutoff = now - WINDOW_MS;
  return times.filter(t => t >= cutoff);
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

/** Record a completed on-demand (UI) cover ensure. */
export function recordCoverUiEnsure(): void {
  const now = Date.now();
  state = {
    ...state,
    uiCompletedAt: [...pruneTimestamps(now, state.uiCompletedAt), now],
  };
  emit();
}

/** Covers cached per minute over the rolling window (0 when idle). */
export function getCoverCachedPerMinute(now = Date.now()): number {
  const samples = pruneSamples(now, state.samples);
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const delta = Math.max(0, last.done - first.done);
  if (delta === 0) return 0;
  const spanMs = Math.max(1, Math.min(WINDOW_MS, now - first.at));
  return (delta / spanMs) * WINDOW_MS;
}

/** On-demand UI cover ensures completed per minute over the rolling window. */
export function getCoverUiPerMinute(now = Date.now()): number {
  const times = pruneTimestamps(now, state.uiCompletedAt);
  if (times.length === 0) return 0;
  const spanMs = Math.max(1, Math.min(WINDOW_MS, now - times[0]));
  return (times.length / spanMs) * WINDOW_MS;
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
  state = { samples: [], done: 0, total: 0, pending: 0, uiCompletedAt: [] };
  emit();
}
