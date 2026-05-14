import { useSyncExternalStore } from 'react';

export type PerfProbeFlags = {
  /** On-screen rAF-based FPS counter (Performance Probe). */
  showFpsOverlay: boolean;
  disableWaveformCanvas: boolean;
  disablePlayerProgressUi: boolean;
  disableMarqueeScroll: boolean;
  disableBackdropBlur: boolean;
  disableCssAnimations: boolean;
  disableOverlayScrollbars: boolean;
  disableTooltipPortal: boolean;
  disableQueuePanelMount: boolean;
  disableBackgroundPolling: boolean;
  disableMainRouteContentMount: boolean;
  disableMainstageHero: boolean;
  disableMainstageRails: boolean;
  disableMainstageGridCards: boolean;
  disableMainstageVirtualLists: boolean;
  disableMainstageStickyHeader: boolean;
  disableMainstageHeroBackdrop: boolean;
  disableMainstageRailArtwork: boolean;
  disableMainstageRailInteractivity: boolean;
  disableHomeAlbumRows: boolean;
  disableHomeSongRails: boolean;
  disableHomeRailArtwork: boolean;
  disableHomeArtworkFx: boolean;
  disableHomeArtworkClip: boolean;
};

const STORAGE_KEY = 'psysonic_perf_probe_flags_v1';

const DEFAULT_FLAGS: PerfProbeFlags = {
  showFpsOverlay: false,
  disableWaveformCanvas: false,
  disablePlayerProgressUi: false,
  disableMarqueeScroll: false,
  disableBackdropBlur: false,
  disableCssAnimations: false,
  disableOverlayScrollbars: false,
  disableTooltipPortal: false,
  disableQueuePanelMount: false,
  disableBackgroundPolling: false,
  disableMainRouteContentMount: false,
  disableMainstageHero: false,
  disableMainstageRails: false,
  disableMainstageGridCards: false,
  disableMainstageVirtualLists: false,
  disableMainstageStickyHeader: false,
  disableMainstageHeroBackdrop: false,
  disableMainstageRailArtwork: false,
  disableMainstageRailInteractivity: false,
  disableHomeAlbumRows: false,
  disableHomeSongRails: false,
  disableHomeRailArtwork: false,
  disableHomeArtworkFx: false,
  disableHomeArtworkClip: false,
};

let flags: PerfProbeFlags = { ...DEFAULT_FLAGS };
const listeners = new Set<() => void>();

function safeParseFlags(raw: string | null): Partial<PerfProbeFlags> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<PerfProbeFlags>;
    return parsed ?? {};
  } catch {
    return {};
  }
}

function applyFlagsToDom(next: PerfProbeFlags): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.perfDisableWaveform = next.disableWaveformCanvas ? 'true' : 'false';
  root.dataset.perfDisablePlayerProgressUi = next.disablePlayerProgressUi ? 'true' : 'false';
  root.dataset.perfDisableMarquee = next.disableMarqueeScroll ? 'true' : 'false';
  root.dataset.perfDisableBlur = next.disableBackdropBlur ? 'true' : 'false';
  root.dataset.perfDisableAnimations = next.disableCssAnimations ? 'true' : 'false';
  root.dataset.perfDisableOverlayScroll = next.disableOverlayScrollbars ? 'true' : 'false';
  root.dataset.perfDisableTooltipPortal = next.disableTooltipPortal ? 'true' : 'false';
  root.dataset.perfDisableQueuePanel = next.disableQueuePanelMount ? 'true' : 'false';
  root.dataset.perfDisableBackgroundPolling = next.disableBackgroundPolling ? 'true' : 'false';
  root.dataset.perfDisableMainRoute = next.disableMainRouteContentMount ? 'true' : 'false';
  root.dataset.perfDisableMainstageHero = next.disableMainstageHero ? 'true' : 'false';
  root.dataset.perfDisableMainstageRails = next.disableMainstageRails ? 'true' : 'false';
  root.dataset.perfDisableMainstageGrid = next.disableMainstageGridCards ? 'true' : 'false';
  root.dataset.perfDisableMainstageVirtual = next.disableMainstageVirtualLists ? 'true' : 'false';
  root.dataset.perfDisableMainstageHeader = next.disableMainstageStickyHeader ? 'true' : 'false';
  root.dataset.perfDisableMainstageHeroBackdrop = next.disableMainstageHeroBackdrop ? 'true' : 'false';
  root.dataset.perfDisableMainstageRailArtwork = next.disableMainstageRailArtwork ? 'true' : 'false';
  root.dataset.perfDisableMainstageRailInteractivity = next.disableMainstageRailInteractivity ? 'true' : 'false';
  root.dataset.perfDisableHomeAlbumRows = next.disableHomeAlbumRows ? 'true' : 'false';
  root.dataset.perfDisableHomeSongRails = next.disableHomeSongRails ? 'true' : 'false';
  root.dataset.perfDisableHomeRailArtwork = next.disableHomeRailArtwork ? 'true' : 'false';
  root.dataset.perfDisableHomeArtworkFx = next.disableHomeArtworkFx ? 'true' : 'false';
  root.dataset.perfDisableHomeArtworkClip = next.disableHomeArtworkClip ? 'true' : 'false';
}

function persistFlags(next: PerfProbeFlags): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage errors; runtime state still works.
  }
}

function emit(): void {
  listeners.forEach(fn => fn());
}

function setFlags(next: PerfProbeFlags): void {
  flags = next;
  applyFlagsToDom(flags);
  persistFlags(flags);
  emit();
}

function initFlags(): void {
  if (typeof window === 'undefined') return;
  const fromStorage = safeParseFlags(window.localStorage.getItem(STORAGE_KEY));
  flags = {
    ...DEFAULT_FLAGS,
    ...fromStorage,
  };
  applyFlagsToDom(flags);
}

initFlags();

export function getPerfProbeFlags(): PerfProbeFlags {
  return flags;
}

export function subscribePerfProbeFlags(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function setPerfProbeFlag<K extends keyof PerfProbeFlags>(key: K, value: PerfProbeFlags[K]): void {
  setFlags({ ...flags, [key]: value });
}

export function resetPerfProbeFlags(): void {
  setFlags({ ...DEFAULT_FLAGS });
}

export function usePerfProbeFlags(): PerfProbeFlags {
  return useSyncExternalStore(subscribePerfProbeFlags, getPerfProbeFlags, () => DEFAULT_FLAGS);
}

/** Subscribe to a single probe flag so unrelated toggles do not re-render the consumer. */
export function usePerfProbeFlag<K extends keyof PerfProbeFlags>(key: K): PerfProbeFlags[K] {
  return useSyncExternalStore(
    subscribePerfProbeFlags,
    () => getPerfProbeFlags()[key],
    () => DEFAULT_FLAGS[key],
  );
}
