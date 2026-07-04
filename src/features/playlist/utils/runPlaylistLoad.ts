import type React from 'react';
import { getPlaylist } from '@/lib/api/subsonicPlaylists';
import { filterSongsToActiveLibrary } from '@/lib/api/subsonicLibrary';
import type { SubsonicPlaylist, SubsonicSong } from '@/lib/api/subsonicTypes';
import { useAuthStore } from '@/store/authStore';
import { usePlaylistStore } from '@/features/playlist/store/playlistStore';
import { usePlaylistMembershipStore } from '@/store/playlistMembershipStore';
import { isOfflineBrowseActive } from '@/features/offline';
import { resolvePlaylist } from '@/features/offline';

export interface RunPlaylistLoadDeps {
  id: string;
  setLoading: (v: boolean) => void;
  setPlaylist: React.Dispatch<React.SetStateAction<SubsonicPlaylist | null>>;
  setSongs: React.Dispatch<React.SetStateAction<SubsonicSong[]>>;
  setCustomCoverId: React.Dispatch<React.SetStateAction<string | null>>;
  setRatings: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  setStarredSongs: React.Dispatch<React.SetStateAction<Set<string>>>;
}

function applyLoadedPlaylist(
  deps: RunPlaylistLoadDeps,
  playlist: SubsonicPlaylist,
  songs: SubsonicSong[],
  // The membership cache must hold the *full* server-side track list, not the
  // library-scope-filtered view — otherwise dedup would treat out-of-scope
  // members as new and re-add them as duplicates. Defaults to the shown songs
  // (offline path, where the resolved list already is the full membership).
  membershipIds: string[] = songs.map(s => s.id),
): void {
  const { setPlaylist, setSongs, setCustomCoverId, setRatings, setStarredSongs } = deps;
  setPlaylist(playlist);
  setSongs(songs);
  if (playlist.coverArt) setCustomCoverId(playlist.coverArt);
  const init: Record<string, number> = {};
  const starred = new Set<string>();
  songs.forEach(s => {
    if (s.userRating) init[s.id] = s.userRating;
    if (s.starred) starred.add(s.id);
  });
  setRatings(init);
  setStarredSongs(starred);
  usePlaylistMembershipStore.getState().setPlaylistSongIds(deps.id, membershipIds);
}

export async function runPlaylistLoad(deps: RunPlaylistLoadDeps): Promise<void> {
  const { id, setLoading, setPlaylist, setSongs } = deps;
  setLoading(true);
  try {
    const serverId = useAuthStore.getState().activeServerId ?? '';
    if (isOfflineBrowseActive() && serverId) {
      const loaded = await resolvePlaylist(serverId, id);
      if (loaded) {
        applyLoadedPlaylist(deps, loaded.playlist, loaded.songs);
        return;
      }
    }

    const { playlist, songs } = await getPlaylist(id);
    const filteredSongs = await filterSongsToActiveLibrary(songs);
    applyLoadedPlaylist(deps, playlist, filteredSongs, songs.map(s => s.id));
  } catch {
    const stub = usePlaylistStore.getState().playlists.find(p => p.id === id);
    if (stub) {
      setPlaylist(stub);
      setSongs([]);
    }
  } finally {
    setLoading(false);
  }
}
