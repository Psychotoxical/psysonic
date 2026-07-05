import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import type { OfflineAlbumMeta } from '@/features/offline/store/offlineStore';
import { countFavoriteAutoTracks, hasAnyOfflineAlbums } from '@/features/offline/utils/offlineLibraryHelpers';

/** Saved servers with a local library index (cross-server favorites scope). */
export function favoritesServerIds(): string[] {
  const { servers } = useAuthStore.getState();
  const idx = useLibraryIndexStore.getState();
  return idx.indexedServerIds(servers.map(s => s.id));
}

/** Favorites page may be browsed offline when auto-save is enabled and any index exists. */
export function favoritesOfflineBrowseEnabled(): boolean {
  const auth = useAuthStore.getState();
  if (!auth.favoritesOfflineEnabled) return false;
  return favoritesServerIds().length > 0;
}

/** Any offline browsing surface: manual pins and/or saved favorite-auto bytes. */
export function hasOfflineBrowsingContent(
  offlineAlbums: Record<string, OfflineAlbumMeta>,
): boolean {
  if (hasAnyOfflineAlbums(offlineAlbums)) return true;
  if (favoritesOfflineBrowseEnabled() && countFavoriteAutoTracks() > 0) return true;
  return false;
}
