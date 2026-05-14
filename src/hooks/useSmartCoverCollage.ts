import { useEffect, useState } from 'react';
import { filterSongsToActiveLibrary } from '../api/subsonicLibrary';
import { getPlaylist } from '../api/subsonicPlaylists';
import type { SubsonicPlaylist } from '../api/subsonicTypes';
import { isSmartPlaylistName } from '../utils/playlist/playlistsSmart';

/**
 * Build the 2×2 cover collage for each smart playlist. Pulls each smart
 * playlist's tracks (filtered to the active library scope) and collects up
 * to four unique cover-art IDs. Re-runs when the playlist list changes or
 * when the active library filter version bumps.
 */
export function useSmartCoverCollage(
  playlists: SubsonicPlaylist[],
  musicLibraryFilterVersion: number,
): Record<string, string[]> {
  const [smartCoverIdsByPlaylist, setSmartCoverIdsByPlaylist] = useState<Record<string, string[]>>({});

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const smart = playlists.filter(pl => isSmartPlaylistName(pl.name));
      if (smart.length === 0) {
        if (!cancelled) setSmartCoverIdsByPlaylist({});
        return;
      }
      const rows = await Promise.all(
        smart.map(async (pl) => {
          try {
            const { songs } = await getPlaylist(pl.id);
            const filtered = await filterSongsToActiveLibrary(songs);
            const ids: string[] = [];
            const seen = new Set<string>();
            for (const s of filtered) {
              const cid = s.coverArt;
              if (!cid || seen.has(cid)) continue;
              seen.add(cid);
              ids.push(cid);
              if (ids.length >= 4) break;
            }
            return [pl.id, ids] as const;
          } catch {
            return [pl.id, [] as string[]] as const;
          }
        }),
      );
      if (cancelled) return;
      const next: Record<string, string[]> = {};
      for (const [id, ids] of rows) next[id] = ids;
      setSmartCoverIdsByPlaylist(next);
    };
    run();
    return () => { cancelled = true; };
  }, [playlists, musicLibraryFilterVersion]);

  return smartCoverIdsByPlaylist;
}
