import { useEffect, useState } from 'react';
import { lastfmGetSimilarArtists, lastfmIsConfigured } from '../api/lastfm';
import { search } from '../api/subsonicSearch';
import type { SubsonicArtist, SubsonicArtistInfo } from '../api/subsonicTypes';
import { useAuthStore } from '../store/authStore';

export interface ArtistSimilarArtistsResult {
  similarArtists: SubsonicArtist[];
  similarLoading: boolean;
}

/**
 * Resolves the "Similar Artists" list for the current artist:
 *   - Default: Last.fm getSimilar → server search for each name → keep first exact match.
 *   - With audiomuseNavidromeEnabled on: prefer info.similarArtist; fall back to Last.fm
 *     when the server returns nothing and Last.fm is configured.
 */
export function useArtistSimilarArtists(
  artist: SubsonicArtist | null,
  info: SubsonicArtistInfo | null,
  artistInfoLoading: boolean,
): ArtistSimilarArtistsResult {
  const audiomuseNavidromeEnabled = useAuthStore(
    s => !!(s.activeServerId && s.audiomuseNavidromeByServer[s.activeServerId]),
  );
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);

  const [similarArtists, setSimilarArtists] = useState<SubsonicArtist[]>([]);
  const [similarLoading, setSimilarLoading] = useState(false);

  useEffect(() => {
    if (!artist || audiomuseNavidromeEnabled || !lastfmIsConfigured()) return;
    setSimilarArtists([]);
    setSimilarLoading(true);
    lastfmGetSimilarArtists(artist.name).then(async names => {
      if (names.length === 0) { setSimilarLoading(false); return; }
      const results = await Promise.all(
        names.slice(0, 30).map(name =>
          search(name, { artistCount: 3, albumCount: 0, songCount: 0 }).catch(() => ({ artists: [], albums: [], songs: [] }))
        )
      );
      const seen = new Set<string>([artist.id]);
      const found: SubsonicArtist[] = [];
      for (let i = 0; i < results.length; i++) {
        const targetName = names[i].toLowerCase();
        const match = results[i].artists.find(a => a.name.toLowerCase() === targetName);
        if (match && !seen.has(match.id)) {
          seen.add(match.id);
          found.push(match);
        }
      }
      setSimilarArtists(found);
      setSimilarLoading(false);
    }).catch(() => setSimilarLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artist?.id, musicLibraryFilterVersion, audiomuseNavidromeEnabled]);

  /** When AudioMuse is on but the server returns no similar artists, fall back to Last.fm (if configured). */
  useEffect(() => {
    if (!artist || !audiomuseNavidromeEnabled || !lastfmIsConfigured()) return;
    if (artistInfoLoading) return;
    if ((info?.similarArtist?.length ?? 0) > 0) return;

    setSimilarArtists([]);
    setSimilarLoading(true);
    lastfmGetSimilarArtists(artist.name).then(async names => {
      if (names.length === 0) { setSimilarLoading(false); return; }
      const results = await Promise.all(
        names.slice(0, 30).map(name =>
          search(name, { artistCount: 3, albumCount: 0, songCount: 0 }).catch(() => ({ artists: [], albums: [], songs: [] }))
        )
      );
      const seen = new Set<string>([artist.id]);
      const found: SubsonicArtist[] = [];
      for (let i = 0; i < results.length; i++) {
        const targetName = names[i].toLowerCase();
        const match = results[i].artists.find(a => a.name.toLowerCase() === targetName);
        if (match && !seen.has(match.id)) {
          seen.add(match.id);
          found.push(match);
        }
      }
      setSimilarArtists(found);
      setSimilarLoading(false);
    }).catch(() => setSimilarLoading(false));
  }, [
    artist?.id,
    artist?.name,
    musicLibraryFilterVersion,
    audiomuseNavidromeEnabled,
    artistInfoLoading,
    info?.similarArtist?.length,
  ]);

  useEffect(() => {
    if (!audiomuseNavidromeEnabled) return;
    if ((info?.similarArtist?.length ?? 0) > 0) {
      setSimilarArtists([]);
      setSimilarLoading(false);
    }
  }, [artist?.id, audiomuseNavidromeEnabled, info?.similarArtist?.length]);

  return { similarArtists, similarLoading };
}
