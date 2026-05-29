import { useSyncExternalStore } from 'react';

export const PERF_LIVE_POLL_MS_DEFAULT = 2000;
export const PERF_LIVE_POLL_MS_MIN = 500;
export const PERF_LIVE_POLL_MS_MAX = 10_000;
export const PERF_LIVE_POLL_MS_STEP = 500;

const STORAGE_KEY = 'psysonic_perf_live_poll_ms_v1';

const listeners = new Set<() => void>();
let pollIntervalMs = PERF_LIVE_POLL_MS_DEFAULT;
let includeThreadGroups = false;
let scheduleBump: (() => void) | null = null;

function requestScheduleBump(): void {
  scheduleBump?.();
}

function emit(): void {
  listeners.forEach(fn => fn());
}

function clampPollMs(value: number): number {
  if (!Number.isFinite(value)) return PERF_LIVE_POLL_MS_DEFAULT;
  const stepped = Math.round(value / PERF_LIVE_POLL_MS_STEP) * PERF_LIVE_POLL_MS_STEP;
  return Math.min(PERF_LIVE_POLL_MS_MAX, Math.max(PERF_LIVE_POLL_MS_MIN, stepped));
}

function initPollInterval(): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw == null) return;
    pollIntervalMs = clampPollMs(Number(raw));
  } catch {
    /* ignore */
  }
}

initPollInterval();

export function getPerfLivePollIntervalMs(): number {
  return pollIntervalMs;
}

export function setPerfLivePollIntervalMs(ms: number): void {
  const next = clampPollMs(ms);
  if (next === pollIntervalMs) return;
  pollIntervalMs = next;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      /* ignore */
    }
  }
  emit();
  requestScheduleBump();
}

export function registerPerfLivePollScheduleBump(fn: () => void): void {
  scheduleBump = fn;
}

export function subscribePerfLivePollInterval(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function usePerfLivePollIntervalMs(): number {
  return useSyncExternalStore(subscribePerfLivePollInterval, getPerfLivePollIntervalMs, () => PERF_LIVE_POLL_MS_DEFAULT);
}

export function getPerfLiveIncludeThreadGroups(): boolean {
  return includeThreadGroups;
}

export function setPerfLiveIncludeThreadGroups(next: boolean): void {
  if (next === includeThreadGroups) return;
  includeThreadGroups = next;
  requestScheduleBump();
}

/** Thread groups when the Monitor section is open or a thread metric is pinned. */
export function syncPerfLiveThreadGroupsNeed(
  sectionOpen: boolean,
  pins: ReadonlySet<string>,
): void {
  const pinnedThread = [...pins].some(pin => pin.startsWith('cpu:thread:'));
  setPerfLiveIncludeThreadGroups(sectionOpen || pinnedThread);
}

export type PerfCpuSnapshotRequest = {
  include_thread_groups: boolean;
};

export function buildPerfCpuSnapshotRequest(): PerfCpuSnapshotRequest {
  return { include_thread_groups: includeThreadGroups };
}
