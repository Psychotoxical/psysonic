export type OfflineSurface =
  | 'albumDetail'
  | 'artistDetail'
  | 'albumCard'
  | 'trackRow'
  | 'playlistDetail'
  | 'playlistsHeader'
  | 'contextMenuAlbum'
  | 'contextMenuSong'
  | 'hero'
  | 'statistics';

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

/** What server-mutating actions are allowed on a UI surface while offline browse is active. */
export function offlineActionPolicy(surface: OfflineSurface, active: boolean): OfflineActionPolicy {
  if (!active) return ALLOW_ALL;

  switch (surface) {
    case 'albumDetail':
    case 'artistDetail':
    case 'trackRow':
    case 'albumCard':
    case 'playlistDetail':
    case 'playlistsHeader':
    case 'contextMenuAlbum':
    case 'contextMenuSong':
    case 'hero':
      return READ_ONLY_MUTATIONS;
    case 'statistics':
      return { ...READ_ONLY_MUTATIONS, canScrobble: false };
    default:
      return READ_ONLY_MUTATIONS;
  }
}

/** Convenience for components that previously used `readOnly={offlineBrowseActive}`. */
export function isOfflineReadOnlySurface(surface: OfflineSurface, active: boolean): boolean {
  if (!active) return false;
  const p = offlineActionPolicy(surface, active);
  return !p.canFavorite && !p.canDownload && !p.canPinOffline;
}
