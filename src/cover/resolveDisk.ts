import { isTauri } from '@tauri-apps/api/core';
import { coverCacheEnsure } from '@/lib/api/coverCache';
import { invalidateCacheKey } from './imageCache';
import { getDiskSrc, rememberDiskSrc, splitPathVersion } from './diskSrcCache';
import { coverStorageKeyFromRef } from './storageKeys';
import type { CoverArtRef, CoverArtTier } from './types';

/**
 * Full-res / lightbox — Rust WebP on disk (`cover-cache/…/2000.webp`), not IndexedDB.
 *
 * The exact requested tier is mandatory here: the grid disk-src ladder
 * (`getDiskSrcForGrid`) and the Rust cover peek both fall back to a SMALLER
 * already-warmed tier (e.g. a browsed 800) for an unmet request. That is correct
 * for a grid cell, but for the lightbox it pins a downscaled image and never
 * loads full-res — the "cover preview stays small after the first open" bug. So
 * we only accept an exact-tier in-memory hit, and reject a backend hit whose path
 * is a smaller tier, letting the caller fall back to the network full-res URL.
 *
 * Exception: coverless (`_0` sentinel) albums at full-res. Navidrome has no real
 * 2000 for them, the chain writes only display tiers, and the Rust
 * `chain_hit_fullres_redirect` deliberately serves the chain's best ladder tier.
 * Accept that serve — rejecting it sends the caller to a direct Navidrome URL,
 * which serves the vinyl placeholder and bypasses every guard.
 */
export async function ensureCoverTierDiskSrc(
  ref: CoverArtRef,
  tier: CoverArtTier,
): Promise<string> {
  if (!ref.fetchCoverArtId || !isTauri()) return '';

  const storageKey = coverStorageKeyFromRef(ref, tier);
  const cached = getDiskSrc(storageKey);
  if (cached) return cached;

  const result = await coverCacheEnsure(ref, tier, 'high');
  // Results carry `path|mtimeVersion` (cache-bust wire format); test the tier
  // against the bare path.
  const { path: barePath } = splitPathVersion(result.path);
  const exactTier = new RegExp(`[\\\\/]${tier}\\.webp$`).test(barePath);
  // Chain-hit coverless albums (Navidrome `_0` sentinel) never have a real
  // 2000.webp — the chain writes only display tiers, and the vinyl guard
  // forbids downloading a replacement. For full-res requests the backend
  // redirect serves the chain's best ladder tier instead. Accept that serve:
  // rejecting it made the lightbox fall back to a direct Navidrome URL, which
  // serves the vinyl placeholder and bypasses every guard.
  const chainLadderServe =
    tier >= 2000 &&
    ref.cacheKind === 'album' &&
    ref.fetchCoverArtId.endsWith('_0');
  if (!result.hit || !result.path || (!exactTier && !chainLadderServe)) return '';

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
  const storageKey = coverStorageKeyFromRef(ref, tier);
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
