import { coverCachePeekBatch } from '../api/coverCache';
import { diskCoverArtIdCandidates, type DiskCoverIdHints } from './diskPeekIds';
import { coverIndexKeyFromRef, coverStorageKey } from './storageKeys';
import type { CoverArtRef, CoverArtTier } from './types';

async function peekFirstPath(
  ref: CoverArtRef,
  tier: CoverArtTier,
  serverIndexKey: string,
  ids: string[],
): Promise<string> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return '';
  const hits = await coverCachePeekBatch(
    unique.map(coverArtId => ({ serverIndexKey, coverArtId, tier })),
  );
  for (const coverArtId of unique) {
    const key = coverStorageKey(ref.serverScope, coverArtId, tier);
    if (hits[key]) return hits[key]!;
  }
  return '';
}

/**
 * Disk-only: Subsonic may return `mf-*` while `cover-cache` only has `al-*` (backfill).
 * Try the Subsonic id first, then promote to `albumId` when the mf folder is missing.
 */
export async function peekCoverPathOnDisk(
  ref: CoverArtRef,
  tier: CoverArtTier,
  hints?: DiskCoverIdHints,
): Promise<string> {
  const serverIndexKey = coverIndexKeyFromRef(ref);
  const primary = ref.coverArtId.trim();
  if (!primary) return '';

  const pathForPrimary = await peekFirstPath(ref, tier, serverIndexKey, [primary]);
  if (pathForPrimary) return pathForPrimary;

  const albumId = hints?.albumId?.trim();
  if (primary.startsWith('mf-') && albumId?.startsWith('al-') && albumId !== primary) {
    const pathForAlbum = await peekFirstPath(ref, tier, serverIndexKey, [albumId]);
    if (pathForAlbum) return pathForAlbum;
  }

  const rest = diskCoverArtIdCandidates(primary, hints).filter(
    id => id !== primary && id !== albumId,
  );
  return peekFirstPath(ref, tier, serverIndexKey, rest);
}
