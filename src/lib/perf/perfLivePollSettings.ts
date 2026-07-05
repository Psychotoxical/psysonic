import { useSyncExternalStore } from 'react';

export const PERF_LIVE_POLL_MS_DEFAULT = 2000;
export const PERF_LIVE_POLL_MS_MIN = 500;
export const PERF_LIVE_POLL_MS_MAX = 10_000;
export const PERF_LIVE_POLL_MS_STEP = 500;

const STORAGE_KEY = 'psysonic_perf_live_poll_ms_v1';
const THREAD_GROUPS_STORAGE_KEY = 'psysonic_perf_live_thread_groups_v1';

const listeners = new Set<() => void>();
const threadGroupListeners = new Set<() => void>();
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

function initThreadGroups(): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(THREAD_GROUPS_STORAGE_KEY);
    if (raw == null) return;
    includeThreadGroups = raw === '1' || raw === 'true';
  } catch {
    /* ignore */
  }
}

initPollInterval();
initThreadGroups();

function emitThreadGroups(): void {
  threadGroupListeners.forEach(fn => fn());
}

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
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(THREAD_GROUPS_STORAGE_KEY, next ? '1' : '0');
    } catch {
      /* ignore */
    }
  }
  emitThreadGroups();
  requestScheduleBump();
}

export function subscribePerfLiveIncludeThreadGroups(cb: () => void): () => void {
  threadGroupListeners.add(cb);
  return () => threadGroupListeners.delete(cb);
}

export function usePerfLiveIncludeThreadGroups(): boolean {
  return useSyncExternalStore(
    subscribePerfLiveIncludeThreadGroups,
    getPerfLiveIncludeThreadGroups,
    () => false,
  );
}

export type PerfCpuSnapshotRequest = {
  includeThreadGroups: boolean;
};

export function buildPerfCpuSnapshotRequest(): PerfCpuSnapshotRequest {
  return { includeThreadGroups };
}
