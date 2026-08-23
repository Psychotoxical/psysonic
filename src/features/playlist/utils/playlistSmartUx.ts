import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';
import { isSmartPlaylist } from '@/lib/format/playlistClassification';

type ClassifiablePlaylist = Pick<SubsonicPlaylist, 'name'> & Pick<Partial<SubsonicPlaylist>, 'smart'>;

/** Smart playlist tracks are server-evaluated — clients must not mutate membership. */
export function playlistTracksAreReadOnly(playlist: ClassifiablePlaylist): boolean {
  return isSmartPlaylist(playlist);
}

export function playlistDetailControls(playlist: ClassifiablePlaylist) {
  const tracksReadOnly = playlistTracksAreReadOnly(playlist);
  return {
    tracksReadOnly,
    showEditRules: tracksReadOnly,
    showRefreshTracks: tracksReadOnly,
    canAddTracks: !tracksReadOnly,
    canImportCsv: !tracksReadOnly,
    canReorderTracks: !tracksReadOnly,
    canRemoveTracks: !tracksReadOnly,
    canPinNewOfflineCache: !tracksReadOnly,
  };
}
