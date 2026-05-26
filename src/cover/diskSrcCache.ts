import { convertFileSrc, isTauri } from '@tauri-apps/api/core';

/** Stable asset URLs for disk `.webp` tiers — survives route unmount. */
const diskSrcByStorageKey = new Map<string, string>();

let cacheGeneration = 0;
const cacheListeners = new Set<() => void>();

function bumpDiskSrcCache(): void {
  cacheGeneration += 1;
  for (const fn of cacheListeners) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

/** Re-render `useCoverArt` when warm/peek seeds this map (no wait for ensure queue). */
export function subscribeDiskSrcCache(onStoreChange: () => void): () => void {
  cacheListeners.add(onStoreChange);
  return () => cacheListeners.delete(onStoreChange);
}

export function getDiskSrcCacheGeneration(): number {
  return cacheGeneration;
}

/** True when `convertFileSrc` failed and returned the filesystem path unchanged. */
function isRawFsPath(url: string, fsPath: string): boolean {
  return url === fsPath || (url.startsWith('/') && fsPath.startsWith('/'));
}

/**
 * Turn a Rust disk path into a webview-loadable URL.
 * Returns empty when not in Tauri or path is outside asset scope (never put raw paths in `<img src>`).
 */
export function coverDiskUrl(fsPath: string): string {
  if (!fsPath || !isTauri()) return '';
  const src = convertFileSrc(fsPath);
  if (isRawFsPath(src, fsPath)) {
    if (import.meta.env.DEV) {
      console.warn('[cover] convertFileSrc out of asset scope — check tauri.conf assetProtocol', fsPath);
    }
    return '';
  }
  return src;
}

export function rememberDiskSrc(storageKey: string, fsPath: string): string {
  if (!storageKey || !fsPath) return '';
  const src = coverDiskUrl(fsPath);
  if (!src) return '';
  const prev = diskSrcByStorageKey.get(storageKey);
  if (prev === src) return src;
  diskSrcByStorageKey.set(storageKey, src);
  bumpDiskSrcCache();
  return src;
}

export function getDiskSrc(storageKey: string): string {
  return diskSrcByStorageKey.get(storageKey) ?? '';
}

export function forgetDiskSrc(storageKey: string): void {
  if (diskSrcByStorageKey.delete(storageKey)) bumpDiskSrcCache();
}

export function forgetDiskSrcPrefix(serverIndexKey: string, coverArtId: string): void {
  const prefix = `${serverIndexKey}:cover:${coverArtId}:`;
  let changed = false;
  for (const key of diskSrcByStorageKey.keys()) {
    if (key.startsWith(prefix)) {
      diskSrcByStorageKey.delete(key);
      changed = true;
    }
  }
  if (changed) bumpDiskSrcCache();
}

export function clearAllDiskSrcCache(): void {
  if (diskSrcByStorageKey.size === 0) return;
  diskSrcByStorageKey.clear();
  bumpDiskSrcCache();
}

export function clearDiskSrcCacheForServer(serverIndexKey: string): void {
  const prefix = `${serverIndexKey}:cover:`;
  let changed = false;
  for (const key of [...diskSrcByStorageKey.keys()]) {
    if (key.startsWith(prefix)) {
      diskSrcByStorageKey.delete(key);
      changed = true;
    }
  }
  if (changed) bumpDiskSrcCache();
}
