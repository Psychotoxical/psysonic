import { useSyncExternalStore } from 'react';
import {
  isLiveHistoryPin,
  liveOverlayItemValue,
} from '@/lib/perf/formatLiveOverlayItems';
import type { PerfLiveSnapshot } from '@/lib/perf/perfLiveStore';

const HISTORY_MS = 60_000;
const EMPTY_VALUES: readonly number[] = [];
const EMPTY_SAMPLES: readonly Sample[] = [];

export type PerfLiveSample = {
  readonly at: number;
  readonly value: number;
};

type Sample = PerfLiveSample;

const series = new Map<string, Sample[]>();
const valueCache = new Map<string, { source: Sample[]; values: readonly number[] }>();
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach(fn => fn());
}

function trim(samples: Sample[], now: number): Sample[] {
  const cutoff = now - HISTORY_MS;
  let start = 0;
  while (start < samples.length && samples[start].at < cutoff) start += 1;
  return start > 0 ? samples.slice(start) : samples;
}

function appendSample(id: string, value: number, at: number): boolean {
  if (!Number.isFinite(value)) return false;
  const existing = series.get(id) ?? [];
  const last = existing[existing.length - 1];
  if (last && last.value === value) return false;
  const appended =
    last && last.at === at
      ? [...existing.slice(0, -1), { at, value }]
      : [...existing, { at, value }];
  const next = trim(appended, at);
  series.set(id, next);
  valueCache.delete(id);
  return true;
}

export function recordPerfLiveHistory(id: string, value: number, at = Date.now()): void {
  if (appendSample(id, value, at)) emit();
}

/** Record pinned live samples for one poll tick. */
export function syncPerfLiveHistoryFromPoll(
  pins: Iterable<string>,
  live: PerfLiveSnapshot,
  options?: { emit?: boolean },
): void {
  if (!live.cpu?.supported || live.sampleAt <= 0) return;
  let changed = false;
  for (const pin of pins) {
    if (!isLiveHistoryPin(pin)) continue;
    const value = liveOverlayItemValue(pin, live);
    if (value != null && appendSample(pin, value, live.sampleAt)) changed = true;
  }
  if (changed && options?.emit !== false) emit();
}

export function getPerfLiveHistoryClock(ids: Iterable<string>): number {
  let latest = 0;
  for (const id of ids) {
    const samples = series.get(id);
    const last = samples?.[samples.length - 1];
    if (last && last.at > latest) latest = last.at;
  }
  return latest;
}

export function getPerfLiveHistorySamples(id: string): readonly PerfLiveSample[] {
  const now = Date.now();
  let samples = series.get(id) ?? [];
  const trimmed = trim(samples, now);
  if (trimmed.length !== samples.length) {
    samples = trimmed;
    series.set(id, samples);
  }
  return samples.length === 0 ? EMPTY_SAMPLES : samples;
}

export function getPerfLiveHistory(id: string): readonly number[] {
  const now = Date.now();
  let samples = series.get(id) ?? [];
  const trimmed = trim(samples, now);
  if (trimmed.length !== samples.length) {
    samples = trimmed;
    series.set(id, samples);
  }
  if (samples.length === 0) return EMPTY_VALUES;

  const cached = valueCache.get(id);
  if (cached && cached.source === samples) return cached.values;

  const values: readonly number[] = samples.map(s => s.value);
  valueCache.set(id, { source: samples, values });
  return values;
}

export function clearPerfLiveHistory(id?: string): void {
  if (id) {
    series.delete(id);
    valueCache.delete(id);
  } else {
    series.clear();
    valueCache.clear();
  }
  emit();
}

export function subscribePerfLiveHistory(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function usePerfLiveHistorySamples(id: string): readonly PerfLiveSample[] {
  return useSyncExternalStore(
    subscribePerfLiveHistory,
    () => getPerfLiveHistorySamples(id),
    () => EMPTY_SAMPLES,
  );
}

export function usePerfLiveHistory(id: string): readonly number[] {
  return useSyncExternalStore(
    subscribePerfLiveHistory,
    () => getPerfLiveHistory(id),
    () => EMPTY_VALUES,
  );
}

export const PERF_LIVE_HISTORY_MS = HISTORY_MS;
