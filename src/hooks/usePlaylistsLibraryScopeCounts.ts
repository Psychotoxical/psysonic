import { useEffect, useState } from 'react';
import { filterSongsToActiveLibrary } from '../api/subsonicLibrary';
import { getPlaylist } from '../api/subsonicPlaylists';
import type { SubsonicPlaylist } from '../api/subsonicTypes';

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
      const ids = playlists.map((pl) => pl.id);
      const next: Record<string, number> = {};
      const nextDuration: Record<string, number> = {};
      for (let i = 0; i < ids.length; i += 4) {
        const chunk = ids.slice(i, i + 4);
        const rows = await Promise.all(
          chunk.map(async (id) => {
            try {
              const { songs } = await getPlaylist(id);
              const filtered = await filterSongsToActiveLibrary(songs);
              const duration = filtered.reduce((acc, s) => acc + (s.duration ?? 0), 0);
              return [id, filtered.length, duration] as const;
            } catch {
              return [id, -1, -1] as const;
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
  }, [playlists, musicLibraryFilterVersion]);

  return { filteredSongCountByPlaylist, filteredDurationByPlaylist };
}
