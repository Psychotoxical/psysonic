import type React from 'react';
import { getPlaylist, getPlaylistForServer } from '@/lib/api/subsonicPlaylists';
import { filterSongsToServerLibrary } from '@/lib/api/subsonicLibrary';
import type { SubsonicPlaylist, SubsonicSong } from '@/lib/api/subsonicTypes';
import { useAuthStore } from '@/store/authStore';
import { usePlaylistStore } from '@/features/playlist/store/playlistStore';
import { usePlaylistMembershipStore } from '@/store/playlistMembershipStore';
import { isOfflineBrowseActive } from '@/features/offline';
import { resolvePlaylist } from '@/features/offline';
import { ownedEntityKey } from '@/lib/util/ownedEntityKey';

export interface RunPlaylistLoadDeps {
  id: string;
  serverId?: string;
  setLoading: (v: boolean) => void;
  setPlaylist: React.Dispatch<React.SetStateAction<SubsonicPlaylist | null>>;
  setSongs: React.Dispatch<React.SetStateAction<SubsonicSong[]>>;
  setCustomCoverId: React.Dispatch<React.SetStateAction<string | null>>;
  setRatings: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  setStarredSongs: React.Dispatch<React.SetStateAction<Set<string>>>;
  resetForOwnerChange?: () => void;
  isCurrent?: () => boolean;
  /** Keep the current UI mounted; skip the full-page spinner and owner reset. */
  soft?: boolean;
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
  membershipRevision?: number,
): void {
  if (deps.isCurrent && !deps.isCurrent()) return;
  const { setPlaylist, setSongs, setCustomCoverId, setRatings, setStarredSongs } = deps;
  const cached = usePlaylistStore.getState().playlists.find(candidate =>
    ownedEntityKey(candidate) === ownedEntityKey({ id: playlist.id, serverId: deps.serverId ?? playlist.serverId }),
  );
  const classifiedPlaylist = playlist.smart === undefined && cached?.smart !== undefined
    ? { ...playlist, smart: cached.smart }
    : playlist;
  const ownedPlaylist = deps.serverId
    ? { ...classifiedPlaylist, serverId: deps.serverId }
    : classifiedPlaylist;
  const ownedSongs = deps.serverId ? songs.map(song => ({ ...song, serverId: deps.serverId })) : songs;
  setPlaylist(ownedPlaylist);
  setSongs(ownedSongs);
  setCustomCoverId(playlist.coverArt ?? null);
  const init: Record<string, number> = {};
  const starred = new Set<string>();
  ownedSongs.forEach(s => {
    if (s.userRating) init[s.id] = s.userRating;
    if (s.starred) starred.add(s.id);
  });
  setRatings(init);
  setStarredSongs(starred);
  const membership = usePlaylistMembershipStore.getState();
  if (
    membershipRevision !== undefined
    && membership.revision === membershipRevision
    && membership.getPlaylistSongIds(deps.id, deps.serverId) === undefined
  ) {
    membership.setPlaylistSongIds(deps.id, membershipIds, deps.serverId);
  }
}

export async function runPlaylistLoad(deps: RunPlaylistLoadDeps): Promise<void> {
  const {
    id, setLoading, setPlaylist, setSongs, setCustomCoverId, setRatings, setStarredSongs,
  } = deps;
  if (!deps.soft && deps.resetForOwnerChange && (!deps.isCurrent || deps.isCurrent())) {
    setPlaylist(null);
    setSongs([]);
    setCustomCoverId(null);
    setRatings({});
    setStarredSongs(new Set());
    deps.resetForOwnerChange();
  }
  if (!deps.soft) setLoading(true);
  const membershipRevision = usePlaylistMembershipStore.getState().revision;
  try {
    const serverId = deps.serverId ?? useAuthStore.getState().activeServerId ?? '';
    if (isOfflineBrowseActive() && serverId) {
      const loaded = await resolvePlaylist(serverId, id);
      if (loaded) {
        applyLoadedPlaylist(deps, loaded.playlist, loaded.songs, undefined, membershipRevision);
        return;
      }
    }

    const { playlist, songs } = serverId
      ? await getPlaylistForServer(serverId, id)
      : await getPlaylist(id);
    const filteredSongs = serverId ? await filterSongsToServerLibrary(songs, serverId) : songs;
    applyLoadedPlaylist(
      deps,
      { ...playlist, serverId: serverId || undefined },
      filteredSongs,
      songs.map(s => s.id),
      membershipRevision,
    );
  } catch {
    const key = ownedEntityKey({ id, serverId: deps.serverId });
    const stub = usePlaylistStore.getState().playlists.find(p => ownedEntityKey(p) === key);
    if (stub && (!deps.isCurrent || deps.isCurrent())) {
      setPlaylist(stub);
      setSongs([]);
    }
  } finally {
    if (!deps.soft && (!deps.isCurrent || deps.isCurrent())) setLoading(false);
  }
}
