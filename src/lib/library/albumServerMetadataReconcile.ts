import { getAlbumForServer } from '@/lib/api/subsonicLibrary';
import { parseSubsonicEntityStarRating } from '@/lib/api/subsonicRatings';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import { patchLibraryAlbumOnUse } from '@/lib/library/patchOnUse';

export type AlbumServerMetadataPatch = {
  userRating: number;
  starred?: string;
};

export function albumIsStarred(album: SubsonicAlbum): boolean {
  return !!album.starred;
}

export function albumUserRating(album: SubsonicAlbum): number {
  return parseSubsonicEntityStarRating(album) ?? 0;
}

/** Compare index/local album metadata with a fresh `#getAlbum` body. */
export function diffAlbumServerMetadata(
  local: SubsonicAlbum,
  server: SubsonicAlbum,
): AlbumServerMetadataPatch | null {
  const serverRating = albumUserRating(server);
  const localRating = albumUserRating(local);
  const serverStarred = albumIsStarred(server);
  const localStarred = albumIsStarred(local);
  if (serverRating === localRating && serverStarred === localStarred) return null;
  return {
    userRating: serverRating,
    starred: server.starred,
  };
}

export function applyAlbumServerMetadataPatch(
  album: SubsonicAlbum,
  patch: AlbumServerMetadataPatch,
): SubsonicAlbum {
  return {
    ...album,
    userRating: patch.userRating > 0 ? patch.userRating : undefined,
    starred: patch.starred,
  };
}

/** Persist reconciled album favorite into the index (reconcile skips getAlbum mirror). */
export function patchAlbumStarToIndexFromReconcile(
  serverId: string,
  albumId: string,
  patch: AlbumServerMetadataPatch,
): void {
  if (!patch.starred) {
    patchLibraryAlbumOnUse(serverId, albumId, { starredAt: null });
    return;
  }
  const parsed = Date.parse(patch.starred);
  patchLibraryAlbumOnUse(serverId, albumId, {
    starredAt: Number.isFinite(parsed) ? parsed : Date.now(),
  });
}

/**
 * Fetch album metadata from the server and return a patch when starred /
 * userRating differ from `local`. `getAlbumForServer` mirrors into the index.
 */
export async function fetchAlbumServerMetadataPatch(
  serverId: string,
  albumId: string,
  local: SubsonicAlbum,
): Promise<AlbumServerMetadataPatch | null> {
  const { album: server } = await getAlbumForServer(serverId, albumId, { mirrorToIndex: false });
  return diffAlbumServerMetadata(local, server);
}
