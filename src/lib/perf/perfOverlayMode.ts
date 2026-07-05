import { useSyncExternalStore } from 'react';
import type { PerfProbeFlags } from '@/lib/perf/perfFlags';

export type PerfOverlayMode = 'off' | 'fps' | 'pinned';

export type ResolvedOverlayVisibility = {
  showFps: boolean;
  showAnalysis: boolean;
  showCover: boolean;
  showLive: boolean;
};

const STORAGE_KEY = 'psysonic_perf_overlay_mode_v1';

export const PERF_OVERLAY_MODE_OPTIONS: Array<{ id: PerfOverlayMode; label: string }> = [
  { id: 'off', label: 'Off' },
  { id: 'fps', label: 'FPS only' },
  { id: 'pinned', label: 'Pinned' },
];

const DEFAULT_MODE: PerfOverlayMode = 'off';

let mode: PerfOverlayMode = DEFAULT_MODE;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach(fn => fn());
}

function isPerfOverlayMode(value: unknown): value is PerfOverlayMode {
  return value === 'off' || value === 'fps' || value === 'pinned';
}

function inferLegacyMode(): PerfOverlayMode {
  if (typeof window === 'undefined') return DEFAULT_MODE;
  try {
    const flagsRaw = window.localStorage.getItem('psysonic_perf_probe_flags_v1');
    const pinsRaw = window.localStorage.getItem('psysonic_perf_overlay_pins_v1');
    const flags = flagsRaw ? JSON.parse(flagsRaw) as Partial<PerfProbeFlags> : {};
    const pins = pinsRaw ? JSON.parse(pinsRaw) as unknown : [];
    const anyFlag = Boolean(
      flags.showFpsOverlay || flags.showAnalysisPerfOverlay || flags.showCoverPerfOverlay,
    );
    const anyPin = Array.isArray(pins) && pins.length > 0;
    return anyFlag || anyPin ? 'pinned' : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

function initMode(): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (isPerfOverlayMode(raw)) {
      mode = raw;
      return;
    }
    mode = inferLegacyMode();
  } catch {
    mode = DEFAULT_MODE;
  }
}

initMode();

export function getPerfOverlayMode(): PerfOverlayMode {
  return mode;
}

export function setPerfOverlayMode(next: PerfOverlayMode): void {
  if (next === mode) return;
  mode = next;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }
  emit();
}

export function resetPerfOverlayMode(): void {
  setPerfOverlayMode(DEFAULT_MODE);
}

export function subscribePerfOverlayMode(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function usePerfOverlayMode(): PerfOverlayMode {
  return useSyncExternalStore(subscribePerfOverlayMode, getPerfOverlayMode, () => DEFAULT_MODE);
}

export function resolveOverlayVisibility(
  overlayMode: PerfOverlayMode,
  flags: Pick<PerfProbeFlags, 'showFpsOverlay' | 'showAnalysisPerfOverlay' | 'showCoverPerfOverlay'>,
  liveOverlayItemCount: number,
): ResolvedOverlayVisibility {
  if (overlayMode === 'off') {
    return { showFps: false, showAnalysis: false, showCover: false, showLive: false };
  }
  if (overlayMode === 'fps') {
    return { showFps: true, showAnalysis: false, showCover: false, showLive: false };
  }
  return {
    showFps: flags.showFpsOverlay,
    showAnalysis: flags.showAnalysisPerfOverlay,
    showCover: flags.showCoverPerfOverlay,
    showLive: liveOverlayItemCount > 0,
  };
}
