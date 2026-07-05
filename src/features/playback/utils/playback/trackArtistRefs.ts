import type { SubsonicOpenArtistRef } from '@/lib/api/subsonicTypes';
import type { Track } from '@/lib/media/trackTypes';
import { coerceOpenArtistRefs } from '@/lib/api/openArtistRefs';

type TrackArtistFields = Pick<Track, 'artist' | 'artistId' | 'artists'>;

/** OpenSubsonic `artists` when present; else legacy `artistId` + `artist` (album track rows). */
export function resolveTrackArtistRefs(track: TrackArtistFields): SubsonicOpenArtistRef[] {
  const structured = coerceOpenArtistRefs(track.artists);
  if (structured.length > 0) {
    return structured;
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
