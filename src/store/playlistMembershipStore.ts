import { create } from 'zustand';
import { useAuthStore } from '@/store/authStore';

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
  getPlaylistSongIds: (playlistId: string) => readonly string[] | undefined;
  setPlaylistSongIds: (playlistId: string, songIds: readonly string[]) => void;
  appendPlaylistSongIds: (playlistId: string, songIds: readonly string[]) => void;
  replacePlaylistSongIds: (playlistId: string, songIds: readonly string[]) => void;
  removePlaylistSongIdsAtIndices: (playlistId: string, indices: readonly number[]) => void;
  invalidatePlaylistSongIds: (playlistId: string) => void;
  clearAllPlaylistSongIds: () => void;
}

/** Scope membership to the active server — playlist ids are not globally unique. */
function cacheKey(playlistId: string): string {
  const serverId = useAuthStore.getState().activeServerId ?? '';
  return `${serverId}:${playlistId}`;
}

export const usePlaylistMembershipStore = create<PlaylistMembershipStore>()((set, get) => ({
  songIdsByCacheKey: {},
  getPlaylistSongIds: (playlistId) => get().songIdsByCacheKey[cacheKey(playlistId)],
  setPlaylistSongIds: (playlistId, songIds) =>
    set((s) => ({
      songIdsByCacheKey: { ...s.songIdsByCacheKey, [cacheKey(playlistId)]: [...songIds] },
    })),
  appendPlaylistSongIds: (playlistId, songIds) => {
    if (songIds.length === 0) return;
    set((s) => {
      const key = cacheKey(playlistId);
      const prev = s.songIdsByCacheKey[key] ?? [];
      return { songIdsByCacheKey: { ...s.songIdsByCacheKey, [key]: [...prev, ...songIds] } };
    });
  },
  replacePlaylistSongIds: (playlistId, songIds) => get().setPlaylistSongIds(playlistId, songIds),
  removePlaylistSongIdsAtIndices: (playlistId, indices) => {
    if (indices.length === 0) return;
    set((s) => {
      const key = cacheKey(playlistId);
      const prev = s.songIdsByCacheKey[key];
      if (!prev) return s;
      const remove = new Set(indices);
      return {
        songIdsByCacheKey: { ...s.songIdsByCacheKey, [key]: prev.filter((_, i) => !remove.has(i)) },
      };
    });
  },
  invalidatePlaylistSongIds: (playlistId) =>
    set((s) => {
      const key = cacheKey(playlistId);
      if (!(key in s.songIdsByCacheKey)) return s;
      const { [key]: _removed, ...rest } = s.songIdsByCacheKey;
      return { songIdsByCacheKey: rest };
    }),
  clearAllPlaylistSongIds: () => set({ songIdsByCacheKey: {} }),
}));
