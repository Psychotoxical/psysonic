import { useEffect, useState } from 'react';
import { filterSongsToServerLibrary } from '@/lib/api/subsonicLibrary';
import { getPlaylistForServer } from '@/lib/api/subsonicPlaylists';
import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';
import { useOfflineBrowseContext } from '@/features/offline';
import { libraryEntityKey } from '@/lib/library/libraryEntityKey';

export interface PlaylistsLibraryScopeCountsResult {
  filteredSongCountByPlaylist: Record<string, number>;
  filteredDurationByPlaylist: Record<string, number>;
}

/**
 * Recompute song count + total duration for each playlist under the current
 * library scope. Chunked into batches of 4 parallel fetches to avoid hammering
 * Navidrome on large playlists. Re-runs when the playlist list changes or
 * when the active library filter version bumps.
 */
export function usePlaylistsLibraryScopeCounts(
  playlists: SubsonicPlaylist[],
  musicLibraryFilterVersion: number,
): PlaylistsLibraryScopeCountsResult {
  const [filteredSongCountByPlaylist, setFilteredSongCountByPlaylist] = useState<Record<string, number>>({});
  const [filteredDurationByPlaylist, setFilteredDurationByPlaylist] = useState<Record<string, number>>({});
  const offlineBrowseActive = useOfflineBrowseContext().active;

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (playlists.length === 0) {
        if (!cancelled) {
          setFilteredSongCountByPlaylist({});
          setFilteredDurationByPlaylist({});
        }
        return;
      }
      if (offlineBrowseActive) {
        const next: Record<string, number> = {};
        const nextDuration: Record<string, number> = {};
        for (const pl of playlists) {
          const key = libraryEntityKey(pl);
          next[key] = pl.songCount;
          nextDuration[key] = pl.duration;
        }
        if (!cancelled) {
          setFilteredSongCountByPlaylist(next);
          setFilteredDurationByPlaylist(nextDuration);
        }
        return;
      }
      const next: Record<string, number> = {};
      const nextDuration: Record<string, number> = {};
      for (let i = 0; i < playlists.length; i += 4) {
        const chunk = playlists.slice(i, i + 4);
        const rows = await Promise.all(
          chunk.map(async (playlist) => {
            const key = libraryEntityKey(playlist);
            try {
              if (!playlist.serverId) throw new Error('Playlist owner unavailable');
              const { songs } = await getPlaylistForServer(playlist.serverId, playlist.id);
              const filtered = await filterSongsToServerLibrary(songs, playlist.serverId);
              const duration = filtered.reduce((acc, s) => acc + (s.duration ?? 0), 0);
              return [key, filtered.length, duration] as const;
            } catch {
              return [key, -1, -1] as const;
            }
          }),
        );
        for (const [id, count, duration] of rows) {
          if (count >= 0) next[id] = count;
          if (duration >= 0) nextDuration[id] = duration;
        }
      }
      if (!cancelled) {
        setFilteredSongCountByPlaylist(next);
        setFilteredDurationByPlaylist(nextDuration);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [playlists, musicLibraryFilterVersion, offlineBrowseActive]);

  return { filteredSongCountByPlaylist, filteredDurationByPlaylist };
}
