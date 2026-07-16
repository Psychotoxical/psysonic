import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';

export type BecauseYouLikeAnchor = { id: string; name: string };

export type BecauseYouLikeSnapshot = {
  serverId: string;
  filterVersion: number;
  savedAt: number;
  anchor: BecauseYouLikeAnchor;
  recs: SubsonicAlbum[];
};

const TTL_MS = 15 * 60 * 1000;
let snapshot: BecauseYouLikeSnapshot | null = null;

export function readBecauseYouLikeCache(
  serverId: string | null | undefined,
  filterVersion: number,
): BecauseYouLikeSnapshot | null {
  if (!serverId || !snapshot) return null;
  if (snapshot.serverId !== serverId || snapshot.filterVersion !== filterVersion) return null;
  if (Date.now() - snapshot.savedAt > TTL_MS) return null;
  return snapshot;
}

export function writeBecauseYouLikeCache(
  data: Omit<BecauseYouLikeSnapshot, 'savedAt'>,
): void {
  snapshot = { ...data, savedAt: Date.now() };
}

export function clearBecauseYouLikeCache(): void {
  snapshot = null;
}
