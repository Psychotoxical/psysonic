import type React from 'react';
import { getPlaylistForServer } from '@/lib/api/subsonicPlaylists';
import { filterSongsToServerLibrary } from '@/lib/api/subsonicLibrary';
import type { SubsonicPlaylist, SubsonicSong } from '@/lib/api/subsonicTypes';
import { usePlaylistStore } from '@/features/playlist/store/playlistStore';
import { usePlaylistMembershipStore } from '@/store/playlistMembershipStore';
import { isOfflineBrowseActive } from '@/features/offline';
import { resolvePlaylist } from '@/features/offline';

export interface RunPlaylistLoadDeps {
  id: string;
  ownerServerId: string;
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
  usePlaylistMembershipStore.getState().setPlaylistSongIds(deps.id, membershipIds, deps.ownerServerId);
}

export async function runPlaylistLoad(deps: RunPlaylistLoadDeps): Promise<void> {
  const { id, ownerServerId, setLoading, setPlaylist, setSongs } = deps;
  setLoading(true);
  try {
    if (isOfflineBrowseActive()) {
      const loaded = await resolvePlaylist(ownerServerId, id);
      if (loaded) {
        applyLoadedPlaylist(deps, loaded.playlist, loaded.songs);
        return;
      }
    }

    const { playlist, songs } = await getPlaylistForServer(ownerServerId, id);
    const filteredSongs = await filterSongsToServerLibrary(songs, ownerServerId);
    applyLoadedPlaylist(deps, playlist, filteredSongs, songs.map(s => s.id));
  } catch {
    const stub = usePlaylistStore.getState().playlists.find(
      p => p.id === id && (p.serverId ?? ownerServerId) === ownerServerId,
    );
    if (stub) {
      setPlaylist(stub);
      setSongs([]);
    }
  } finally {
    setLoading(false);
  }
}
