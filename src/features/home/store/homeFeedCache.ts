import type { SubsonicAlbum, SubsonicArtist, SubsonicSong } from '@/lib/api/subsonicTypes';

/** Session cache so leaving Mainstage and returning does not refetch + reshuffle everything. */
export type HomeFeedSnapshot = {
  serverId: string;
  filterVersion: number;
  savedAt: number;
  starred: SubsonicAlbum[];
  recent: SubsonicAlbum[];
  random: SubsonicAlbum[];
  heroAlbums: SubsonicAlbum[];
  mostPlayed: SubsonicAlbum[];
  recentlyPlayed: SubsonicAlbum[];
  randomArtists: SubsonicArtist[];
  discoverSongs: SubsonicSong[];
};

const TTL_MS = 15 * 60 * 1000;
let snapshot: HomeFeedSnapshot | null = null;

export function readHomeFeedCache(
  serverId: string | null | undefined,
  filterVersion: number,
): HomeFeedSnapshot | null {
  if (!serverId || !snapshot) return null;
  if (snapshot.serverId !== serverId || snapshot.filterVersion !== filterVersion) return null;
  if (Date.now() - snapshot.savedAt > TTL_MS) return null;
  return snapshot;
}

/** Last good snapshot for this server when filter version changed (e.g. offline filter suspend). */
export function readHomeFeedCacheStale(
  serverId: string | null | undefined,
): HomeFeedSnapshot | null {
  if (!serverId || !snapshot) return null;
  if (snapshot.serverId !== serverId) return null;
  if (Date.now() - snapshot.savedAt > TTL_MS) return null;
  return snapshot;
}

export function isHomeFeedSnapshotEmpty(snap: HomeFeedSnapshot): boolean {
  return snap.heroAlbums.length === 0
    && snap.recent.length === 0
    && snap.random.length === 0
    && snap.starred.length === 0
    && snap.mostPlayed.length === 0
    && snap.recentlyPlayed.length === 0
    && snap.discoverSongs.length === 0
    && snap.randomArtists.length === 0;
}

export function writeHomeFeedCache(data: Omit<HomeFeedSnapshot, 'savedAt'>): void {
  snapshot = { ...data, savedAt: Date.now() };
}

export function clearHomeFeedCache(): void {
  snapshot = null;
}
