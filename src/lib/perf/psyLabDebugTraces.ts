import { useSyncExternalStore } from 'react';
import { commands } from '@/generated/bindings';

/** Per-page debug trace toggles (PsyLab → Toggles). Extend as more pages get traces. */
export type PsyLabDebugTraceId = 'albumsBrowse' | 'artistsBrowse' | 'favoritesBrowse' | 'tracksBrowse' | 'mainstage';

export type PsyLabDebugTraces = Record<PsyLabDebugTraceId, boolean>;

const STORAGE_KEY = 'psysonic_psylab_debug_traces_v1';

const DEFAULT_TRACES: PsyLabDebugTraces = {
  albumsBrowse: false,
  artistsBrowse: false,
  favoritesBrowse: false,
  tracksBrowse: false,
  mainstage: false,
};

let traces: PsyLabDebugTraces = { ...DEFAULT_TRACES };
let runtimeOverrides: Partial<PsyLabDebugTraces> = {};
let traceRevision = 0;
const listeners = new Set<() => void>();

function emit(): void {
  traceRevision += 1;
  listeners.forEach(fn => fn());
}

function persistTraces(next: PsyLabDebugTraces): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage errors; runtime state still works.
  }
}

function syncTraceToBackend(id: PsyLabDebugTraceId, enabled: boolean): Promise<void> {
  if (id === 'albumsBrowse') {
    return commands.setPsylabAlbumsBrowseTrace(enabled).then(() => {}).catch(() => {});
  } else if (id === 'artistsBrowse') {
    return commands.setPsylabArtistsBrowseTrace(enabled).then(() => {}).catch(() => {});
  }
  return Promise.resolve();
}

function setTraces(next: PsyLabDebugTraces): void {
  traces = next;
  persistTraces(traces);
  emit();
}

function safeParseTraces(raw: string | null): Partial<PsyLabDebugTraces> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<PsyLabDebugTraces>;
    return parsed ?? {};
  } catch {
    return {};
  }
}

/** Restore persisted traces and synchronize native trace flags before React mounts. */
export function initializePsyLabDebugTraces(): void {
  if (typeof window === 'undefined') return;
  const fromStorage = safeParseTraces(window.localStorage.getItem(STORAGE_KEY));
  traces = { ...DEFAULT_TRACES, ...fromStorage };
  for (const id of Object.keys(DEFAULT_TRACES) as PsyLabDebugTraceId[]) {
    void syncTraceToBackend(id, traces[id]);
  }
}

export function getPsyLabDebugTraces(): PsyLabDebugTraces {
  return traces;
}

export function subscribePsyLabDebugTraces(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function refreshPsyLabDebugTraceSubscribers(): void {
  emit();
}

export function isPsyLabDebugTraceEnabled(id: PsyLabDebugTraceId): boolean {
  return runtimeOverrides[id] ?? traces[id];
}

export function getPsyLabDebugTraceOverrides(): Partial<PsyLabDebugTraces> {
  return { ...runtimeOverrides };
}

/** Runtime-only trace overrides for automated diagnostics; never persist or alter the PsyLab UI. */
export function setPsyLabDebugTraceOverrides(next: Partial<PsyLabDebugTraces> | null): Promise<void> {
  runtimeOverrides = next ? { ...next } : {};
  emit();
  return Promise.all((Object.keys(DEFAULT_TRACES) as PsyLabDebugTraceId[]).map(id => (
    syncTraceToBackend(id, isPsyLabDebugTraceEnabled(id))
  ))).then(() => {});
}

export function setPsyLabDebugTrace(id: PsyLabDebugTraceId, enabled: boolean): void {
  if (traces[id] === enabled) return;
  const next = { ...traces, [id]: enabled };
  setTraces(next);
  void syncTraceToBackend(id, isPsyLabDebugTraceEnabled(id));
}

export function resetPsyLabDebugTraces(): void {
  setTraces({ ...DEFAULT_TRACES });
  for (const id of Object.keys(DEFAULT_TRACES) as PsyLabDebugTraceId[]) {
    void syncTraceToBackend(id, isPsyLabDebugTraceEnabled(id));
  }
}

export function usePsyLabDebugTraces(): PsyLabDebugTraces {
  return useSyncExternalStore(subscribePsyLabDebugTraces, getPsyLabDebugTraces, () => DEFAULT_TRACES);
}

export function usePsyLabDebugTraceEnabled(id: PsyLabDebugTraceId): boolean {
  return useSyncExternalStore(
    subscribePsyLabDebugTraces,
    () => isPsyLabDebugTraceEnabled(id),
    () => DEFAULT_TRACES[id],
  );
}

export function usePsyLabDebugTraceRevision(): number {
  return useSyncExternalStore(subscribePsyLabDebugTraces, () => traceRevision, () => 0);
}
