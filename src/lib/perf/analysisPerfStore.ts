import { useSyncExternalStore } from 'react';

export type AnalysisTrackPerfSample = {
  trackId: string;
  fetchMs: number;
  seedMs: number;
  bpmMs: number;
  totalMs: number;
  at: number;
};

type AnalysisPerfState = {
  last: AnalysisTrackPerfSample | null;
  completedAt: number[];
};

/** Completion-timestamp retention (kept generous; the live rate uses a shorter window). */
const WINDOW_MS = 60_000;
/**
 * Throughput is measured over the trailing few seconds only — a full-minute
 * average has too much inertia and flattens real bursts/stalls. The count in
 * this window is extrapolated to a per-minute figure for display.
 */
const RATE_WINDOW_MS = 5_000;

let state: AnalysisPerfState = { last: null, completedAt: [] };
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach(fn => fn());
}

function pruneCompletedAt(now: number): number[] {
  const cutoff = now - WINDOW_MS;
  return state.completedAt.filter(t => t >= cutoff);
}

export function recordAnalysisTrackPerf(payload: {
  trackId: string;
  fetchMs: number;
  seedMs: number;
  bpmMs: number;
  totalMs: number;
}): void {
  const now = Date.now();
  const completedAt = [...pruneCompletedAt(now), now];
  state = {
    completedAt,
    last: {
      trackId: payload.trackId,
      fetchMs: payload.fetchMs,
      seedMs: payload.seedMs,
      bpmMs: payload.bpmMs,
      totalMs: payload.totalMs,
      at: now,
    },
  };
  emit();
}

/** Tracks analyzed per minute, measured over the trailing few seconds (0 when idle). */
export function getAnalysisTracksPerMinute(now = Date.now()): number {
  const cutoff = now - RATE_WINDOW_MS;
  const count = state.completedAt.filter(t => t >= cutoff).length;
  if (count === 0) return 0;
  return (count / RATE_WINDOW_MS) * 60_000;
}

export function getAnalysisPerfState(): AnalysisPerfState {
  return state;
}

export function subscribeAnalysisPerf(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Last completed track sample — stable reference until the next completion. */
export function useAnalysisPerfLast(): AnalysisTrackPerfSample | null {
  return useSyncExternalStore(
    subscribeAnalysisPerf,
    () => state.last,
    () => null,
  );
}

/** Test-only reset. */
export function resetAnalysisPerfStateForTest(): void {
  state = { last: null, completedAt: [] };
  emit();
}

export function formatPerfMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}
