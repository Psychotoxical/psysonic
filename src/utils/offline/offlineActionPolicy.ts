export type OfflineSurface =
  | 'albumDetail'
  | 'artistDetail'
  | 'albumCard'
  | 'trackRow'
  | 'playlistDetail'
  | 'playlistsHeader'
  | 'contextMenuAlbum'
  | 'contextMenuSong'
  | 'contextMenuArtist'
  | 'contextMenuPlaylist'
  | 'hero'
  | 'statistics'
  | 'playerBar';

export type OfflineActionPolicy = {
  canFavorite: boolean;
  canRate: boolean;
  canDownload: boolean;
  canPinOffline: boolean;
  canCacheDiscography: boolean;
  canAddToPlaylist: boolean;
  canEditPlaylist: boolean;
  canShowBio: boolean;
  canScrobble: boolean;
};

const ALLOW_ALL: OfflineActionPolicy = {
  canFavorite: true,
  canRate: true,
  canDownload: true,
  canPinOffline: true,
  canCacheDiscography: true,
  canAddToPlaylist: true,
  canEditPlaylist: true,
  canShowBio: true,
  canScrobble: true,
};

const READ_ONLY_MUTATIONS: OfflineActionPolicy = {
  canFavorite: false,
  canRate: false,
  canDownload: false,
  canPinOffline: false,
  canCacheDiscography: false,
  canAddToPlaylist: false,
  canEditPlaylist: false,
  canShowBio: false,
  canScrobble: false,
};

/**
 * What server-mutating actions are allowed on a UI surface while offline browse is active.
 * `surface` is reserved for per-surface divergence; today all surfaces share read-only policy.
 */
export function offlineActionPolicy(_surface: OfflineSurface, active: boolean): OfflineActionPolicy {
  if (!active) return ALLOW_ALL;
  return READ_ONLY_MUTATIONS;
}
