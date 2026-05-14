import type React from 'react';
import { getPlaylist } from '../../api/subsonicPlaylists';
import { filterSongsToActiveLibrary } from '../../api/subsonicLibrary';
import type { SubsonicPlaylist, SubsonicSong } from '../../api/subsonicTypes';

export interface RunPlaylistLoadDeps {
  id: string;
  setLoading: (v: boolean) => void;
  setPlaylist: React.Dispatch<React.SetStateAction<SubsonicPlaylist | null>>;
  setSongs: React.Dispatch<React.SetStateAction<SubsonicSong[]>>;
  setCustomCoverId: React.Dispatch<React.SetStateAction<string | null>>;
  setRatings: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  setStarredSongs: React.Dispatch<React.SetStateAction<Set<string>>>;
}

export async function runPlaylistLoad(deps: RunPlaylistLoadDeps): Promise<void> {
  const { id, setLoading, setPlaylist, setSongs, setCustomCoverId, setRatings, setStarredSongs } = deps;
  setLoading(true);
  try {
    const { playlist, songs } = await getPlaylist(id);
    const filteredSongs = await filterSongsToActiveLibrary(songs);
    setPlaylist(playlist);
    setSongs(filteredSongs);
    if (playlist.coverArt) setCustomCoverId(playlist.coverArt);
    const init: Record<string, number> = {};
    const starred = new Set<string>();
    filteredSongs.forEach(s => {
      if (s.userRating) init[s.id] = s.userRating;
      if (s.starred) starred.add(s.id);
    });
    setRatings(init);
    setStarredSongs(starred);
  } catch {
    // intentional swallow; load failure leaves loading false + playlist null
  } finally {
    setLoading(false);
  }
}
