import { useSyncExternalStore } from 'react';

/**
 * Cover-pipeline throughput store — the cover analogue of `analysisPerfStore`.
 *
 * The backfill worker emits cumulative `done` (covers cached) on the
 * `cover:library-progress` event. We sample `done` over a rolling one-minute
 * window and derive covers-per-minute (cpm), mirroring analysis tpm.
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
};

const WINDOW_MS = 60_000;

let state: CoverPerfState = { samples: [], done: 0, total: 0, pending: 0 };
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach(fn => fn());
}

function pruneSamples(now: number, samples: readonly CoverProgressSample[]): CoverProgressSample[] {
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
    samples,
    done,
    total: payload.total ?? state.total,
    pending: payload.pending ?? state.pending,
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
  state = { samples: [], done: 0, total: 0, pending: 0 };
  emit();
}
