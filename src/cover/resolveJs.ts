import { isTauri } from '@tauri-apps/api/core';
import { getCachedBlob } from './imageCache';
import { ensureCoverTierDiskBlob } from './resolveDisk';
import {
  parseCoverCacheKey,
  probeSiblingCoverBlobFromIDB,
  probeSiblingCoverBlobInMemory,
  scheduleSiblingVersusNetworkRace,
} from './imageCache/coverSiblings';
import { blobCache } from './imageCache/blobCache';
import { downscaleCoverBlob } from '@/cover/coverBlobDownscale';
import { rememberBlob } from './imageCache/blobCache';
import { putBlob } from './imageCache/idbStore';
import { buildCoverArtFetchUrl } from './fetchUrl';
import { coverServerReachable } from './reachability';
import { coverStorageKeyFromRef } from './storageKeys';
import type { CoverArtRef, CoverArtTier } from './types';

const CANONICAL_TIER = 800 as CoverArtTier;

async function commitNormalizedTier(
  cacheKey: string,
  blob: Blob,
  tier: CoverArtTier,
  signal?: AbortSignal,
): Promise<Blob> {
  const normalized = await downscaleCoverBlob(blob, tier, signal);
  const out = normalized && normalized.size < blob.size * 0.92 ? normalized : blob;
  putBlob(cacheKey, out);
  rememberBlob(cacheKey, out);
  return out;
}

/**
 * Cold resolve: race canonical 800 chain vs direct tier fetch (§5.3).
 */
async function scheduleColdCoverRace(
  ref: CoverArtRef,
  tier: CoverArtTier,
  signal: AbortSignal | undefined,
  getPriority?: () => number,
): Promise<Blob | null> {
  const targetKey = coverStorageKeyFromRef(ref, tier);
  const canonicalKey = coverStorageKeyFromRef(ref, CANONICAL_TIER);
  const chainCtl = new AbortController();
  const directCtl = new AbortController();
  let winner = false;

  const kill = () => {
    chainCtl.abort();
    directCtl.abort();
  };
  signal?.addEventListener('abort', kill, { once: true });

  const tryWin = async (blob: Blob | null, key: string, normalizeTo: CoverArtTier) => {
    if (!blob || winner || signal?.aborted) return;
    winner = true;
    kill();
    const committed = await commitNormalizedTier(key, blob, normalizeTo, signal);
    if (key !== targetKey && normalizeTo === tier) {
      await commitNormalizedTier(targetKey, committed, tier, signal);
    }
    if (key === canonicalKey || normalizeTo === CANONICAL_TIER) {
      rememberBlob(canonicalKey, committed);
    }
    return committed;
  };

  const chainBranch = (async () => {
    const url = buildCoverArtFetchUrl(ref, CANONICAL_TIER);
    const blob = await getCachedBlob(url, canonicalKey, signal, getPriority);
    if (!blob || winner || signal?.aborted) return;
    await tryWin(blob, canonicalKey, CANONICAL_TIER);
    if (tier !== CANONICAL_TIER && !winner) {
      const derived = await downscaleCoverBlob(blob, tier, signal);
      if (derived) await tryWin(derived, targetKey, tier);
    }
  })();

  const directBranch = (async () => {
    const url = buildCoverArtFetchUrl(ref, tier);
    const blob = await getCachedBlob(url, targetKey, signal, getPriority);
    if (blob) await tryWin(blob, targetKey, tier);
  })();

  await Promise.allSettled([chainBranch, directBranch]);
  return blobCache.get(targetKey) ?? null;
}

/**
 * Ensure tier blob exists; run §5 races from implementation-spec.
 */
export async function ensureCoverTierJs(
  ref: CoverArtRef,
  tier: CoverArtTier,
  signal?: AbortSignal,
  getPriority?: () => number,
): Promise<Blob | null> {
  if (!ref.fetchCoverArtId || signal?.aborted) return null;

  const cacheKey = coverStorageKeyFromRef(ref, tier);
  const mem = blobCache.get(cacheKey);
  if (mem) return mem;

  const fetchUrl = buildCoverArtFetchUrl(ref, tier);
  const parsed = parseCoverCacheKey(cacheKey);
  if (parsed) {
    const provisional =
      probeSiblingCoverBlobInMemory(parsed.stem, parsed.size) ??
      (await probeSiblingCoverBlobFromIDB(parsed.stem, parsed.size));
    if (provisional && !signal?.aborted) {
      rememberBlob(cacheKey, provisional);
      if (coverServerReachable(ref.serverScope)) {
        scheduleSiblingVersusNetworkRace(fetchUrl, cacheKey, provisional, signal, getPriority);
      }
      return provisional;
    }
  }

  if (!coverServerReachable(ref.serverScope)) {
    return null;
  }

  if (tier === 2000) {
    if (isTauri()) {
      return ensureCoverTierDiskBlob(ref, tier, signal);
    }
    return getCachedBlob(buildCoverArtFetchUrl(ref, 2000), cacheKey, signal, getPriority);
  }

  const canonicalKey = coverStorageKeyFromRef(ref, CANONICAL_TIER);
  const hasChain =
    blobCache.has(canonicalKey) ||
    (parsed && (await probeSiblingCoverBlobFromIDB(parsed.stem, parsed.size)) !== null);

  if (!hasChain && tier !== CANONICAL_TIER) {
    return scheduleColdCoverRace(ref, tier, signal, getPriority);
  }

  return getCachedBlob(fetchUrl, cacheKey, signal, getPriority);
}
