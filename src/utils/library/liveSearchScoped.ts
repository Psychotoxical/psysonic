import type { SearchResults, SubsonicArtist } from '../../api/subsonicTypes';
import {
  browseRaceCountsArtists,
  raceBrowseWithLocalFallback,
  runLocalBrowseArtists,
  runNetworkBrowseArtists,
} from './browseTextSearch';
import type { SearchRaceWinner } from './searchRace';

function artistsToSearchResults(artists: SubsonicArtist[]): SearchResults {
  return { artists, albums: [], songs: [] };
}

/** Artists browse search — same local/network race as the Artists page toolbar had. */
export async function runArtistsScopedLiveSearch(
  serverId: string | null | undefined,
  query: string,
  indexEnabled: boolean,
  isStale: () => boolean,
): Promise<SearchRaceWinner<SearchResults> | null> {
  const q = query.trim();
  if (!q) return null;

  if (indexEnabled && serverId) {
    const winner = await raceBrowseWithLocalFallback(
      isStale,
      () => runLocalBrowseArtists(serverId, q),
      () => runNetworkBrowseArtists(q),
      {
        surface: 'artists_browse',
        query: q,
        indexEnabled,
        counts: browseRaceCountsArtists,
      },
    );
    if (!winner || isStale()) return null;
    return {
      source: winner.source,
      result: artistsToSearchResults(winner.result),
      durationMs: winner.durationMs,
    };
  }

  const artists = await runNetworkBrowseArtists(q);
  if (isStale() || !artists) return null;
  return {
    source: 'network',
    result: artistsToSearchResults(artists),
    durationMs: 0,
  };
}
