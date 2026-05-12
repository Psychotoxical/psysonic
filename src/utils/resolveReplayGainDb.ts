import type { Track } from '../store/playerStoreTypes';
/**
 * Resolve the ReplayGain dB value for a track based on the configured mode.
 * In 'auto' mode, picks album-gain when an adjacent queue neighbour shares the
 * same albumId (i.e. the track is being played as part of an album), otherwise
 * track-gain. Falls back to track-gain when album-gain is missing.
 */
export function resolveReplayGainDb(
  track: Track,
  prevTrack: Track | null | undefined,
  nextTrack: Track | null | undefined,
  enabled: boolean,
  mode: 'track' | 'album' | 'auto',
): number | null {
  if (!enabled) return null;
  let useAlbum: boolean;
  if (mode === 'album') {
    useAlbum = true;
  } else if (mode === 'track') {
    useAlbum = false;
  } else {
    const albumId = track.albumId;
    useAlbum = !!albumId && (
      prevTrack?.albumId === albumId || nextTrack?.albumId === albumId
    );
  }
  const value = useAlbum
    ? (track.replayGainAlbumDb ?? track.replayGainTrackDb)
    : track.replayGainTrackDb;
  return value ?? null;
}
