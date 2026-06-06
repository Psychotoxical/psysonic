export type AnalysisStorageChangedReason =
  | 'offline-delete'
  | 'hotcache-delete'
  | 'hotcache-purge'
  | 'local-playback-delete'
  | 'offline-purge'
  | 'favorites-offline-purge';

export type AnalysisStorageChangedDetail = {
  trackId?: string | null;
  reason: AnalysisStorageChangedReason;
};

const EVENT_NAME = 'psysonic:analysis-storage-changed';

export function emitAnalysisStorageChanged(detail: AnalysisStorageChangedDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<AnalysisStorageChangedDetail>(EVENT_NAME, { detail }));
}

export function onAnalysisStorageChanged(
  listener: (detail: AnalysisStorageChangedDetail) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const wrapped = (evt: Event) => {
    const ce = evt as CustomEvent<AnalysisStorageChangedDetail>;
    if (!ce?.detail) return;
    listener(ce.detail);
  };
  window.addEventListener(EVENT_NAME, wrapped as EventListener);
  return () => window.removeEventListener(EVENT_NAME, wrapped as EventListener);
}
