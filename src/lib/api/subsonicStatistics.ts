import { useAuthStore } from '@/store/authStore';
import { genreTagsFor } from '@/lib/library/genreTags';
import { getArtists, getArtistsAcrossLibraries } from '@/lib/api/subsonicArtists';
import { getAlbumList, getRandomSongs } from '@/lib/api/subsonicLibrary';
import { libraryScopeCatalogStatistics, libraryScopeMostPlayedAlbums } from '@/lib/api/library';
import type { LibraryScopePair } from '@/lib/api/library';
import { albumToAlbum } from '@/lib/library/advancedSearchLocal';
import { libraryScopeCacheKeyForServer, librarySelectionForServer } from '@/lib/api/subsonicClient';
import type {
  StatisticsFormatSample,
  StatisticsLibraryAggregates,
  StatisticsOverviewData,
  SubsonicAlbum,
  SubsonicGenre,
  SubsonicSong,
} from '@/lib/api/subsonicTypes';

/** Cache TTL for statistics page aggregates — same 7-minute window as
 *  the rating prefetch cache in subsonicRatings.ts. */
const STATS_CACHE_TTL = 7 * 60 * 1000;

/** Key `prefix:serverId:scope` — Statistics caches share scope with `libraryFilterParams()`. */
export function statisticsPageCacheKey(prefix: string, scopeFingerprint?: string): string | null {
  const { activeServerId } = useAuthStore.getState();
  if (!activeServerId) return null;
  return `${prefix}:${activeServerId}:${scopeFingerprint ?? libraryScopeCacheKeyForServer(activeServerId)}`;
}

const statisticsAggregatesCache = new Map<string, { value: StatisticsLibraryAggregates; expiresAt: number }>();

/**
 * Walks up to 5000 newest albums (scoped by library filter). Cached per server + music folder for
 * 7 minutes.
 * Unknown/missing album genre is stored as `value: ''`; UI should map to i18n.
 */
export async function fetchStatisticsLibraryAggregates(scope?: {
  serverId: string;
  pairs: LibraryScopePair[];
  fingerprint: string;
}): Promise<StatisticsLibraryAggregates> {
  const key = statisticsPageCacheKey('statsAgg', scope?.fingerprint);
  if (key) {
    const hit = statisticsAggregatesCache.get(key);
    if (hit && Date.now() < hit.expiresAt) return hit.value;
  }

  if (scope?.pairs.length) {
    const stats = await libraryScopeCatalogStatistics(scope.serverId, {
      scopes: scope.pairs,
      formatSampleLimit: 500,
    });
    const result: StatisticsLibraryAggregates = {
      playtimeSec: stats.durationSec,
      albumsCounted: stats.albumCount,
      songsCounted: stats.trackCount,
      capped: false,
      genres: stats.genres.map(row => ({
        value: row.value,
        albumCount: row.albumCount,
        songCount: row.songCount,
      })),
    };
    if (key) statisticsAggregatesCache.set(key, { value: result, expiresAt: Date.now() + STATS_CACHE_TTL });
    return result;
  }

  let playtimeSec = 0;
  let albumsCounted = 0;
  let songsCounted = 0;
  const genreAgg = new Map<string, { songCount: number; albumCount: number }>();
  const pageSize = 500;
  const capped = false;
  let offset = 0;
  const activeServerId = useAuthStore.getState().activeServerId;
  const dedupeAlbumIds =
    activeServerId != null && librarySelectionForServer(activeServerId).length > 1;
  const seenAlbumIds = dedupeAlbumIds ? new Set<string>() : null;
  let nextPage = getAlbumList('alphabeticalByName', pageSize, 0);
  for (;;) {
    try {
      const albums = await nextPage;
      for (const a of albums) {
        if (seenAlbumIds) {
          if (seenAlbumIds.has(a.id)) continue;
          seenAlbumIds.add(a.id);
        }
        playtimeSec += a.duration ?? 0;
        albumsCounted += 1;
        const sc = a.songCount ?? 0;
        songsCounted += sc;
        const tags = genreTagsFor(a);
        const labels = tags.length > 0 ? tags : [''];
        for (const label of labels) {
          let g = genreAgg.get(label);
          if (!g) {
            g = { songCount: 0, albumCount: 0 };
            genreAgg.set(label, g);
          }
          g.songCount += sc;
          g.albumCount += 1;
        }
      }
      if (albums.length < pageSize) break;
      offset += pageSize;
      nextPage = getAlbumList('alphabeticalByName', pageSize, offset);
    } catch {
      break;
    }
  }

  const genres: SubsonicGenre[] = [...genreAgg.entries()]
    .map(([value, c]) => ({ value, songCount: c.songCount, albumCount: c.albumCount }))
    .sort((a, b) => b.songCount - a.songCount);

  const result: StatisticsLibraryAggregates = {
    playtimeSec,
    albumsCounted,
    songsCounted,
    capped,
    genres,
  };
  if (key) {
    statisticsAggregatesCache.set(key, { value: result, expiresAt: Date.now() + STATS_CACHE_TTL });
  }
  return result;
}

/** Recent / frequent / highest album strips + artist count for Statistics. */
const statisticsOverviewCache = new Map<string, { value: StatisticsOverviewData; expiresAt: number }>();

export async function fetchStatisticsOverview(scope?: {
  serverId: string;
  pairs: LibraryScopePair[];
  fingerprint: string;
  multiServer: boolean;
}): Promise<StatisticsOverviewData> {
  const key = statisticsPageCacheKey('statsOverview', scope?.fingerprint);
  if (key) {
    const hit = statisticsOverviewCache.get(key);
    if (hit && Date.now() < hit.expiresAt) return hit.value;
  }
  if (scope?.pairs.length) {
    const [frequentRows, stats] = await Promise.all([
      libraryScopeMostPlayedAlbums(scope.serverId, { scopes: scope.pairs, limit: 12 }),
      libraryScopeCatalogStatistics(scope.serverId, { scopes: scope.pairs, formatSampleLimit: 1 }),
    ]);
    const result: StatisticsOverviewData = {
      recent: [],
      frequent: frequentRows.map(row => ({ ...albumToAlbum(row.album), playCount: row.playCount })),
      highest: scope.multiServer ? [] : await getAlbumList('highest', 12).catch(() => []),
      artistCount: stats.artistCount,
    };
    if (key) statisticsOverviewCache.set(key, { value: result, expiresAt: Date.now() + STATS_CACHE_TTL });
    return result;
  }
  const [recent, frequent, highest, artists] = await Promise.all([
    getAlbumList('recent', 20).catch(() => [] as SubsonicAlbum[]),
    getAlbumList('frequent', 12).catch(() => [] as SubsonicAlbum[]),
    getAlbumList('highest', 12).catch(() => [] as SubsonicAlbum[]),
    fetchStatisticsArtistCount().catch(() => 0),
  ]);
  const result: StatisticsOverviewData = {
    recent,
    frequent,
    highest,
    artistCount: artists,
  };
  if (key) {
    statisticsOverviewCache.set(key, { value: result, expiresAt: Date.now() + STATS_CACHE_TTL });
  }
  return result;
}

async function fetchStatisticsArtistCount(): Promise<number> {
  const { activeServerId } = useAuthStore.getState();
  if (!activeServerId) return 0;
  const selection = librarySelectionForServer(activeServerId);
  if (selection.length <= 1) {
    return (await getArtists()).length;
  }
  return (await getArtistsAcrossLibraries(selection)).length;
}

/** Format (suffix) histogram from a random sample for Statistics. */
const statisticsFormatCache = new Map<string, { value: StatisticsFormatSample; expiresAt: number }>();

export async function fetchStatisticsFormatSample(scope?: {
  serverId: string;
  pairs: LibraryScopePair[];
  fingerprint: string;
}): Promise<StatisticsFormatSample> {
  const key = statisticsPageCacheKey('statsFormat', scope?.fingerprint);
  if (key) {
    const hit = statisticsFormatCache.get(key);
    if (hit && Date.now() < hit.expiresAt) return hit.value;
  }
  if (scope?.pairs.length) {
    const stats = await libraryScopeCatalogStatistics(scope.serverId, {
      scopes: scope.pairs,
      formatSampleLimit: 500,
    });
    const result = { rows: stats.formats, sampleSize: stats.formatSampleSize };
    if (key) statisticsFormatCache.set(key, { value: result, expiresAt: Date.now() + STATS_CACHE_TTL });
    return result;
  }
  const songs = await getRandomSongs(500).catch(() => [] as SubsonicSong[]);
  const counts: Record<string, number> = {};
  for (const song of songs) {
    const fmt = song.suffix?.toUpperCase() ?? 'Unknown';
    counts[fmt] = (counts[fmt] ?? 0) + 1;
  }
  const rows = Object.entries(counts)
    .map(([format, count]) => ({ format, count }))
    .sort((a, b) => b.count - a.count);
  const result: StatisticsFormatSample = { rows, sampleSize: songs.length };
  if (key) {
    statisticsFormatCache.set(key, { value: result, expiresAt: Date.now() + STATS_CACHE_TTL });
  }
  return result;
}
