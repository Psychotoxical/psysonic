import { useAuthStore } from '../store/authStore';
import { getArtists } from './subsonicArtists';
import { getAlbumList, getRandomSongs } from './subsonicLibrary';
import type {
  StatisticsFormatSample,
  StatisticsLibraryAggregates,
  StatisticsOverviewData,
  SubsonicAlbum,
  SubsonicArtist,
  SubsonicGenre,
  SubsonicSong,
} from './subsonicTypes';

/** Cache TTL for statistics page aggregates — same 7-minute window as
 *  the rating prefetch cache in subsonicRatings.ts. */
const STATS_CACHE_TTL = 7 * 60 * 1000;

/** Key `prefix:serverId:folder` — Statistics caches share scope with `libraryFilterParams()`. */
function statisticsPageCacheKey(prefix: string): string | null {
  const { activeServerId, musicLibraryFilterByServer } = useAuthStore.getState();
  if (!activeServerId) return null;
  const folder = musicLibraryFilterByServer[activeServerId] ?? 'all';
  const folderPart = folder === 'all' ? 'all' : folder;
  return `${prefix}:${activeServerId}:${folderPart}`;
}

const statisticsAggregatesCache = new Map<string, { value: StatisticsLibraryAggregates; expiresAt: number }>();

/**
 * Walks up to 5000 newest albums (scoped by library filter). Cached per server + music folder for
 * 7 minutes.
 * Unknown/missing album genre is stored as `value: ''`; UI should map to i18n.
 */
export async function fetchStatisticsLibraryAggregates(): Promise<StatisticsLibraryAggregates> {
  const key = statisticsPageCacheKey('statsAgg');
  if (key) {
    const hit = statisticsAggregatesCache.get(key);
    if (hit && Date.now() < hit.expiresAt) return hit.value;
  }

  let playtimeSec = 0;
  let albumsCounted = 0;
  let songsCounted = 0;
  const genreAgg = new Map<string, { songCount: number; albumCount: number }>();
  const pageSize = 500;
  const capped = false;
  let offset = 0;
  let nextPage = getAlbumList('alphabeticalByName', pageSize, 0);
  for (;;) {
    try {
      const albums = await nextPage;
      for (const a of albums) {
        playtimeSec += a.duration ?? 0;
        albumsCounted += 1;
        const sc = a.songCount ?? 0;
        songsCounted += sc;
        const label = (a.genre?.trim()) ? a.genre.trim() : '';
        let g = genreAgg.get(label);
        if (!g) {
          g = { songCount: 0, albumCount: 0 };
          genreAgg.set(label, g);
        }
        g.songCount += sc;
        g.albumCount += 1;
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

export async function fetchStatisticsOverview(): Promise<StatisticsOverviewData> {
  const key = statisticsPageCacheKey('statsOverview');
  if (key) {
    const hit = statisticsOverviewCache.get(key);
    if (hit && Date.now() < hit.expiresAt) return hit.value;
  }
  const [recent, frequent, highest, artists] = await Promise.all([
    getAlbumList('recent', 20).catch(() => [] as SubsonicAlbum[]),
    getAlbumList('frequent', 12).catch(() => [] as SubsonicAlbum[]),
    getAlbumList('highest', 12).catch(() => [] as SubsonicAlbum[]),
    getArtists().catch(() => [] as SubsonicArtist[]),
  ]);
  const result: StatisticsOverviewData = {
    recent,
    frequent,
    highest,
    artistCount: artists.length,
  };
  if (key) {
    statisticsOverviewCache.set(key, { value: result, expiresAt: Date.now() + STATS_CACHE_TTL });
  }
  return result;
}

/** Format (suffix) histogram from a random sample for Statistics. */
const statisticsFormatCache = new Map<string, { value: StatisticsFormatSample; expiresAt: number }>();

export async function fetchStatisticsFormatSample(): Promise<StatisticsFormatSample> {
  const key = statisticsPageCacheKey('statsFormat');
  if (key) {
    const hit = statisticsFormatCache.get(key);
    if (hit && Date.now() < hit.expiresAt) return hit.value;
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
