import { create } from 'zustand';

/**
 * In-memory playlist song-id membership cache, keyed by `serverId:playlistId`.
 *
 * Lives in the core store layer (not the playlist feature) so `offline`, `orbit`,
 * `contextMenu` and `playlist` can all read/write it directly without a cross-feature
 * barrel dependency — the membership cache is the one piece those features genuinely
 * share, and routing it through `@/features/playlist` created import cycles.
 *
 * Not persisted: playlist membership must reflect the live server, so it is rebuilt
 * from `getPlaylist`/`runPlaylistLoad` on demand and dropped on `fetchPlaylists`.
 */
interface PlaylistMembershipStore {
  /** Song-id lists keyed by `serverId:playlistId`. */
  songIdsByCacheKey: Record<string, readonly string[]>;
  getPlaylistSongIds: (playlistId: string, serverId?: string) => readonly string[] | undefined;
  setPlaylistSongIds: (playlistId: string, songIds: readonly string[], serverId?: string) => void;
  appendPlaylistSongIds: (playlistId: string, songIds: readonly string[], serverId?: string) => void;
  replacePlaylistSongIds: (playlistId: string, songIds: readonly string[], serverId?: string) => void;
  removePlaylistSongIdsAtIndices: (playlistId: string, indices: readonly number[], serverId?: string) => void;
  invalidatePlaylistSongIds: (playlistId: string, serverId?: string) => void;
  clearAllPlaylistSongIds: () => void;
}

/** Playlist ids are server-local; callers on merged surfaces pass the explicit owner. */
function cacheKey(playlistId: string, serverId = ''): string {
  return `${serverId}:${playlistId}`;
}

export const usePlaylistMembershipStore = create<PlaylistMembershipStore>()((set, get) => ({
  songIdsByCacheKey: {},
  getPlaylistSongIds: (playlistId, serverId) => get().songIdsByCacheKey[cacheKey(playlistId, serverId)],
  setPlaylistSongIds: (playlistId, songIds, serverId) =>
    set((s) => ({
      songIdsByCacheKey: { ...s.songIdsByCacheKey, [cacheKey(playlistId, serverId)]: [...songIds] },
    })),
  appendPlaylistSongIds: (playlistId, songIds, serverId) => {
    if (songIds.length === 0) return;
    set((s) => {
      const key = cacheKey(playlistId, serverId);
      const prev = s.songIdsByCacheKey[key] ?? [];
      return { songIdsByCacheKey: { ...s.songIdsByCacheKey, [key]: [...prev, ...songIds] } };
    });
  },
  replacePlaylistSongIds: (playlistId, songIds, serverId) => get().setPlaylistSongIds(playlistId, songIds, serverId),
  removePlaylistSongIdsAtIndices: (playlistId, indices, serverId) => {
    if (indices.length === 0) return;
    set((s) => {
      const key = cacheKey(playlistId, serverId);
      const prev = s.songIdsByCacheKey[key];
      if (!prev) return s;
      const remove = new Set(indices);
      return {
        songIdsByCacheKey: { ...s.songIdsByCacheKey, [key]: prev.filter((_, i) => !remove.has(i)) },
      };
    });
  },
  invalidatePlaylistSongIds: (playlistId, serverId) =>
    set((s) => {
      const key = cacheKey(playlistId, serverId);
      if (!(key in s.songIdsByCacheKey)) return s;
      const { [key]: _removed, ...rest } = s.songIdsByCacheKey;
      return { songIdsByCacheKey: rest };
    }),
  clearAllPlaylistSongIds: () => set({ songIdsByCacheKey: {} }),
}));
