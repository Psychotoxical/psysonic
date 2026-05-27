import {
  libraryReconcileAlbumStars,
  libraryReconcileArtistStars,
} from '../../api/library';
import { getStarred } from '../../api/subsonicStarRating';
import { useLibraryIndexStore } from '../../store/libraryIndexStore';
import { libraryIsReady } from './libraryReady';

/**
 * Align local `album.starred_at` with getStarred2 (server source of truth).
 * Does not insert stub rows — browse lists should still load from the network.
 */
export async function reconcileAlbumStarsFromServer(
  serverId: string | null | undefined,
): Promise<void> {
  if (!serverId || !(await libraryIsReady(serverId))) return;
  if (!useLibraryIndexStore.getState().isIndexEnabled(serverId)) return;
  const { albums } = await getStarred();
  await libraryReconcileAlbumStars({
    serverId,
    starredAlbumIds: albums.map(a => a.id),
  });
}

/** Align local `artist.starred_at` with getStarred2. */
export async function reconcileArtistStarsFromServer(
  serverId: string | null | undefined,
): Promise<void> {
  if (!serverId || !(await libraryIsReady(serverId))) return;
  if (!useLibraryIndexStore.getState().isIndexEnabled(serverId)) return;
  const { artists } = await getStarred();
  await libraryReconcileArtistStars({
    serverId,
    starredArtistIds: artists.map(a => a.id),
  });
}
