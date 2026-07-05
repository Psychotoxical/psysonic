import { useSyncExternalStore } from 'react';
import { commands } from '@/generated/bindings';

/** Per-page debug trace toggles (PsyLab → Toggles). Extend as more pages get traces. */
export type PsyLabDebugTraceId = 'albumsBrowse' | 'artistsBrowse';

export type PsyLabDebugTraces = Record<PsyLabDebugTraceId, boolean>;

const STORAGE_KEY = 'psysonic_psylab_debug_traces_v1';

const DEFAULT_TRACES: PsyLabDebugTraces = {
  albumsBrowse: false,
  artistsBrowse: false,
};

let traces: PsyLabDebugTraces = { ...DEFAULT_TRACES };
const listeners = new Set<() => void>();

function emit(): void {
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

function syncTraceToBackend(id: PsyLabDebugTraceId, enabled: boolean): void {
  if (id === 'albumsBrowse') {
    void commands.setPsylabAlbumsBrowseTrace(enabled).catch(() => {});
  } else if (id === 'artistsBrowse') {
    void commands.setPsylabArtistsBrowseTrace(enabled).catch(() => {});
  }
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

function initTraces(): void {
  if (typeof window === 'undefined') return;
  const fromStorage = safeParseTraces(window.localStorage.getItem(STORAGE_KEY));
  traces = { ...DEFAULT_TRACES, ...fromStorage };
  for (const id of Object.keys(DEFAULT_TRACES) as PsyLabDebugTraceId[]) {
    syncTraceToBackend(id, traces[id]);
  }
}

initTraces();

export function getPsyLabDebugTraces(): PsyLabDebugTraces {
  return traces;
}

export function subscribePsyLabDebugTraces(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function isPsyLabDebugTraceEnabled(id: PsyLabDebugTraceId): boolean {
  return traces[id];
}

export function setPsyLabDebugTrace(id: PsyLabDebugTraceId, enabled: boolean): void {
  if (traces[id] === enabled) return;
  const next = { ...traces, [id]: enabled };
  setTraces(next);
  syncTraceToBackend(id, enabled);
}

export function resetPsyLabDebugTraces(): void {
  setTraces({ ...DEFAULT_TRACES });
  for (const id of Object.keys(DEFAULT_TRACES) as PsyLabDebugTraceId[]) {
    syncTraceToBackend(id, false);
  }
}

export function usePsyLabDebugTraces(): PsyLabDebugTraces {
  return useSyncExternalStore(subscribePsyLabDebugTraces, getPsyLabDebugTraces, () => DEFAULT_TRACES);
}
