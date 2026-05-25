/** Listeners for Rust `cover:tier-ready` — keyed by IDB storage key. */

type DiskReadyListener = (path: string) => void;

const listeners = new Map<string, Set<DiskReadyListener>>();

export function subscribeCoverDiskReady(storageKey: string, onReady: DiskReadyListener): () => void {
  let set = listeners.get(storageKey);
  if (!set) {
    set = new Set();
    listeners.set(storageKey, set);
  }
  set.add(onReady);
  return () => {
    const s = listeners.get(storageKey);
    if (!s) return;
    s.delete(onReady);
    if (s.size === 0) listeners.delete(storageKey);
  };
}

export function hasCoverDiskReadyListeners(storageKey: string): boolean {
  const set = listeners.get(storageKey);
  return !!set && set.size > 0;
}

export function notifyCoverDiskReady(storageKey: string, path: string): void {
  const set = listeners.get(storageKey);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(path);
    } catch {
      /* ignore */
    }
  }
}
