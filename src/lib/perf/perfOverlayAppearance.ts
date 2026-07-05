import { useSyncExternalStore } from 'react';

export type PerfOverlayCorner = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';

export type PerfOverlayAppearance = {
  corner: PerfOverlayCorner;
  /** Background fill strength 0.25–1 (higher = less transparent). */
  opacity: number;
};

const STORAGE_KEY = 'psysonic_perf_overlay_appearance_v1';

export const PERF_OVERLAY_CORNER_OPTIONS: Array<{ id: PerfOverlayCorner; label: string }> = [
  { id: 'top-right', label: 'Top right' },
  { id: 'top-left', label: 'Top left' },
  { id: 'bottom-right', label: 'Bottom right' },
  { id: 'bottom-left', label: 'Bottom left' },
];

const DEFAULT_APPEARANCE: PerfOverlayAppearance = {
  corner: 'top-right',
  opacity: 0.82,
};

let appearance: PerfOverlayAppearance = { ...DEFAULT_APPEARANCE };
const listeners = new Set<() => void>();

function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_APPEARANCE.opacity;
  return Math.min(1, Math.max(0.25, value));
}

function safeParseAppearance(raw: string | null): Partial<PerfOverlayAppearance> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<PerfOverlayAppearance>;
    return parsed ?? {};
  } catch {
    return {};
  }
}

function isCorner(value: unknown): value is PerfOverlayCorner {
  return value === 'top-right'
    || value === 'top-left'
    || value === 'bottom-right'
    || value === 'bottom-left';
}

function persist(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
  } catch {
    /* ignore */
  }
}

function emit(): void {
  listeners.forEach(fn => fn());
}

function setAppearance(next: PerfOverlayAppearance): void {
  appearance = next;
  persist();
  emit();
}

function init(): void {
  if (typeof window === 'undefined') return;
  const fromStorage = safeParseAppearance(window.localStorage.getItem(STORAGE_KEY));
  appearance = {
    corner: isCorner(fromStorage.corner) ? fromStorage.corner : DEFAULT_APPEARANCE.corner,
    opacity: clampOpacity(fromStorage.opacity ?? DEFAULT_APPEARANCE.opacity),
  };
}

init();

export function getPerfOverlayAppearance(): PerfOverlayAppearance {
  return appearance;
}

export function subscribePerfOverlayAppearance(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function usePerfOverlayAppearance(): PerfOverlayAppearance {
  return useSyncExternalStore(subscribePerfOverlayAppearance, getPerfOverlayAppearance, () => DEFAULT_APPEARANCE);
}

export function setPerfOverlayCorner(corner: PerfOverlayCorner): void {
  setAppearance({ ...appearance, corner });
}

export function setPerfOverlayOpacity(opacity: number): void {
  setAppearance({ ...appearance, opacity: clampOpacity(opacity) });
}

export function resetPerfOverlayAppearance(): void {
  setAppearance({ ...DEFAULT_APPEARANCE });
}

export function perfOverlayCornerClass(corner: PerfOverlayCorner): string {
  return `fps-overlay--${corner}`;
}
