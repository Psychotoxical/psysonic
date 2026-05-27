import { convertFileSrc, isTauri } from '@tauri-apps/api/core';
import { coverIndexKeyFromScope } from './storageKeys';
import type { CoverServerScope } from './types';

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

function isAssetProtocolUrl(url: string): boolean {
  return url.startsWith('asset:') || /^https?:\/\/asset\.localhost/i.test(url);
}

/** Windows: forward slashes before `convertFileSrc` (tauri#7970). */
function normalizePathForConvert(fsPath: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(fsPath)) {
    return fsPath.replace(/\\/g, '/');
  }
  return fsPath;
}

/** True when `convertFileSrc` failed and returned the filesystem path unchanged. */
function isRawFsPath(url: string, fsPath: string): boolean {
  if (url === fsPath) return true;
  if (url.startsWith('/') && fsPath.startsWith('/')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(fsPath)) {
    const norm = fsPath.replace(/\\/g, '/');
    const urlNorm = url.replace(/\\/g, '/');
    // `endsWith(norm)`: convertFileSrc passthrough; `norm.endsWith(urlNorm)`: partial URL match.
    if (urlNorm === norm || urlNorm.endsWith(norm) || norm.endsWith(urlNorm)) {
      return !isAssetProtocolUrl(url);
    }
  }
  return false;
}

/**
 * Turn a Rust disk path into a webview-loadable URL.
 * Returns empty when not in Tauri or path is outside asset scope (never put raw paths in `<img src>`).
 */
function tryCoverDiskUrl(fsPath: string): string {
  const paths = fsPath.includes('\\')
    ? [normalizePathForConvert(fsPath), fsPath]
    : [fsPath, normalizePathForConvert(fsPath)];
  const seen = new Set<string>();
  for (const p of paths) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    const src = convertFileSrc(p);
    if (!src || isRawFsPath(src, p) || isRawFsPath(src, fsPath)) continue;
    return src;
  }
  return '';
}

export function coverDiskUrl(fsPath: string): string {
  if (!fsPath || !isTauri()) return '';
  const src = tryCoverDiskUrl(fsPath);
  if (!src && import.meta.env.DEV) {
    console.warn('[cover] convertFileSrc out of asset scope — check tauri.conf assetProtocol', {
      fsPath,
      src: convertFileSrc(normalizePathForConvert(fsPath)),
    });
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

export function forgetDiskSrcPrefix(ref: {
  serverScope: CoverServerScope;
  cacheKind: string;
  cacheEntityId: string;
}): void {
  const serverIndexKey = coverIndexKeyFromScope(ref.serverScope);
  const prefix = `${serverIndexKey}:cover:${ref.cacheKind}:${ref.cacheEntityId}:`;
  let changed = false;
  for (const key of diskSrcByStorageKey.keys()) {
    if (key.startsWith(prefix)) {
      diskSrcByStorageKey.delete(key);
      changed = true;
    }
  }
  if (changed) bumpDiskSrcCache();
}

/**
 * Drop every cached disk-src under a server index key (all cover ids, all
 * tiers). Used by the URL-change remigration `cover:bucket-renamed` listener
 * so entries pointing at the now-renamed `{root}/{oldKey}/…` path stop
 * serving stale URLs.
 */
export function forgetDiskSrcForServer(serverIndexKey: string): void {
  if (!serverIndexKey) return;
  const prefix = `${serverIndexKey}:cover:`;
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
