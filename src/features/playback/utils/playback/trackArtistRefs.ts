import type { SubsonicOpenArtistRef } from '@/lib/api/subsonicTypes';
import type { Track } from '@/lib/media/trackTypes';
import { coerceOpenArtistRefs, displayArtistRefs } from '@/lib/api/openArtistRefs';

type TrackArtistFields = Pick<Track, 'artist' | 'artistId' | 'artists'>;

/**
 * OpenSubsonic `artists` when present; else the legacy single `artist` string split
 * on the separators the server itself uses, so "Alice feat. Bob" reads as two credits
 * instead of one. Rows ingested without the structured list (the bulk initial-sync
 * path stores only the flat tags) therefore still show individual artists — the first
 * one linked, the guests as plain text.
 */
export function resolveTrackArtistRefs(track: TrackArtistFields): SubsonicOpenArtistRef[] {
  const structured = coerceOpenArtistRefs(track.artists);
  if (structured.length > 0) {
    return structured;
  }
  const split = displayArtistRefs(track.artist, track.artistId);
  if (split.length > 0) {
    return split;
  }
  // No usable name at all — keep a single ref so callers can render their own
  // fallback text (`a.name ?? song.artist`) instead of an empty cell.
  return [{ name: track.artist }];
}

/** First performer ref — used for artist bio / discography / top songs on Now Playing. */
export function primaryTrackArtistRef(track: TrackArtistFields): SubsonicOpenArtistRef {
  return resolveTrackArtistRefs(track)[0];
}
