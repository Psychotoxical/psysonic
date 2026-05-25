import type { SubsonicAlbum, SubsonicArtist, SubsonicSong } from '../api/subsonicTypes';

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

export function writeHomeFeedCache(data: Omit<HomeFeedSnapshot, 'savedAt'>): void {
  snapshot = { ...data, savedAt: Date.now() };
}

export function clearHomeFeedCache(): void {
  snapshot = null;
}
