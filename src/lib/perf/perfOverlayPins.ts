import { useSyncExternalStore } from 'react';
import { clearPerfLiveHistory } from '@/lib/perf/perfLiveHistory';
import { perfLiveCpuSnapshotSupported } from '@/lib/perf/perfLiveCpuSnapshot';
import { getPerfOverlayMode } from '@/lib/perf/perfOverlayMode';
import { getPerfProbeFlags, setPerfProbeFlag, subscribePerfProbeFlags } from '@/lib/perf/perfFlags';

const STORAGE_KEY = 'psysonic_perf_overlay_pins_v1';

/** Overlay pin ids for live monitor metrics (CPU, memory, UI rates). */
export type PerfLiveOverlayPinId =
  | 'cpu:app'
  | 'cpu:webkit'
  | `cpu:thread:${string}`
  | `mem:${string}`
  | 'rate:progress'
  | 'rate:waveform'
  | 'rate:home'
  | 'analysis:tpm'
  | 'analysis:last'
  | 'cover:cpm'
  | 'cover:cpm:ui';

const PIPELINE_PIN_TO_FLAG = {
  'pipeline:fps': 'showFpsOverlay',
  'pipeline:analysis': 'showAnalysisPerfOverlay',
  'pipeline:cover': 'showCoverPerfOverlay',
} as const;

export type PerfPipelineOverlayPinId = keyof typeof PIPELINE_PIN_TO_FLAG;

export type PerfOverlayPinId = PerfLiveOverlayPinId | PerfPipelineOverlayPinId;

let livePins = new Set<string>();
const liveListeners = new Set<() => void>();

function safeParsePins(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function persistLivePins(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...livePins]));
  } catch {
    /* ignore */
  }
}

function emitLive(): void {
  liveListeners.forEach(fn => fn());
}

function initLivePins(): void {
  if (typeof window === 'undefined') return;
  livePins = new Set(safeParsePins(window.localStorage.getItem(STORAGE_KEY)));
}

initLivePins();

export function getPerfLiveOverlayPins(): ReadonlySet<string> {
  return livePins;
}

export function subscribePerfLiveOverlayPins(cb: () => void): () => void {
  liveListeners.add(cb);
  return () => liveListeners.delete(cb);
}

export function usePerfLiveOverlayPins(): ReadonlySet<string> {
  return useSyncExternalStore(subscribePerfLiveOverlayPins, getPerfLiveOverlayPins, () => new Set());
}

export function isPerfLiveOverlayPinned(id: string): boolean {
  return livePins.has(id);
}

export function togglePerfLiveOverlayPin(id: PerfLiveOverlayPinId): void {
  if (livePins.has(id)) {
    livePins.delete(id);
    clearPerfLiveHistory(id);
  } else {
    livePins.add(id);
  }
  persistLivePins();
  emitLive();
}

export function clearPerfLiveOverlayPins(): void {
  livePins.clear();
  clearPerfLiveHistory();
  persistLivePins();
  emitLive();
}

export function isPipelineOverlayPinned(id: PerfPipelineOverlayPinId): boolean {
  const flag = PIPELINE_PIN_TO_FLAG[id];
  return getPerfProbeFlags()[flag];
}

export function togglePipelineOverlayPin(id: PerfPipelineOverlayPinId): void {
  const flag = PIPELINE_PIN_TO_FLAG[id];
  setPerfProbeFlag(flag, !getPerfProbeFlags()[flag]);
}

export function usePipelineOverlayPinned(id: PerfPipelineOverlayPinId): boolean {
  return useSyncExternalStore(
    subscribePerfProbeFlags,
    () => getPerfProbeFlags()[PIPELINE_PIN_TO_FLAG[id]],
    () => false,
  );
}

export function hasAnyPerfOverlayVisible(): boolean {
  const overlayMode = getPerfOverlayMode();
  if (overlayMode === 'off') return false;
  if (overlayMode === 'fps') return true;
  const flags = getPerfProbeFlags();
  return (
    flags.showFpsOverlay
    || flags.showAnalysisPerfOverlay
    || flags.showCoverPerfOverlay
    || livePins.size > 0
  );
}

function livePinsNeedJsPoll(pins: ReadonlySet<string>): boolean {
  for (const id of pins) {
    if (id.startsWith('rate:') || id.startsWith('analysis:') || id.startsWith('cover:')) return true;
  }
  return false;
}

export function hasAnyLiveMetricPollNeed(): boolean {
  if (getPerfOverlayMode() !== 'pinned') return false;
  if (livePins.size === 0) return false;
  if (perfLiveCpuSnapshotSupported()) return true;
  return livePinsNeedJsPoll(livePins);
}
