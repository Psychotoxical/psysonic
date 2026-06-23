import type React from 'react';
import { getPlaylist } from '../../api/subsonicPlaylists';
import { filterSongsToActiveLibrary } from '../../api/subsonicLibrary';
import type { SubsonicPlaylist, SubsonicSong } from '../../api/subsonicTypes';
import { useAuthStore } from '../../store/authStore';
import { usePlaylistStore } from '../../store/playlistStore';
import { isOfflineBrowseActive } from '../offline/offlineBrowseMode';
import { resolvePlaylist } from '../offline/offlineMediaResolve';

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
    applyLoadedPlaylist(deps, playlist, filteredSongs);
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
