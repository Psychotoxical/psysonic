import { isTauri } from '@tauri-apps/api/core';
import { coverCacheEnsure } from '../api/coverCache';
import { invalidateCacheKey } from '../utils/imageCache';
import { getDiskSrc, rememberDiskSrc } from './diskSrcCache';
import { coverStorageKey } from './storageKeys';
import type { CoverArtRef, CoverArtTier } from './types';

/**
 * Full-res / lightbox — Rust WebP on disk (`cover-cache/…/2000.webp`), not IndexedDB.
 */
export async function ensureCoverTierDiskSrc(
  ref: CoverArtRef,
  tier: CoverArtTier,
): Promise<string> {
  if (!ref.coverArtId || !isTauri()) return '';

  const storageKey = coverStorageKey(ref.serverScope, ref.coverArtId, tier);
  const cached = getDiskSrc(storageKey);
  if (cached) return cached;

  const result = await coverCacheEnsure(ref, tier, 'high');
  if (!result.hit || !result.path) return '';

  const src = rememberDiskSrc(storageKey, result.path);
  if (src) {
    void invalidateCacheKey(storageKey);
  }
  return src;
}

/** Blob consumers (export) — read back from disk asset URL after ensure. */
export async function ensureCoverTierDiskBlob(
  ref: CoverArtRef,
  tier: CoverArtTier,
  signal?: AbortSignal,
): Promise<Blob | null> {
  const storageKey = coverStorageKey(ref.serverScope, ref.coverArtId, tier);
  const existing = getDiskSrc(storageKey);
  if (existing) {
    try {
      const resp = await fetch(existing, { signal });
      if (resp.ok) return resp.blob();
    } catch {
      /* fall through to ensure */
    }
  }

  const src = await ensureCoverTierDiskSrc(ref, tier);
  if (!src) return null;
  try {
    const resp = await fetch(src, { signal });
    if (!resp.ok) return null;
    return resp.blob();
  } catch {
    return null;
  }
}
