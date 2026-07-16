import { getArtists } from '@/lib/api/subsonicArtists';
import { getAlbumList, getRandomSongs } from '@/lib/api/subsonicLibrary';
import {
  libraryAdvancedSearch,
  libraryScopeListArtists,
  libraryScopeMostPlayedAlbums,
  type LibraryScopePair,
} from '@/lib/api/library';
import type { SubsonicAlbum, SubsonicArtist, SubsonicSong } from '@/lib/api/subsonicTypes';
import { albumToAlbum, artistToArtist } from '@/lib/library/advancedSearchLocal';
import { runLocalRandomAlbums } from '@/lib/library/browseTextSearch';
import { runLocalRandomSongs } from '@/lib/library/randomScopeReads';
import { dedupeById } from '@/lib/util/dedupeById';
import { shuffleArray } from '@/lib/util/shuffleArray';
import { filterAlbumsByMixRatings, getMixMinRatingsConfigFromAuth } from '@/features/playback';
import type { HomeFeedSnapshot } from '@/features/home/store/homeFeedCache';

const HOME_RANDOM_FETCH = 100;
const HOME_HERO_COUNT = 8;
const HOME_DISCOVER_SLICE = 20;
const HOME_DISCOVER_SONGS_SIZE = 18;

export type HomeAlbumListType = 'starred' | 'newest' | 'random' | 'frequent' | 'recent';

export interface HomeFeedScope {
  activeServerId: string;
  browseServerId: string;
  pairs: LibraryScopePair[];
  fingerprint: string;
  multiServer: boolean;
  filterVersion: number;
}

interface HomeFeedVisibility {
  discoverArtists: boolean;
  discoverSongs: boolean;
}

function withServerId<T extends { serverId?: string | null }>(items: T[], serverId: string): T[] {
  return items.map(item => item.serverId ? item : { ...item, serverId });
}

async function loadScopedAlbums(
  scope: HomeFeedScope,
  type: HomeAlbumListType,
  limit: number,
  offset = 0,
): Promise<SubsonicAlbum[]> {
  if (!scope.multiServer) {
    return withServerId(await getAlbumList(type, limit, offset).catch(() => []), scope.activeServerId);
  }
  if (!scope.browseServerId || scope.pairs.length === 0) return [];

  if (type === 'frequent') {
    return libraryScopeMostPlayedAlbums(scope.browseServerId, {
      scopes: scope.pairs,
      limit,
      offset,
    }).then(rows => rows.map(row => ({
      ...albumToAlbum(row.album),
      playCount: row.playCount,
    }))).catch(() => []);
  }

  if (type === 'random') {
    return (await runLocalRandomAlbums(scope.browseServerId, limit, scope.pairs)) ?? [];
  }

  if (type === 'newest') {
    return libraryAdvancedSearch({
      serverId: scope.browseServerId,
      libraryScopes: scope.pairs,
      entityTypes: ['album'],
      sort: [
        { field: 'synced', dir: 'desc' },
        { field: 'year', dir: 'desc' },
        { field: 'name', dir: 'asc' },
      ],
      limit,
      offset,
      skipTotals: true,
    }).then(response => response.albums.map(albumToAlbum)).catch(() => []);
  }

  if (type === 'starred') {
    return libraryAdvancedSearch({
      serverId: scope.browseServerId,
      libraryScopes: scope.pairs,
      entityTypes: ['album'],
      filters: [{ field: 'starred', op: 'is_true' }],
      sort: [
        { field: 'name', dir: 'asc' },
        { field: 'artist', dir: 'asc' },
      ],
      limit,
      offset,
      skipTotals: true,
    }).then(response => response.albums.map(albumToAlbum)).catch(() => []);
  }

  // There is no merged album-level recently-played reader in the local index yet.
  return [];
}

async function loadScopedArtists(scope: HomeFeedScope): Promise<SubsonicArtist[]> {
  if (!scope.multiServer) {
    return withServerId(await getArtists().catch(() => []), scope.activeServerId);
  }
  if (!scope.browseServerId || scope.pairs.length === 0) return [];
  return libraryScopeListArtists(scope.browseServerId, {
    scopes: scope.pairs,
    sort: 'name',
    limit: 500,
  }).then(rows => rows.map(artistToArtist)).catch(() => []);
}

async function loadScopedRandomSongs(scope: HomeFeedScope): Promise<SubsonicSong[]> {
  const local = await runLocalRandomSongs(
    scope.browseServerId || scope.activeServerId,
    HOME_DISCOVER_SONGS_SIZE,
    undefined,
    scope.pairs,
  ).catch(() => null);
  if (local) return local;
  if (scope.multiServer) return [];
  return withServerId(
    await getRandomSongs(HOME_DISCOVER_SONGS_SIZE).catch(() => [] as SubsonicSong[]),
    scope.activeServerId,
  );
}

export async function loadHomeAlbumPage(
  scope: HomeFeedScope,
  type: HomeAlbumListType,
  offset: number,
  limit = 12,
): Promise<SubsonicAlbum[]> {
  const raw = await loadScopedAlbums(scope, type, limit, offset);
  if (type !== 'random' || scope.multiServer) return dedupeById(raw);
  return dedupeById(await filterAlbumsByMixRatings(raw, getMixMinRatingsConfigFromAuth()));
}

export function appendHomeAlbumPage(
  current: SubsonicAlbum[],
  batch: SubsonicAlbum[],
  requestedFingerprint: string,
  currentFingerprint: string,
): SubsonicAlbum[] {
  if (requestedFingerprint !== currentFingerprint) return current;
  return dedupeById([...current, ...batch]);
}

export async function loadHomeFeed(
  scope: HomeFeedScope,
  visibility: HomeFeedVisibility,
): Promise<HomeFeedSnapshot> {
  const mixCfg = getMixMinRatingsConfigFromAuth();
  const albumMix = mixCfg.enabled && (mixCfg.minAlbum > 0 || mixCfg.minArtist > 0);
  const randomSize = albumMix ? HOME_RANDOM_FETCH : HOME_DISCOVER_SLICE;
  const [starred, newest, randomRaw, frequent, recent, artists, songs] = await Promise.all([
    loadScopedAlbums(scope, 'starred', 12),
    loadScopedAlbums(scope, 'newest', 12),
    loadScopedAlbums(scope, 'random', randomSize),
    loadScopedAlbums(scope, 'frequent', 12),
    loadScopedAlbums(scope, 'recent', 12),
    visibility.discoverArtists ? loadScopedArtists(scope) : Promise.resolve<SubsonicArtist[]>([]),
    visibility.discoverSongs ? loadScopedRandomSongs(scope) : Promise.resolve<SubsonicSong[]>([]),
  ]);
  const random = dedupeById(scope.multiServer
    ? randomRaw
    : await filterAlbumsByMixRatings(randomRaw, mixCfg));
  return {
    scopeFingerprint: scope.fingerprint,
    filterVersion: scope.filterVersion,
    savedAt: Date.now(),
    starred: dedupeById(starred),
    recent: dedupeById(newest),
    heroAlbums: random.slice(0, HOME_HERO_COUNT),
    random: random.slice(HOME_HERO_COUNT, HOME_DISCOVER_SLICE),
    mostPlayed: dedupeById(frequent),
    recentlyPlayed: dedupeById(recent),
    discoverSongs: dedupeById(songs),
    randomArtists: dedupeById(shuffleArray(artists)).slice(0, 16),
  };
}
