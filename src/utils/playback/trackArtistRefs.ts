import type { SubsonicOpenArtistRef } from '../../api/subsonicTypes';
import type { Track } from '../../store/playerStoreTypes';

type TrackArtistFields = Pick<Track, 'artist' | 'artistId' | 'artists'>;

/** OpenSubsonic `artists` when present; else legacy `artistId` + `artist` (album track rows). */
export function resolveTrackArtistRefs(track: TrackArtistFields): SubsonicOpenArtistRef[] {
  if (track.artists && track.artists.length > 0) {
    return track.artists;
  }
  const id = track.artistId?.trim();
  if (id) {
    return [{ id, name: track.artist }];
  }
  return [{ name: track.artist }];
}

/** First performer ref — used for artist bio / discography / top songs on Now Playing. */
export function primaryTrackArtistRef(track: TrackArtistFields): SubsonicOpenArtistRef {
  return resolveTrackArtistRefs(track)[0];
}
